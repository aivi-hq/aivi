import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import type { SessionEvent, SessionEventListener, SessionEvents } from '../src/events.ts';
import { connectOpenCode } from '../src/opencode.ts';
import { finalAnswer, PermissionRequired, runTurn } from '../src/session.ts';

test('only the matching completed final answer is returned, without reasoning or tool data', () => {
  const messages = [
    { type: 'user', id: 'old', time: { created: 1 }, text: 'old question' },
    {
      type: 'user',
      id: 'current',
      time: { created: 2 },
      text: 'current question',
      metadata: { aivi: { message: 'msg_one' } },
    },
    {
      type: 'assistant',
      id: 'answer',
      time: { created: 3, completed: 4 },
      agent: 'librarian',
      finish: 'stop',
      content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'Public answer' },
      ],
    },
    { type: 'idle', id: 'idle', time: { created: 5 }, outcome: 'succeeded' },
  ] as unknown as Parameters<typeof finalAnswer>[0];
  assert.equal(finalAnswer(messages, 'msg_one', 'librarian'), 'Public answer');
  assert.equal(
    finalAnswer(messages, 'current', 'librarian'),
    'Public answer',
    'the native message id also identifies the turn',
  );
  assert.throws(() => finalAnswer(messages, 'unknown', 'librarian'), /not present/);
  assert.throws(() => finalAnswer(messages.slice(0, -1), 'msg_one', 'librarian'), /not complete/);
  assert.throws(() => finalAnswer(messages, 'msg_one', 'developer'), /No confirmed/);
  const failed = structuredClone(messages);
  (failed.at(-1) as { outcome: string }).outcome = 'failed';
  assert.throws(() => finalAnswer(failed, 'msg_one', 'librarian'), /No confirmed/);
  // A /steer into this turn is a user message that belongs to it; any other user message means the session moved on.
  const steered = structuredClone(messages);
  steered.splice(3, 0, {
    type: 'user',
    id: 'steer',
    time: { created: 3.5 },
    text: 'also check the handbook',
    metadata: { aivi: { steer: 'msg_one' } },
  } as unknown as (typeof messages)[number]);
  assert.equal(finalAnswer(steered, 'msg_one', 'librarian'), 'Public answer');
  const foreign = structuredClone(messages);
  foreign.splice(3, 0, {
    type: 'user',
    id: 'other',
    time: { created: 3.5 },
    text: 'typed in the TUI',
  } as unknown as (typeof messages)[number]);
  assert.throws(() => finalAnswer(foreign, 'msg_one', 'librarian'), /changed outside this turn/);
  const otherSteer = structuredClone(steered);
  (otherSteer[3] as unknown as { metadata: { aivi: { steer: string } } }).metadata.aivi.steer = 'msg_two';
  assert.throws(() => finalAnswer(otherSteer, 'msg_one', 'librarian'), /changed outside this turn/);
});

/** Mock of the OpenCode 2.0.3 endpoints runTurn touches; the context shape matches the live server. */
function mockOpenCode(
  options: {
    pending?: { id: string; action: string; resources: string[] }[];
    agent?: string;
    contextLagsFor?: number;
    /** Runs when `wait` is requested, before it answers: the moment a permission would be asked. */
    waitUntil?: () => void;
    onPermissionList?: () => void;
    /** What the session reports as its model (`session.get`); the librarian's file pins gemini-3.8-flash. */
    sessionModel?: { id: string; providerID: string };
  } = {},
) {
  const requests: { method: string; path: string; body: Record<string, any> }[] = [];
  let pending = options.pending ?? [];
  let lag = options.contextLagsFor ?? 0;
  let promptId = '';
  let sessionModel = options.sessionModel;
  const agent = options.agent ?? 'librarian';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method!, path: req.url!, body });
    res.setHeader('content-type', 'application/json');
    const url = req.url!;
    if (url.endsWith('/wait')) options.waitUntil?.();
    if (url.startsWith('/api/agent')) {
      res.end(
        JSON.stringify({
          data: [
            { id: 'librarian', name: 'librarian', model: { id: 'gemini-3.8-flash', providerID: 'github-copilot' } },
          ],
        }),
      );
      return;
    }
    if (req.method === 'PATCH' || url.endsWith('/wait') || url.endsWith('/model')) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.endsWith('/permission') && req.method === 'GET') {
      options.onPermissionList?.();
      res.end(JSON.stringify({ data: pending }));
      return;
    }
    if (/\/permission\/[^/]+\/reply$/.test(url)) {
      pending = pending.filter(p => !url.includes(p.id));
      res.writeHead(204);
      res.end();
      return;
    }
    if (url === '/api/session' && req.method === 'POST') sessionModel = body.model;
    if (url.endsWith('/prompt')) {
      promptId = body.id;
      res.end(JSON.stringify({ data: { id: body.id } }));
      return;
    }
    if (url.endsWith('/context')) {
      if (lag > 0) {
        lag--;
        res.end(JSON.stringify({ data: [] })); // wait() already returned but the context is not there yet
        return;
      }
      res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: promptId, text: 'q', time: { created: 1 } },
            {
              type: 'assistant',
              id: 'a',
              agent,
              finish: 'stop',
              time: { created: 2, completed: 3 },
              content: [{ type: 'text', text: 'Answer' }],
            },
            { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        data: {
          id: 'ses_test',
          agent: 'librarian',
          location: { directory: '/lib' },
          ...(sessionModel ? { model: sessionModel } : {}),
        },
      }),
    );
  });
  return { server, requests };
}

