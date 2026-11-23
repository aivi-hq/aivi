import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { describeModel, type ModelChoice, resolveModel, switchModel } from '../src/channel/model.ts';
import type { ConversationStore } from '../src/channel/store.ts';

const config = { agent: 'assistant', directory: '/assistant' };
const unreadable = async () => {
  throw new Error('OpenCode is not answering');
};
const started = {
  session: 'ses_1',
  ready: true,
  agent: null,
  directory: null,
  model: null,
  project: null,
  issue: null,
};

/** What `/model` reads from OpenCode: the session's last answer, the agent files and OpenCode's default. */
const reading = (reads: {
  messages?: () => Promise<unknown>;
  agents?: () => Promise<unknown>;
  fallback?: () => Promise<unknown>;
}) =>
  ({
    message: { list: reads.messages ?? (async () => ({ data: [] })) },
    agent: { list: reads.agents ?? (async () => ({ data: [] })) },
    model: { default: reads.fallback ?? (async () => ({})) },
  }) as unknown as OpenCodeClient;
const describing = (reads: Parameters<typeof reading>[0], binding: object | null) =>
  describeModel({ sessionOf: () => binding } as unknown as ConversationStore, 'dm', config, async () => reading(reads));

test('/model says what the session last answered with, or none yet when it has not or OpenCode cannot tell', async () => {
  const answered = (model: object) => async () => ({ data: [{ type: 'assistant', model }] });
  const cases = [
    ['an answer with a variant', answered({ providerID: 'github-copilot', id: 'gpt-5.2', variant: 'high' })],
    ['an answer without one', answered({ providerID: 'github-copilot', id: 'gpt-5.2' })],
    ['no answer yet', async () => ({ data: [] })],
    ['a transcript that cannot be read', unreadable],
  ] as const;

  const lines = await Promise.all(
    cases.map(async ([, messages]) => (await describing({ messages }, started)).split('\n')[2]),
  );
  assert.deepEqual(lines, [
    'Last answer: `github-copilot/gpt-5.2@high`.',
    'Last answer: `github-copilot/gpt-5.2`.',
    'Last answer: none yet.',
    'Last answer: none yet.',
  ]);
});

test('/model names what the agent uses on its own: its file’s model, else OpenCode’s default, else nothing', async () => {
  const agentFile = (model?: object) => async () => ({ data: [{ id: 'assistant', ...(model ? { model } : {}) }] });
  const openCodeDefault = async () => ({ data: { providerID: 'github-copilot', modelID: 'gemini-3.8-flash' } });
  const usedDefault =
    'Agent `assistant`: `github-copilot/gemini-3.8-flash` (OpenCode default; the agent file pins none).';
  const unknown = 'Agent `assistant`: unknown (the agent file pins none and OpenCode reports no default).';
  const cases = [
    [{ agents: agentFile({ providerID: 'openai', id: 'o9' }) }, 'Agent `assistant`: `openai/o9` (agent file).'],
    [
      { agents: agentFile({ providerID: 'openai', id: 'o9', variant: 'max' }) },
      'Agent `assistant`: `openai/o9@max` (agent file).',
    ],
    [{ agents: agentFile(), fallback: openCodeDefault }, usedDefault],
    [{ agents: unreadable, fallback: openCodeDefault }, usedDefault],
    [{ agents: agentFile() }, unknown],
    [{ agents: agentFile(), fallback: unreadable }, unknown],
  ] as const;

  const lines = await Promise.all(cases.map(async ([reads]) => (await describing(reads, null)).split('\n')[3]));
  assert.deepEqual(
    lines,
    cases.map(([, line]) => line),
  );
});

test('a model id that two providers offer is not picked for the person: both come back as candidates', () => {
  const choices: ModelChoice[] = [
    { providerID: 'openai', modelID: 'gpt-5.2', name: 'GPT 5.2' },
    { providerID: 'github-copilot', modelID: 'gpt-5.2', name: 'GPT 5.2' },
  ];
  assert.deepEqual(resolveModel(choices, 'gpt-5.2'), { candidates: choices });
});

test('switching the model reads the catalogue of the directory the conversation is bound to', async () => {
  const list = mock.fn(async (_query: unknown) => ({
    data: [{ providerID: 'openai', modelID: 'o9', name: 'o9', enabled: true, variants: [] }],
  }));
  const setModel = mock.fn();
  const store = {
    running: () => null,
    sessionOf: () => ({ ...started, directory: '/worktree' }),
    setModel,
  } as unknown as ConversationStore;

  const said = await switchModel(
    store,
    'dm',
    config,
    async () => ({ model: { list } }) as unknown as OpenCodeClient,
    'o9',
  );

  assert.equal(said, 'This conversation answers with `openai/o9` from its next message on, until /new.');
  assert.deepEqual(list.mock.calls[0]!.arguments[0], { location: { directory: '/worktree' } });
  assert.deepEqual(setModel.mock.calls[0]!.arguments, ['dm', { providerID: 'openai', modelID: 'o9' }]);
});
