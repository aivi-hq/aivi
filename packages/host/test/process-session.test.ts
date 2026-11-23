/** A turn as a unit, over a client the test hands in: what it sends OpenCode to
 *  create a session, how it answers permission prompts, and how it ends when
 *  the host stops it. The messages are the shape OpenCode's context reads in
 *  (`session.test.ts` runs the same turn over a mock server). */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { OpenCodeClient, SessionEvent, SessionEventListener, SessionEvents } from '@aivi/plugin/module';
import { finalAnswer, PermissionRequired, runTurn } from '../src/session.ts';
import { recorder } from './support.ts';

type Messages = Parameters<typeof finalAnswer>[0];

const user = { type: 'user', id: 'msg_1', text: 'q', time: { created: 1 } };
const idle = { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } };
const answer = (content: unknown[]) => ({
  type: 'assistant',
  id: 'a',
  agent: 'assistant',
  finish: 'stop',
  time: { created: 2, completed: 3 },
  content,
});
const said = [{ type: 'text', text: 'Answer' }];
const tool = (status: string) => ({ type: 'tool', id: 't', name: 'bash', state: { status } });
const finished = [user, answer(said), idle];

const messages = (...parts: unknown[]) => parts as unknown as Messages;

for (const [name, content, outcome] of [
  ['a tool still running', [tool('running'), ...said], /Native turn has unfinished tools/],
  ['a tool that failed is finished', [tool('error'), ...said], 'Answer'],
  ['a tool that completed is finished', [tool('completed'), ...said], 'Answer'],
  ['an answer with no text', [{ type: 'reasoning', text: 'hmm' }], /Final answer has no text/],
] as const)
  test(`the final answer of a turn with ${name}`, () => {
    const read = () => finalAnswer(messages(user, answer([...content]), idle), 'msg_1', 'assistant');
    if (typeof outcome === 'string') assert.equal(read(), outcome);
    else assert.throws(read, outcome);
  });

/** What the turn reaches: one mocked function per client method, recording its calls. */
function opencode(
  t: TestContext,
  over: {
    agents?: unknown[];
    session?: Record<string, unknown>;
    wait?: () => Promise<unknown>;
    context?: () => Promise<unknown>;
    pending?: { id: string; action: string; resources: string[] }[];
    reply?: () => Promise<unknown>;
  } = {},
) {
  const calls = {
    agentList: t.mock.fn(async () => ({ data: over.agents ?? [] })),
    create: t.mock.fn(async (_body: unknown, _request: unknown) => undefined),
    get: t.mock.fn(async () => ({ agent: 'assistant', location: { directory: '/lib' }, ...over.session })),
    update: t.mock.fn(async () => undefined),
    switchModel: t.mock.fn(async () => undefined),
    prompt: t.mock.fn(async () => undefined),
    wait: t.mock.fn(over.wait ?? (async () => undefined)),
    context: t.mock.fn(over.context ?? (async () => finished)),
    list: t.mock.fn(async () => over.pending ?? []),
    reply: t.mock.fn(over.reply ?? (async (_body: unknown, _request: unknown) => undefined)),
  };
  const client = {
    agent: { list: calls.agentList },
    session: {
      create: calls.create,
      get: calls.get,
      update: calls.update,
      switchModel: calls.switchModel,
      prompt: calls.prompt,
      wait: calls.wait,
      context: calls.context,
    },
    permission: { list: calls.list, reply: calls.reply },
  } as unknown as OpenCodeClient;
  return { client, ...calls };
}

