import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema, taskSchema } from '@aivi/core';
import { connectOpenCode } from '../src/opencode.ts';
import { createExecutor } from '../src/runtime.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';

test('opencode.prompt jobs run a full verified turn and succeed with the final answer', async t => {
  const store = new Store(':memory:');
  const job = store.enqueue(
    taskSchema.parse({ kind: 'opencode.prompt', agent: 'librarian', directory: '/team', prompt: 'Read the handbook' }),
    'local-model',
    'request',
  );
  const received: {
    method: string;
    path: string;
    body: Record<string, any>;
    attached: string | null;
    auth: string | undefined;
  }[] = [];
  let promptId = '';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    received.push({
      method: req.method!,
      path: req.url!,
      body,
      attached: store.get(job.id).sessionId,
      auth: req.headers.authorization,
    });
    res.setHeader('content-type', 'application/json');
    const url = req.url!;
    if (url.endsWith('/wait')) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.endsWith('/permission') && req.method === 'GET') {
      res.end('{"data":[]}');
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
              agent: 'librarian',
              finish: 'stop',
              time: { created: 2, completed: 3 },
              content: [{ type: 'text', text: 'Handbook read.' }],
            },
            { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        data: { id: body.id ?? received[0]!.body.id, agent: 'librarian', location: { directory: '/team' } },
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } });
  // Verified against OpenCode 2.0.3: the server expects HTTP basic auth, never bearer tokens.
  const opencode = () => connectOpenCode(config.opencode, { OPENCODE_PASSWORD: 'secret' });
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor({ path: '/aivi.json', config, projects: [], sources: [] }, { store, opencode }),
  );
  scheduler.tick();
  await scheduler.drain();
  scheduler.tick();
  await scheduler.drain();
  const create = received.find(r => r.method === 'POST' && r.path === '/api/session')!;
  assert.equal(create.body.agent, 'librarian');
  assert.equal(create.attached, create.body.id, 'session id is persisted before the create request');
  assert.equal(create.auth, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
  assert.deepEqual(create.body.metadata, { aivi: { origin: 'job', job: job.id } });
  assert.equal(received.filter(r => r.path.endsWith('/prompt')).length, 1, 'a second tick must not resubmit');
  const done = store.get(job.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.result, { sessionId: create.body.id, text: 'Handbook read.', rejectedPermissions: [] });
  assert.ok(done.finishedAt);
});

test('an unreachable OpenCode blocks the job instead of failing the scheduler', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.enqueue(
    taskSchema.parse({ kind: 'opencode.prompt', agent: 'librarian', directory: '/team', prompt: 'hi' }),
    'local-model',
    'unreachable',
  );
  const config = configSchema.parse({ version: 1 });
  const opencode = async () => {
    throw new Error('No running OpenCode v2 service found');
  };
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor({ path: '/aivi.json', config, projects: [], sources: [] }, { store, opencode }),
  );
  scheduler.tick();
  await scheduler.drain();
  const result = store.get(job.id);
  assert.equal(result.state, 'blocked');
  assert.match(result.error ?? '', /No running OpenCode/);
  assert.equal(scheduler.stopped, false);
});

test('shell tasks run argv without a shell, capture output, and map exit codes to states', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1, stateDirectory: '/tmp' });
  const loaded = { path: '/aivi.json', config, projects: [], sources: [] };
  const opencode = async () => {
    throw new Error('not needed');
  };
  const ok = store.enqueue(
    taskSchema.parse({
      kind: 'shell',
      command: [process.execPath, '-e', 'console.log("hi $HOME"); console.error("warn")'],
    }),
    'local-model',
    'ok',
  );
  const bad = store.enqueue(
    taskSchema.parse({ kind: 'shell', command: [process.execPath, '-e', 'process.exit(3)'] }),
    'local-model',
    'bad',
  );
  const scheduler = new Scheduler(
    store,
    { ...config.scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } },
    createExecutor(loaded, { store, opencode }),
  );
  scheduler.tick();
  await scheduler.drain();
  const done = store.get(ok.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(
    done.result,
    { exitCode: 0, signal: null, stdout: 'hi $HOME\n', stderr: 'warn\n' },
    'no shell expansion',
  );
  const failed = store.get(bad.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error ?? '', /exited with 3/);
  assert.equal((failed.result as { exitCode: number }).exitCode, 3);
});

test('a shell task that exceeds its timeout is blocked, not failed', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1, stateDirectory: '/tmp' });
  const job = store.enqueue(
    taskSchema.parse({
      kind: 'shell',
      command: [process.execPath, '-e', 'setTimeout(()=>{}, 10000)'],
      timeoutMs: 1000,
    }),
    'local-model',
    'slow',
  );
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor(
      { path: '/aivi.json', config, projects: [], sources: [] },
      {
        store,
        opencode: async () => {
          throw new Error('x');
        },
      },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  assert.equal(store.get(job.id).state, 'blocked');
  assert.match(store.get(job.id).error ?? '', /killed by SIGTERM/);
});