async function withServer<T>(
  t: { after(fn: () => Promise<void>): void },
  mock: ReturnType<typeof mockOpenCode>,
  run: (client: Awaited<ReturnType<typeof connectOpenCode>>) => Promise<T>,
): Promise<T> {
  await new Promise<void>(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => mock.server.close(() => resolve())));
  const address = mock.server.address();
  assert.ok(address && typeof address !== 'string');
  const config = configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } });
  return run(await connectOpenCode(config.opencode, {}));
}

const input = { sessionId: 'ses_test', agent: 'librarian', directory: '/lib', messageId: 'msg_t1', text: 'q' };
/** A fake host event stream: `emit` pushes an event to whoever watches that session. */
function fakeEvents(): SessionEvents & { emit(sessionID: string, event: SessionEvent): void; watchers: number } {
  const listeners = new Map<string, Set<SessionEventListener>>();
  return {
    watchers: 0,
    watch(sessionID, listener) {
      this.watchers++;
      const set = listeners.get(sessionID) ?? new Set();
      set.add(listener);
      listeners.set(sessionID, set);
      return () => set.delete(listener);
    },
    emit(sessionID, event) {
      for (const l of listeners.get(sessionID) ?? []) l(event);
    },
  };
}
/** Every watch is answered by an event at once: the "context trails wait()" re-check has something to wake on. */
const chatty: SessionEvents = {
  watch(_id, listener) {
    const t = setImmediate(() => listener({ type: 'session.idle', data: { sessionID: 'ses_test' } }));
    return () => clearImmediate(t);
  },
};
const quiet = fakeEvents();

test('runTurn creates, pins permissions, prompts, and returns the verified answer', async t => {
  const mock = mockOpenCode();
  let created = 0;
  const result = await withServer(t, mock, client =>
    runTurn(
      client,
      {
        ...input,
        create: true,
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        sessionMetadata: { aivi: { origin: 'test' } },
      },
      { signal: AbortSignal.timeout(5000), events: quiet, onCreated: () => created++ },
    ),
  );
  assert.deepEqual(result, { sessionId: 'ses_test', text: 'Answer', rejected: [] });
  assert.equal(created, 1);
  const order = mock.requests.map(r =>
    `${r.method} ${r.path.replace(/\?.*$/, '').replace(/^\/api\/session\/ses_test/, '')}`.replace(
      '/api/session',
      'create',
    ),
  );
  assert.deepEqual(order.slice(0, 5), ['GET /api/agent', 'POST create', 'GET ', 'PATCH ', 'POST /prompt']);
  assert.deepEqual(mock.requests[4]!.body.metadata, { aivi: { message: 'msg_t1' } });
  // The create-time model is read back; the mock created the session on it, so no switch is needed.
  assert.deepEqual(mock.requests[1]!.body.model, { id: 'gemini-3.8-flash', providerID: 'github-copilot' });
  assert.ok(!mock.requests.some(r => r.path.endsWith('/model')), 'a session created with the model needs no switch');
});