/** The host's event stream: the test says an event, and sees how many turns are watching. */
function stream() {
  const listeners = new Set<SessionEventListener>();
  const watchers: PromiseWithResolvers<void>[] = [Promise.withResolvers(), Promise.withResolvers()];
  const events: SessionEvents = {
    watch(_sessionID, listener) {
      listeners.add(listener);
      watchers[listeners.size - 1]?.resolve();
      return () => listeners.delete(listener);
    },
  };
  return {
    events,
    watching: () => listeners.size,
    /** Settles once this many listeners have been watching at the same time. */
    watched: (count: 1 | 2) => watchers[count - 1]!.promise,
    emit: (event: SessionEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const asked = (id: string, action = 'shell', resources = ['ls']) =>
  ({ type: 'permission.asked', data: { id, sessionID: 'ses_1', action, resources } }) as unknown as SessionEvent;

const turn = {
  sessionId: 'ses_1',
  agent: 'assistant',
  directory: '/lib',
  messageId: 'msg_1',
  text: 'q',
  create: false,
};
const signal = () => AbortSignal.timeout(2_000);

const created = (body: Record<string, unknown>) => ({
  id: 'ses_1',
  agent: 'assistant',
  location: { directory: '/lib' },
  ...body,
});
const gemini = { providerID: 'github-copilot', id: 'gemini-3.8-flash' };

const births: [string, Parameters<typeof opencode>[1], Record<string, unknown>, Record<string, unknown>][] = [
  [
    'the agent file’s model, variant included',
    { agents: [{ id: 'assistant', model: { ...gemini, variant: 'high' } }] },
    {},
    created({ model: { ...gemini, variant: 'high' } }),
  ],
  [
    'the agent file’s model, found by the agent’s name',
    { agents: [{ id: 'agent_7', name: 'assistant', model: gemini }] },
    {},
    created({ model: gemini }),
  ],
  ['no model when the agent file names none', { agents: [{ id: 'assistant' }] }, {}, created({})],
  [
    'its title, its metadata and its permission rules when the caller brings them',
    {},
    {
      title: 'aivi dreaming',
      sessionMetadata: { aivi: { origin: 'dreaming' } },
      permissions: [{ action: 'edit', resource: 'facts.md', effect: 'allow' }],
    },
    created({
      title: 'aivi dreaming',
      metadata: { aivi: { origin: 'dreaming' } },
      permissions: [{ action: 'edit', resource: 'facts.md', effect: 'allow' }],
    }),
  ],
];
for (const [name, over, input, body] of births)
  test(`a session is created with ${name}`, async t => {
    const world = opencode(t, over);
    await runTurn(world.client, { ...turn, create: true, ...input }, { signal: signal(), events: stream().events });
    assert.deepEqual(world.create.mock.calls[0]!.arguments[0], body);
  });

test('a model pinned by the conversation is the session’s from birth, and the agent file is not asked', async t => {
  const world = opencode(t, { session: { model: { providerID: 'openai', id: 'gpt-5.2', variant: 'high' } } });
  await runTurn(
    world.client,
    { ...turn, create: true, model: { providerID: 'openai', modelID: 'gpt-5.2', variant: 'high' } },
    { signal: signal(), events: stream().events },
  );
  assert.deepEqual(
    world.create.mock.calls[0]!.arguments[0],
    created({ model: { providerID: 'openai', id: 'gpt-5.2', variant: 'high' } }),
  );
  assert.equal(world.agentList.mock.callCount(), 0);
  assert.equal(world.switchModel.mock.callCount(), 0, 'the session already runs the pin');
});

test('a permission that is both listed and announced is rejected once', async t => {
  const world = opencode(t, { pending: [{ id: 'per_1', action: 'shell', resources: ['ls'] }] });
  const host = stream();
  world.wait.mock.mockImplementation(async () => host.emit(asked('per_1')));
  const result = await runTurn(world.client, turn, { signal: signal(), events: host.events });
  assert.deepEqual(result.rejected, [{ action: 'shell', resources: ['ls'] }]);
  assert.equal(world.reply.mock.callCount(), 1);
  assert.deepEqual(world.reply.mock.calls[0]!.arguments[0], {
    sessionID: 'ses_1',
    requestID: 'per_1',
    decision: 'reject',
  });
});

test('a reply that fails is said and the turn goes on to its answer', async t => {
  const failure = new Error('permission endpoint is down');
  const world = opencode(t, {
    reply: async () => {
      throw failure;
    },
  });
  const host = stream();
  const { log, said: lines } = recorder();
  world.wait.mock.mockImplementation(async () => host.emit(asked('per_2')));
  const result = await runTurn(world.client, turn, { signal: signal(), events: host.events, log });
  assert.deepEqual(
    result,
    { sessionId: 'ses_1', text: 'Answer', rejected: [] },
    'nothing was rejected: the reply did not land',
  );
  assert.deepEqual(
    lines('warn').map(line => [line.event, line.error]),
    [['permission.reply.failed', failure]],
  );
});

test('under the fail policy a permission asked while the turn waits stops it, and the watch ends', async t => {
  const host = stream();
  const parked = Promise.withResolvers<void>();
  const world = opencode(t, {
    wait: () => {
      parked.resolve();
      return new Promise(() => {});
    },
  });
  const turned = runTurn(world.client, turn, { signal: signal(), events: host.events, onPermission: 'fail' });
  await parked.promise;
  host.emit(asked('per_3', 'shell', ['rm -rf']));
  await assert.rejects(
    turned,
    (error: unknown) => error instanceof PermissionRequired && error.requests[0]!.resources[0] === 'rm -rf',
  );
  assert.equal(host.watching(), 0);
  assert.equal(world.reply.mock.callCount(), 0, 'the prompt is left pending for a person');
});

test('under the fail policy a permission asked as the wait returns still stops the turn', async t => {
  const host = stream();
  const world = opencode(t);
  world.wait.mock.mockImplementation(async () => host.emit(asked('per_4')));
  await assert.rejects(
    runTurn(world.client, turn, { signal: signal(), events: host.events, onPermission: 'fail' }),
    PermissionRequired,
  );
  assert.equal(world.context.mock.callCount(), 0, 'no answer was read from a turn that needs a person');
});

test('a host that stops while the turn waits for the next event ends the turn with its reason, and the watches end', async t => {
  const host = stream();
  const abort = new AbortController();
  const world = opencode(t, { context: async () => [] });
  const turned = runTurn(world.client, turn, { signal: abort.signal, events: host.events });
  await host.watched(2);
  assert.equal(host.watching(), 2, 'the permission watch and the wait for the next event');
  abort.abort(new Error('host stopping'));
  await assert.rejects(turned, /host stopping/);
  assert.equal(host.watching(), 0);
});
