import { homedir } from 'node:os';
import type { LoadedConfig } from '@aivi/core';
import type { OpenCodeClient } from '../opencode.ts';
import type { ConversationStore } from './store.ts';

const n = (value: number) => value.toLocaleString('en');
const BAR = 24;
const bar = (share: number) => {
  const filled = Math.max(0, Math.min(BAR, Math.round(share * BAR)));
  return '█'.repeat(filled) + '░'.repeat(BAR - filled);
};
const home = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

const scopeLine = (loaded: LoadedConfig) => {
  const projects = loaded.projects.filter(p => !p.removed).map(p => p.id);
  const core = loaded.sources.filter(s => s.scope === 'core').length;
  return `**Knowledge in scope** ${core} core source${core === 1 ? '' : 's'}${projects.length ? ` · projects: ${projects.join(', ')}` : ' · no projects'}`;
};

/**
 * What a conversation's session knows, for a `/context` command: `describeSession`
 * plus what aivi adds, its binding and its queue. Before the first message it says
 * what the first one would start.
 */
export async function describeConversation(
  store: ConversationStore,
  channel: string,
  config: { agent: string; directory: string },
  loaded: LoadedConfig,
  opencode: () => Promise<OpenCodeClient>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> {
  const binding = store.sessionOf(channel);
  const pending = store.list(channel).filter(t => !['sent', 'discarded'].includes(t.state));
  const queue = pending.length
    ? `${pending.length} pending turn${pending.length === 1 ? '' : 's'} here: ${pending.map(t => t.state).join(', ')}.`
    : 'Nothing pending here.';
  if (!binding?.ready)
    return [
      `🧠 **Context** · no session yet`,
      `The next message starts one with agent \`${binding?.agent ?? config.agent}\` in \`${home(binding?.directory ?? config.directory)}\`.`,
      '',
      scopeLine(loaded),
      queue,
    ].join('\n');
  return `${await describeSession(await opencode(), binding.session, loaded, signal)}\n${queue}`;
}

type WireContext = Awaited<ReturnType<OpenCodeClient['session']['context']>>;
type WireMessage = WireContext[number];
type WireAssistant = Extract<WireMessage, { type: 'assistant' }>;
type WireTokens = NonNullable<WireAssistant['tokens']>;
type WirePlugin = Awaited<ReturnType<OpenCodeClient['plugin']['list']>>['data'][number];
/** The window lines: the last call's context against the model's limit, or what is known of it. */
function windowLines(
  modelName: string,
  last: WireTokens | undefined,
  limit: number | undefined,
  inUse: number,
  compacted: boolean,
): string[] {
  const mark = compacted ? ' · compacted' : '';
  if (limit && last) {
    const share = inUse / limit;
    return [
      `Model ${modelName} · window ${n(limit)} tokens`,
      `In use ${n(inUse)} / ${n(limit)} (${Math.round(share * 100)}%)`,
      bar(share),
      `Headroom ${n(Math.max(0, limit - inUse))} tokens${mark}`,
    ];
  }
  if (last) return [`Model ${modelName} · window size unknown`, `In use ${n(inUse)} tokens at the last call${mark}`];
  return [`Model ${modelName}`];
}

/**
 * What OpenCode loaded beyond its own built-ins — aivi's plugin lives here, so
 * a missing or failed load says so in the channel. Built-ins are skipped: there
 * are ~88 of them and they are OpenCode, not what this home installed. The
 * source target is shown when it differs from the id (a `file:` install of the
 * plugin says which checkout is loaded; a published one says nothing extra).
 */
function pluginLines(plugins: WirePlugin[] | undefined): string[] {
  if (!plugins) return ['**Plugins** · OpenCode did not answer, so nothing here is claimed'];
  const loaded = plugins.filter(p => p.source.type !== 'builtin');
  if (loaded.length === 0) return ['**Plugins** · none beyond OpenCode’s built-ins — no aivi plugin in this OpenCode'];
  return [
    '**Plugins**',
    ...loaded.map(p => {
      const version = p.source.type === 'package' && p.source.version ? ` (v${p.source.version})` : '';
      const target =
        p.source.type === 'package' && p.source.target !== p.id
          ? `: ${p.source.target}`
          : p.source.type === 'local'
            ? `: ${home(p.source.path)}`
            : '';
      const failed = p.state.status === 'failed' ? ` — failed: ${p.state.error.slice(0, 120)}` : '';
      return `- ${p.id ?? 'unknown'}${version}${target}${failed}`;
    }),
  ];
}

/**
 * The context of one OpenCode session: the window in use against the model's
 * limit (the last answer's prompt plus output), what OpenCode has loaded, the
 * session's lifetime totals and cost, and the knowledge in scope. Everything
 * shown is read from OpenCode; nothing is estimated. Markdown that Discord,
 * Slack's `markdown` block and an agent relaying it all render.
 */
export async function describeSession(
  client: OpenCodeClient,
  sessionID: string,
  loaded: LoadedConfig,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> {
  // Three bounded calls, no transcript walk. `session.context` is OpenCode's
  // own view of the effective context — what the next call would send, starting
  // at the last compaction — the same read the TUI's context display makes; the
  // last answer in it carries the window. `session.get` carries the lifetime
  // cost and token totals. Before, this paged the whole transcript and re-summed
  // both from its pages (measured 2026-09-28: 218 messages over 2 pages for one
  // `/context`), numbers the API hands over directly.
  const [session, context, pluginPage] = await Promise.all([
    client.session.get({ sessionID }, { signal }),
    client.session.context({ sessionID }, { signal }),
    client.plugin.list({}, { signal }).catch(() => undefined),
  ]);
  const answered = (m: WireMessage): m is WireAssistant & { tokens: WireTokens } =>
    m.type === 'assistant' && !!m.tokens;
  const answer = (m: WireMessage): m is WireAssistant => m.type === 'assistant';
  const last = [...context].reverse().find(answered)?.tokens;
  const model = [...context].reverse().find(answer)?.model;
  // The effective context starts at the compaction that produced it.
  const compacted = context[0]?.type === 'compaction';
  const inUse = last ? last.input + last.cache.read + last.cache.write + last.output : 0;
  let limit: number | undefined;
  if (model) {
    const catalogue = await client.model
      .list({ location: { directory: session.location.directory } }, { signal })
      .catch(() => undefined);
    const info = catalogue?.data.find(m => m.providerID === model.providerID && m.modelID === model.id);
    limit = info?.limit.context;
  }
  const modelName = model
    ? `\`${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ''}\``
    : 'none yet';
  const totals = session.tokens;
  return [
    `🧠 **Context** · \`${session.agent}\` in \`${home(session.location.directory)}\``,
    ...windowLines(modelName, last, limit, inUse, compacted),
    session.cost ? `Billed $${session.cost.toFixed(4)}` : 'Billed: no cost reported by the provider',
    `Input ${n(totals.input)} · Output ${n(totals.output)} · Reasoning ${n(totals.reasoning)} · Cache read ${n(totals.cache.read)} / written ${n(totals.cache.write)}`,
    `_Totals are lifetime throughput, not context size: each answer re-sends the window above._`,
    '',
    ...pluginLines(pluginPage?.data),
    '',
    scopeLine(loaded),
  ].join('\n');
}
