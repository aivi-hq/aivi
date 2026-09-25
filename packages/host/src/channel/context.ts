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
const short = (id: string) => (id.length > 28 ? `${id.slice(0, 24)}…` : id);

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

type WireMessage = Awaited<ReturnType<OpenCodeClient['message']['list']>>['data'][number];
type WireAssistant = Extract<WireMessage, { type: 'assistant' }>;
type WireTokens = NonNullable<WireAssistant['tokens']>;

/** What the transcript says about a session's usage, folded from every message. */
interface SessionUsage {
  users: number;
  answers: number;
  compactions: number;
  /** The last assistant answer's model and tokens: the window as of that call. */
  model?: WireAssistant['model'];
  last?: WireTokens;
  totals: { input: number; output: number; reasoning: number; read: number; write: number };
  cost: number;
}

const addTokens = (totals: SessionUsage['totals'], t: WireTokens) => {
  totals.input += t.input;
  totals.output += t.output;
  totals.reasoning += t.reasoning;
  totals.read += t.cache.read;
  totals.write += t.cache.write;
};

/** Fold one message into the session's usage: counts, the last call's window, totals. */
function foldMessage(usage: SessionUsage, message: WireMessage): void {
  if (message.type === 'user') usage.users++;
  else if (message.type === 'assistant') {
    usage.answers++;
    usage.model = message.model;
    if (message.tokens) {
      usage.last = message.tokens;
      addTokens(usage.totals, message.tokens);
    }
    if (typeof message.cost === 'number') usage.cost += message.cost;
  } else if (message.type === 'compaction' && message.status === 'completed') usage.compactions++;
}

/** Walk the transcript once, oldest to newest, counting turns and summing tokens. */
async function sessionUsage(client: OpenCodeClient, sessionID: string, signal: AbortSignal): Promise<SessionUsage> {
  const usage: SessionUsage = {
    users: 0,
    answers: 0,
    compactions: 0,
    totals: { input: 0, output: 0, reasoning: 0, read: 0, write: 0 },
    cost: 0,
  };
  let cursor: string | undefined;
  while (true) {
    const page = await client.message.list(
      cursor ? { sessionID, limit: 200, cursor } : { sessionID, limit: 200, order: 'asc' },
      { signal },
    );
    for (const message of page.data) foldMessage(usage, message);
    if (!page.cursor.next || page.data.length === 0) break;
    cursor = page.cursor.next;
  }
  return usage;
}

/** The window lines: the last call's context against the model's limit, or what is known of it. */
function windowLines(
  modelName: string,
  last: WireTokens | undefined,
  limit: number | undefined,
  inUse: number,
  compactions: number,
): string[] {
  const compacted = `${compactions} compaction${compactions === 1 ? '' : 's'}`;
  if (limit && last) {
    const share = inUse / limit;
    return [
      `Model ${modelName} · window ${n(limit)} tokens`,
      `In use ${n(inUse)} / ${n(limit)} (${Math.round(share * 100)}%)`,
      bar(share),
      `Headroom ${n(Math.max(0, limit - inUse))} tokens · ${compacted}`,
    ];
  }
  if (last)
    return [`Model ${modelName} · window size unknown`, `In use ${n(inUse)} tokens at the last call · ${compacted}`];
  return [`Model ${modelName}`];
}

/**
 * The context of one OpenCode session: the window in use against the model's
 * limit (the last answer's prompt plus output, from the transcript and the model
 * catalogue), compactions, the session's totals and cost, and the knowledge in
 * scope. Everything shown is read from OpenCode; nothing is estimated. Markdown
 * that Discord, Slack's `markdown` block and an agent relaying it all render.
 */
export async function describeSession(
  client: OpenCodeClient,
  sessionID: string,
  loaded: LoadedConfig,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> {
  const session = await client.session.get({ sessionID }, { signal });
  const usage = await sessionUsage(client, sessionID, signal);
  // The window at the last call is everything that call was sent plus what it wrote.
  const inUse = usage.last ? usage.last.input + usage.last.cache.read + usage.last.cache.write + usage.last.output : 0;
  let limit: number | undefined;
  if (usage.model) {
    const catalogue = await client.model
      .list({ location: { directory: session.location.directory } }, { signal })
      .catch(() => undefined);
    const info = catalogue?.data.find(m => m.providerID === usage.model!.providerID && m.modelID === usage.model!.id);
    limit = info?.limit.context;
  }
  const modelName = usage.model
    ? `\`${usage.model.providerID}/${usage.model.id}${usage.model.variant ? ` (${usage.model.variant})` : ''}\``
    : 'none yet';
  const since = new Date(session.time.created).toISOString().slice(0, 16).replace('T', ' ');
  return [
    `🧠 **Context** · \`${session.agent}\` in \`${home(session.location.directory)}\``,
    ...windowLines(modelName, usage.last, limit, inUse, usage.compactions),
    '',
    `**This session** since ${since} UTC · \`${short(sessionID)}\``,
    `${n(usage.users)} message${usage.users === 1 ? '' : 's'} · ${n(usage.answers)} answer${usage.answers === 1 ? '' : 's'}`,
    `Input ${n(usage.totals.input)} · Output ${n(usage.totals.output)} · Reasoning ${n(usage.totals.reasoning)} · Cache read ${n(usage.totals.read)} / written ${n(usage.totals.write)}`,
    usage.cost ? `Billed $${usage.cost.toFixed(4)}` : 'Billed: no cost reported by the provider',
    `_Totals are throughput, not context size: each answer re-sends the window above._`,
    '',
    scopeLine(loaded),
  ].join('\n');
}
