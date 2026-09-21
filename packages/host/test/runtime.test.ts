import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema, taskSchema } from '@aivi/core';
import { connectOpenCode } from '../src/opencode.ts';
import { createExecutor } from '../src/runtime.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { TaskRegistry } from '../src/tasks.ts';

const quiet = { watch: () => () => {} };

test('opencode.prompt jobs run a full verified turn and succeed with the final answer', async t => {
  const store = new Store(':memory:');
  const job = store.enqueue(
    taskSchema.parse({ kind: 'prompt', agent: 'librarian', directory: '/team', prompt: 'Read the handbook' }),
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
      attached: store.run(job.id).sessionId,
      auth: req.headers.authorization,
    });
    res.setHeader('content-type', 'application/json');
    const url = req.url!;
    if (url.startsWith('/api/agent'))
      return void res.end(JSON.stringify({ data: [{ id: 'librarian', name: 'librarian' }] }));
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
    createExecutor(
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      { store, events: quiet, opencode, tasks: new TaskRegistry() },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  scheduler.tick();
  await scheduler.drain();
  const create = received.find(r => r.method === 'POST' && r.path === '/api/session')!;
  assert.equal(create.body.agent, 'librarian');
  assert.equal(create.attached, create.body.id, 'session id is persisted before the create request');
  assert.equal(create.auth, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
  assert.deepEqual(create.body.metadata, { aivi: { origin: 'job', run: job.id } });
  assert.equal(received.filter(r => r.path.endsWith('/prompt')).length, 1, 'a second tick must not resubmit');
  const done = store.run(job.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.result, { sessionId: create.body.id, text: 'Handbook read.', rejectedPermissions: [] });
  assert.ok(done.finishedAt);
});

test('an unreachable OpenCode fails the job: nothing external happened, so the next occurrence retries', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.enqueue(
    taskSchema.parse({ kind: 'prompt', agent: 'librarian', directory: '/team', prompt: 'hi' }),
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
    createExecutor(
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      { store, events: quiet, opencode, tasks: new TaskRegistry() },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  const result = store.run(job.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.sessionId, null, 'no session id is attached when no request was made');
  assert.match(result.error ?? '', /not started: No running OpenCode/);
  assert.equal(scheduler.stopped, false);
});

test('a turn that times out while session.wait is pending reports the timeout, not the SDK transport wrapper', async t => {
  const store = new Store(':memory:');
  const job = store.enqueue(
    taskSchema.parse({ kind: 'prompt', agent: 'librarian', directory: '/team', prompt: 'slow' }),
    'local-model',
    'slow-turn',
  );
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/api/agent'))
      return void res.end(JSON.stringify({ data: [{ id: 'librarian', name: 'librarian' }] }));
    if (req.url!.endsWith('/wait')) return; // never answers: the turn is still running
    if (req.url!.endsWith('/permission') && req.method === 'GET') return void res.end('{"data":[]}');
    if (req.url!.endsWith('/prompt')) return void res.end('{"data":{"id":"m"}}');
    res.end(JSON.stringify({ data: { id: 'x', agent: 'librarian', location: { directory: '/team' } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } });
  const execute = createExecutor(
    {
      path: '/aivi.json',
      config,
      projects: [],
      sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
    },
    { store, events: quiet, opencode: () => connectOpenCode(config.opencode, {}), tasks: new TaskRegistry() },
  );
  // Below the schema minimum on purpose: the executor is called directly to keep the test fast.
  assert.equal(job.task.kind, 'prompt');
  const outcome = await execute(
    { ...job, task: { ...job.task, timeoutMs: 300 } },
    { signal: new AbortController().signal, attachSession() {} },
  );
  assert.equal(outcome.state, 'blocked');
  assert.match(outcome.reason ?? '', /^Turn exceeded 300ms\. Inspect session ses_aivi_/);
});

test('a prompt job whose session cannot be created fails; nothing was submitted to an agent', async t => {
  const store = new Store(':memory:');
  const job = store.enqueue(
    taskSchema.parse({ kind: 'prompt', agent: 'librarian', directory: '/team', prompt: 'hi' }),
    'local-model',
    'no-session',
  );
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } });
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor(
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      { store, events: quiet, opencode: () => connectOpenCode(config.opencode, {}), tasks: new TaskRegistry() },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  const result = store.run(job.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error ?? '', /^Turn not started: /);
});

test('a dreaming job persists its session id before the first request and blocks if that request fails', async t => {
  const store = new Store(':memory:');
  const job = store.enqueue(
    taskSchema.parse({
      kind: 'invocation',
      name: 'dreaming',
      args: { directory: '/lib', memoryDirectory: '/lib/memory' },
    }),
    'local-model',
    'dream',
  );
  let attachedAtRequest: string | null | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    attachedAtRequest ??= store.run(job.id).sessionId;
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } });
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor(
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      { store, events: quiet, opencode: () => connectOpenCode(config.opencode, {}), tasks: new TaskRegistry() },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  const expected = `ses_aivi_${job.id.replaceAll('-', '')}`;
  assert.equal(attachedAtRequest, expected, 'session id is on the job row before OpenCode is asked anything');
  const result = store.run(job.id);
  assert.equal(result.state, 'blocked');
  assert.equal(result.sessionId, expected);
  assert.match(result.error ?? '', /Inspect session ses_aivi_/);
});

