import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
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
});

/** Mock of the OpenCode 2.0.3 endpoints runTurn touches; the context shape matches the live server. */
function mockOpenCode(
  options: { pending?: { id: string; action: string; resources: string[] }[]; agent?: string } = {},
) {
  const requests: { method: string; path: string; body: Record<string, any> }[] = [];
  let pending = options.pending ?? [];
  let promptId = '';
  const agent = options.agent ?? 'librarian';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method!, path: req.url!, body });
    res.setHeader('content-type', 'application/json');
    const url = req.url!;
    if (url.endsWith('/permission/rules') || url.endsWith('/wait')) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.endsWith('/permission') && req.method === 'GET') {
      res.end(JSON.stringify({ data: pending }));
      return;
    }
    if (/\/permission\/[^/]+\/reply$/.test(url)) {
      pending = pending.filter(p => !url.includes(p.id));
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.endsWith('/prompt')) {
      promptId = body.id;
      res.end(JSON.stringify({ data: { id: body.id } }));
      return;
    }
    if (url.endsWith('/context')) {
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
    res.end(JSON.stringify({ data: { id: 'ses_test', agent: 'librarian', location: { directory: '/lib' } } }));
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
      { signal: AbortSignal.timeout(5000), pollMs: 10, onCreated: () => created++ },
    ),
  );
  assert.deepEqual(result, { sessionId: 'ses_test', text: 'Answer', rejected: [] });
  assert.equal(created, 1);
  const order = mock.requests.map(r =>
    `${r.method} ${r.path.replace(/^\/api\/session\/ses_test/, '')}`.replace('/api/session', 'create'),
  );
  assert.deepEqual(order.slice(0, 4), ['POST create', 'GET ', 'PUT /permission/rules', 'POST /prompt']);
  assert.deepEqual(mock.requests[3]!.body.metadata, { aivi: { message: 'msg_t1' } });
});

test('runTurn auto-rejects permission prompts by default and reports them', async t => {
  const mock = mockOpenCode({ pending: [{ id: 'per_1', action: 'external_directory', resources: ['/secret/**'] }] });
  const result = await withServer(t, mock, client =>
    runTurn(client, { ...input, create: false }, { signal: AbortSignal.timeout(5000), pollMs: 10 }),
  );
  assert.deepEqual(result.rejected, [{ action: 'external_directory', resources: ['/secret/**'] }]);
  const reply = mock.requests.find(r => r.path.endsWith('/permission/per_1/reply'));
  assert.deepEqual(reply?.body, { reply: 'reject' });
});

test('runTurn with onPermission fail leaves the prompt pending and throws PermissionRequired', async t => {
  const mock = mockOpenCode({ pending: [{ id: 'per_2', action: 'shell', resources: ['rm -rf'] }] });
  await withServer(t, mock, client =>
    assert.rejects(
      runTurn(
        client,
        { ...input, create: false },
        { signal: AbortSignal.timeout(5000), pollMs: 10, onPermission: 'fail' },
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
        { signal: AbortSignal.timeout(5000), pollMs: 10 },
      ),
      /no longer runs agent developer/,
    ),
  );
});
