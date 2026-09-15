import type { OpenCodeClient } from '../opencode.ts';
import { agentModel } from '../session.ts';
import type { ConversationStore, ModelRef } from './store.ts';

type CatalogueModel = Awaited<ReturnType<OpenCodeClient['model']['list']>>['data'][number];
/** One thing a person can pick: a catalogue model, or one of its variants. */
export interface ModelChoice extends ModelRef {
  name: string;
}

/** The one spelling: `provider/model`, `provider/model@variant`. */
export const formatModel = (model: ModelRef) =>
  `${model.providerID}/${model.modelID}${model.variant ? `@${model.variant}` : ''}`;

/** The models OpenCode offers for a directory, enabled ones only, each variant as its own choice. */
export async function listModels(
  client: OpenCodeClient,
  directory: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<ModelChoice[]> {
  const catalogue = await client.model.list({ location: { directory } }, { signal });
  return catalogue.data.filter(m => m.enabled).flatMap(modelChoices);
}

export const modelChoices = (m: CatalogueModel): ModelChoice[] => [
  { providerID: m.providerID, modelID: m.modelID, name: m.name },
  ...m.variants.map(v => ({
    providerID: m.providerID,
    modelID: m.modelID,
    variant: v.id,
    name: `${m.name} (${v.id})`,
  })),
];

/** `provider/model (variant)` is read as `provider/model@variant`; case and surrounding space do not matter. */
const normalize = (text: string) =>
  text
    .trim()
    .replace(/\s*\(([^)]+)\)\s*$/, '@$1')
    .toLowerCase();

/** Choices whose id or display name contain the query; prefix matches on the id first, then on the model id. */
export function matchModels(choices: ModelChoice[], query: string, limit: number): ModelChoice[] {
  const q = normalize(query);
  return choices
    .map(m => {
      const id = formatModel(m).toLowerCase();
      const score = !q
        ? 1
        : id.startsWith(q)
          ? 3
          : `${m.modelID}${m.variant ? `@${m.variant}` : ''}`.toLowerCase().startsWith(q)
            ? 2
            : id.includes(q) || normalize(m.name).includes(q)
              ? 1
              : 0;
      return { m, score };
    })
    .filter(x => x.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.m.providerID.localeCompare(b.m.providerID) || a.m.name.localeCompare(b.m.name),
    )
    .slice(0, limit)
    .map(x => x.m);
}

/**
 * What a typed model means: an exact `provider/model[@variant]`, a model id or display
 * name that names exactly one choice, or the closest candidates to pick from.
 */
export function resolveModel(
  choices: ModelChoice[],
  text: string,
): { model: ModelChoice } | { candidates: ModelChoice[] } {
  const wanted = normalize(text);
  const exact = choices.find(m => formatModel(m).toLowerCase() === wanted);
  if (exact) return { model: exact };
  const byName = choices.filter(
    m => `${m.modelID}${m.variant ? `@${m.variant}` : ''}`.toLowerCase() === wanted || normalize(m.name) === wanted,
  );
  if (byName.length === 1) return { model: byName[0]! };
  return { candidates: byName.length ? byName : matchModels(choices, text, 5) };
}

/** The model the session last answered with, read from its transcript; undefined before the first answer. */
async function lastAnswerModel(
  client: OpenCodeClient,
  sessionID: string,
  signal: AbortSignal,
): Promise<ModelRef | undefined> {
  const page = await client.message.list({ sessionID, limit: 1, order: 'desc', type: 'assistant' }, { signal });
  const last = page.data.find(m => m.type === 'assistant')?.model;
  return last
    ? { providerID: last.providerID, modelID: last.id, ...(last.variant ? { variant: last.variant } : {}) }
    : undefined;
}

/** What the agent uses on its own: the agent file's model, else OpenCode's default for the directory. */
async function agentDefaultModel(
  client: OpenCodeClient,
  agent: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const pinned = await agentModel(client, agent, directory, { signal }).catch(() => undefined);
  if (pinned)
    return `\`${formatModel({ providerID: pinned.providerID, modelID: pinned.id, ...(pinned.variant ? { variant: pinned.variant } : {}) })}\` (agent file)`;
  const fallback = await client.model.default({ location: { directory } }, { signal }).catch(() => undefined);
  if (fallback?.data) return `\`${formatModel(fallback.data)}\` (OpenCode default; the agent file pins none)`;
  return 'unknown (the agent file pins none and OpenCode reports no default)';
}

/**
 * `/model` without an argument: the conversation's pin if any, what its session last
 * answered with, and what the agent uses by default.
 */
export async function describeModel(
  store: ConversationStore,
  channel: string,
  config: { agent: string; directory: string },
  opencode: () => Promise<OpenCodeClient>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> {
  const binding = store.sessionOf(channel);
  const agent = binding?.agent ?? config.agent;
  const directory = binding?.directory ?? config.directory;
  const client = await opencode();
  const last = binding?.ready
    ? await lastAnswerModel(client, binding.session, signal).catch(() => undefined)
    : undefined;
  return [
    '🧠 **Model**',
    binding?.model
      ? `This conversation: \`${formatModel(binding.model)}\` (pinned with /model, until /new).`
      : 'This conversation: the agent’s default.',
    last ? `Last answer: \`${formatModel(last)}\`.` : 'Last answer: none yet.',
    `Agent \`${agent}\`: ${await agentDefaultModel(client, agent, directory, signal)}.`,
  ].join('\n');
}

/**
 * `/model <model>`: pin the conversation's session to a catalogue model for its next
 * turns, until `/new`; `default` removes the pin. The turn runner applies it before every
 * prompt. Refused while a turn runs here (its model is in use) and for anything the
 * catalogue does not list.
 */
export async function switchModel(
  store: ConversationStore,
  channel: string,
  config: { agent: string; directory: string },
  opencode: () => Promise<OpenCodeClient>,
  text: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> {
  if (store.running(channel))
    return 'A turn is running in this conversation. Wait for its answer (or /stop it), then switch.';
  const wanted = text.trim();
  if (wanted.toLowerCase() === 'default') {
    store.setModel(channel, null);
    return 'This conversation answers with the agent’s default model again from its next message on.';
  }
  const binding = store.sessionOf(channel);
  const choices = await listModels(await opencode(), binding?.directory ?? config.directory, signal);
  const resolved = resolveModel(choices, wanted);
  if ('candidates' in resolved) {
    const shown = resolved.candidates.map(m => `\`${formatModel(m)}\``).join(', ');
    return shown
      ? `No model is called \`${wanted}\`. Closest: ${shown}.`
      : `No model is called \`${wanted}\`. Nothing in the catalogue matches; try part of the name.`;
  }
  const { name: _, ...model } = resolved.model;
  store.setModel(channel, model);
  return `This conversation answers with \`${formatModel(model)}\` from its next message on, until /new.`;
}