test('shell tasks run argv without a shell, capture output, and map exit codes to states', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1, stateDirectory: '/tmp' });
  const loaded = {
    path: '/aivi.json',
    config,
    projects: [],
    sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
  };
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
    createExecutor(loaded, { store, events: quiet, opencode, tasks: new TaskRegistry() }),
  );
  scheduler.tick();
  await scheduler.drain();
  const done = store.run(ok.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(
    done.result,
    { exitCode: 0, signal: null, stdout: 'hi $HOME\n', stderr: 'warn\n' },
    'no shell expansion',
  );
  const failed = store.run(bad.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error ?? '', /exited with 3/);
  assert.equal((failed.result as { exitCode: number }).exitCode, 3);
});

test('shell tasks inherit the host environment minus aivi secrets and .env keys; task env is merged on top', async t => {
  const store = new Store(':memory:');
  const previous = { AIVI_TOKEN: process.env.AIVI_TOKEN, FROM_DOTENV: process.env.FROM_DOTENV };
  process.env.AIVI_TOKEN = 'not-aivis-secret-anymore';
  process.env.FROM_DOTENV = 'dotenv-secret';
  t.after(() => {
    store.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const config = configSchema.parse({ version: 1, stateDirectory: '/tmp' });
  const job = store.enqueue(
    taskSchema.parse({
      kind: 'shell',
      command: [
        process.execPath,
        '-e',
        'const e=process.env; console.log(JSON.stringify({token:e.AIVI_TOKEN??null,dotenv:e.FROM_DOTENV??null,path:typeof e.PATH,extra:e.EXTRA}))',
      ],
      env: { EXTRA: 'from-task' },
    }),
    'local-model',
    'env',
  );
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor(
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      {
        store,
        events: quiet,
        tasks: new TaskRegistry(),
        protectedEnv: ['FROM_DOTENV'],
        opencode: async () => {
          throw new Error('x');
        },
      },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  const done = store.run(job.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(JSON.parse((done.result as { stdout: string }).stdout), {
    token: 'not-aivis-secret-anymore',
    dotenv: null,
    path: 'string',
    extra: 'from-task',
  });
});

test('a command that cannot start fails instead of blocking capacity', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1, stateDirectory: '/tmp' });
  const job = store.enqueue(
    taskSchema.parse({ kind: 'shell', command: ['/nonexistent/aivi-binary', '--flag'] }),
    'local-model',
    'missing',
  );
  const scheduler = new Scheduler(
    store,
    config.scheduler,
    createExecutor(
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      {
        store,
        events: quiet,
        tasks: new TaskRegistry(),
        opencode: async () => {
          throw new Error('x');
        },
      },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  const result = store.run(job.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error ?? '', /could not start: \/nonexistent\/aivi-binary/);
  assert.match((result.result as { stderr: string }).stderr, /ENOENT/);
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
      {
        path: '/aivi.json',
        config,
        projects: [],
        sources: [{ id: 'memory', path: '/lib', kind: 'memory' as const, scope: 'core' as const }],
      },
      {
        store,
        events: quiet,
        tasks: new TaskRegistry(),
        opencode: async () => {
          throw new Error('x');
        },
      },
    ),
  );
  scheduler.tick();
  await scheduler.drain();
  assert.equal(store.run(job.id).state, 'blocked');
  assert.match(store.run(job.id).error ?? '', /killed by SIGTERM/);
});

test('invocations dispatch to their claimant: the host claims its five, an unclaimed name fails with its name', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1 });
  const tasks = new TaskRegistry();
  const execute = createExecutor(
    { path: '/aivi.json', config, projects: [], sources: [] },
    {
      store,
      events: quiet,
      tasks,
      opencode: async () => {
        throw new Error('unused');
      },
    },
  );
  assert.deepEqual(
    tasks
      .claimed()
      .map(c => c.name)
      .sort(),
    ['dreaming', 'knowledge.index', 'projects.sync', 'runs.prune', 'system.check'],
    'the host claims its own system operations like any other claimant',
  );
  const job = store.enqueue(taskSchema.parse({ kind: 'invocation', name: 'linear.sweep' }), 'local-model', 'sweep');
  const context = { signal: new AbortController().signal, attachSession() {} };
  const unclaimed = await execute({ ...job, id: 'run-unclaimed' }, context);
  assert.equal(unclaimed.state, 'failed');
  assert.match(unclaimed.reason ?? '', /Nothing claims the operation "linear.sweep"/);
  let sweeps = 0;
  tasks.forModule('linear').claim('linear.sweep', async () => {
    sweeps++;
    return { state: 'succeeded', result: { removed: 1 } };
  });
  const done = await execute({ ...job, id: 'run-claimed' }, context);
  assert.equal(sweeps, 1);
  assert.deepEqual(done.result, { removed: 1 });
});