test('runTurn keeps the session on the agent file’s model, or on the pinned one', async t => {
  // An existing session that drifted (or predates this) is switched back before the prompt.
  const drifted = mockOpenCode({ sessionModel: { id: 'gpt-5.2', providerID: 'github-copilot' } });
  await withServer(t, drifted, client =>
    runTurn(client, { ...input, create: false }, { signal: AbortSignal.timeout(5000), events: quiet }),
  );
  const switched = drifted.requests.find(r => r.path.endsWith('/model'));
  assert.deepEqual(switched?.body, { model: { id: 'gemini-3.8-flash', providerID: 'github-copilot' } });
  assert.ok(
    drifted.requests.findIndex(r => r.path.endsWith('/model')) <
      drifted.requests.findIndex(r => r.path.endsWith('/prompt')),
  );
  // One already on it is left alone.
  const same = mockOpenCode({ sessionModel: { id: 'gemini-3.8-flash', providerID: 'github-copilot' } });
  await withServer(t, same, client =>
    runTurn(client, { ...input, create: false }, { signal: AbortSignal.timeout(5000), events: quiet }),
  );
  assert.ok(!same.requests.some(r => r.path.endsWith('/model')));
  // A pinned model (a conversation's /model) wins over the agent file, and skips the agent lookup.
  const pinned = mockOpenCode({ sessionModel: { id: 'gemini-3.8-flash', providerID: 'github-copilot' } });
  await withServer(t, pinned, client =>
    runTurn(
      client,
      { ...input, create: false, model: { providerID: 'openai', modelID: 'gpt-5.2', variant: 'high' } },
      { signal: AbortSignal.timeout(5000), events: quiet },
    ),
  );
  assert.deepEqual(pinned.requests.find(r => r.path.endsWith('/model'))?.body, {
    model: { providerID: 'openai', id: 'gpt-5.2', variant: 'high' },
  });
  assert.ok(!pinned.requests.some(r => r.path.startsWith('/api/agent')));
});

test('runTurn auto-rejects permission prompts by default and reports them', async t => {
  const mock = mockOpenCode({ pending: [{ id: 'per_1', action: 'external_directory', resources: ['/secret/**'] }] });
  const result = await withServer(t, mock, client =>
    runTurn(client, { ...input, create: false }, { signal: AbortSignal.timeout(5000), events: quiet }),
  );
  assert.deepEqual(result.rejected, [{ action: 'external_directory', resources: ['/secret/**'] }]);
  const reply = mock.requests.find(r => r.path.endsWith('/permission/per_1/reply'));
  assert.deepEqual(reply?.body, { decision: 'reject' });
});

test('runTurn with onPermission fail leaves the prompt pending and throws PermissionRequired', async t => {
  const mock = mockOpenCode({ pending: [{ id: 'per_2', action: 'shell', resources: ['rm -rf'] }] });
  await withServer(t, mock, client =>
    assert.rejects(
      runTurn(
        client,
        { ...input, create: false },
        { signal: AbortSignal.timeout(5000), events: quiet, onPermission: 'fail' },
      ),
      (error: unknown) => error instanceof PermissionRequired && error.requests[0]!.action === 'shell',
    ),
  );
  assert.ok(!mock.requests.some(r => r.path.includes('/reply')));
});

test('runTurn refuses a session whose agent changed', async t => {
  const mock = mockOpenCode({ agent: 'developer' });
  await withServer(t, mock, client =>
    assert.rejects(
      runTurn(
        client,
        { ...input, agent: 'developer', create: false },
        { signal: AbortSignal.timeout(5000), events: quiet },
      ),
      /no longer runs agent developer/,
    ),
  );
});

test('runTurn re-checks on the next session event when wait() returns before the context shows the finished turn', async t => {
  const mock = mockOpenCode({ contextLagsFor: 5 });
  const result = await withServer(t, mock, client =>
    runTurn(client, { ...input, create: false }, { signal: AbortSignal.timeout(5000), events: chatty }),
  );
  assert.equal(result.text, 'Answer');
  const contexts = mock.requests.filter(r => r.path.endsWith('/context')).length;
  assert.equal(contexts, 6, 'one context read per session event plus the final one; no timer between them');
});

test('a permission asked mid-turn arrives as an event and is answered by the policy, without polling', async t => {
  const events = fakeEvents();
  let listed = 0;
  const mock = mockOpenCode({
    waitUntil: () => {
      // The prompt is running; the agent asks for a permission. Only the event tells us.
      events.emit('ses_test', {
        type: 'permission.asked',
        data: { id: 'per_9', sessionID: 'ses_test', action: 'shell', resources: ['ls'] },
      });
    },
    onPermissionList: () => listed++,
  });
  const result = await withServer(t, mock, client =>
    runTurn(client, { ...input, create: false }, { signal: AbortSignal.timeout(5000), events }),
  );
  assert.deepEqual(result.rejected, [{ action: 'shell', resources: ['ls'] }]);
  assert.deepEqual(mock.requests.find(r => r.path.endsWith('/permission/per_9/reply'))?.body, { decision: 'reject' });
  assert.equal(listed, 1, 'permission.list is read once after the prompt, never in a loop');
  assert.equal(events.watchers, 1, 'the turn watched its session once and unwatched');
});
