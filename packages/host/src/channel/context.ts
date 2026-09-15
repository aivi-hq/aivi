import type { LoadedConfig } from '@aivi/core';
import type { OpenCodeClient } from '../opencode.ts';
import type { ConversationStore } from './store.ts';

/**
 * What a conversation's session knows, for a `/context` command: the agent and
 * where it runs, the model that answered last, how much has been said and spent,
 * the knowledge in scope, and what is still pending here. Read from OpenCode,
 * which owns the transcript; aivi adds only its own binding and queue.
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
  const scope = `Knowledge in scope: ${loaded.sources.filter(s => s.scope === 'core').length} core source(s)${projects.length ? `, projects ${projects.join(', ')}` : ''}.`;
  if (!binding || !binding.ready)
    return [
      `No session yet; the next message starts one with agent ${binding?.agent ?? config.agent} in ${binding?.directory ?? config.directory}.`,
      scope,
      pending.length ? `${pending.length} pending turn(s): ${pending.map(t => t.state).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');

  const client = await opencode();
  const session = await client.session.get({ sessionID: binding.session }, { signal });
  let users = 0;
  let assistants = 0;
  let model: { providerID: string; id: string; variant?: string } | undefined;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
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
        assistants++;
        model = message.model;
        if (message.tokens) {
          tokens.input += message.tokens.input;
          tokens.output += message.tokens.output;
          tokens.reasoning += message.tokens.reasoning;
          tokens.cacheRead += message.tokens.cache.read;
          tokens.cacheWrite += message.tokens.cache.write;
        }
        if (typeof message.cost === 'number') cost += message.cost;
      }
    }
    if (!page.cursor.next || page.data.length === 0) break;
    cursor = page.cursor.next;
  }
  const since = new Date(session.time.created).toISOString().slice(0, 16).replace('T', ' ');
  const spent = tokens.input + tokens.output + tokens.reasoning;
  return [
    `Session ${binding.session} since ${since} UTC, agent ${session.agent} in ${session.location.directory}.`,
    model
      ? `Model: ${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ''}.`
      : 'Model: none yet (no answer so far).',
    `${users} message(s) from people, ${assistants} answer(s); ${spent.toLocaleString('en')} tokens (${tokens.input.toLocaleString('en')} in, ${tokens.output.toLocaleString('en')} out, ${tokens.reasoning.toLocaleString('en')} reasoning; cache ${tokens.cacheRead.toLocaleString('en')} read / ${tokens.cacheWrite.toLocaleString('en')} written)${cost ? `, $${cost.toFixed(4)}` : ''}.`,
    scope,
    pending.length
      ? `${pending.length} pending turn(s): ${pending.map(t => t.state).join(', ')}.`
      : 'Nothing pending here.',
  ].join('\n');
}
