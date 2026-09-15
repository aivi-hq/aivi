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

/**
 * What a conversation's session knows, for a `/context` command: the window in
 * use against the model's limit, the session's totals and cost, the knowledge in
 * scope and what is still pending here. Read from OpenCode, which owns the
 * transcript and the model catalogue; aivi adds only its binding and its queue.
 * Markdown that both Discord and Slack's `markdown` block render.
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
  const projects = loaded.projects.filter(p => !p.removed).map(p => p.id);
  const core = loaded.sources.filter(s => s.scope === 'core').length;
  const scope = `**Knowledge in scope** ${core} core source${core === 1 ? '' : 's'}${projects.length ? ` · projects: ${projects.join(', ')}` : ' · no projects'}`;
  const queue = pending.length
    ? `${pending.length} pending turn${pending.length === 1 ? '' : 's'} here: ${pending.map(t => t.state).join(', ')}.`
    : 'Nothing pending here.';
  if (!binding || !binding.ready)
    return [
      `🧠 **Context** · no session yet`,
      `The next message starts one with agent \`${binding?.agent ?? config.agent}\` in \`${home(binding?.directory ?? config.directory)}\`.`,
      '',
      scope,
      queue,
    ].join('\n');

  const client = await opencode();
  const session = await client.session.get({ sessionID: binding.session }, { signal });
  let users = 0;
  let answers = 0;
  let compactions = 0;
  let model: { providerID: string; id: string; variant?: string } | undefined;
  let last: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined;
  const totals = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 };
  let cost = 0;
  let cursor: string | undefined;
  while (true) {
    const page = await client.message.list(
      cursor
        ? { sessionID: binding.session, limit: 200, cursor }
        : { sessionID: binding.session, limit: 200, order: 'asc' },
      { signal },
    );
    for (const message of page.data) {
      if (message.type === 'user') users++;
      else if (message.type === 'assistant') {
        answers++;
        model = message.model;
        if (message.tokens) {
          last = message.tokens;
          totals.input += message.tokens.input;
          totals.output += message.tokens.output;
          totals.reasoning += message.tokens.reasoning;
          totals.read += message.tokens.cache.read;
          totals.write += message.tokens.cache.write;
        }
        if (typeof message.cost === 'number') cost += message.cost;
      } else if (message.type === 'compaction' && message.status === 'completed') compactions++;
    }
    if (!page.cursor.next || page.data.length === 0) break;
    cursor = page.cursor.next;
  }

  // The window at the last call is everything that call was sent plus what it wrote.
  const inUse = last ? last.input + last.cache.read + last.cache.write + last.output : 0;
  let limit: number | undefined;
  let threshold: number | undefined;
  if (model) {
    const catalogue = await client.model
      .list({ location: { directory: session.location.directory } }, { signal })
      .catch(() => undefined);
    const info = catalogue?.data.find(m => m.providerID === model!.providerID && m.modelID === model!.id);
    limit = info?.limit.context;
    if (info?.compaction?.mode === 'provider' && info.compaction.threshold) threshold = info.compaction.threshold;
  }
  const modelName = model
    ? `\`${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ''}\``
    : 'none yet';
  const window: string[] = [];
  if (limit && last) {
    const share = inUse / limit;
    window.push(
      `Model ${modelName} · window ${n(limit)} tokens`,
      `In use ${n(inUse)} / ${n(limit)} (${Math.round(share * 100)}%)`,
      bar(share),
      `Headroom ${n(Math.max(0, limit - inUse))} tokens · ${compactions} compaction${compactions === 1 ? '' : 's'}${threshold ? ` · compacts at ${n(threshold)}` : ''}`,
    );
  } else if (last) {
    window.push(
      `Model ${modelName} · window size unknown`,
      `In use ${n(inUse)} tokens at the last call · ${compactions} compaction${compactions === 1 ? '' : 's'}`,
    );
  } else window.push(`Model ${modelName}`);

  const since = new Date(session.time.created).toISOString().slice(0, 16).replace('T', ' ');
  return [
    `🧠 **Context** · \`${session.agent}\` in \`${home(session.location.directory)}\``,
    ...window,
    '',
    `**This session** since ${since} UTC · \`${short(binding.session)}\``,
    `${n(users)} message${users === 1 ? '' : 's'} · ${n(answers)} answer${answers === 1 ? '' : 's'}`,
    `Input ${n(totals.input)} · Output ${n(totals.output)} · Reasoning ${n(totals.reasoning)} · Cache read ${n(totals.read)} / written ${n(totals.write)}`,
    cost ? `Billed $${cost.toFixed(4)}` : 'Billed: no cost reported by the provider',
    `_Totals are throughput, not context size: each answer re-sends the window above._`,
    '',
    scope,
    queue,
  ].join('\n');
}
