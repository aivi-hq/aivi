import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, jobSchema } from '@aivi/core';
import type { HostModule, HostResources } from '../src/application.ts';
import { runHost } from '../src/application.ts';
import { ConfigurationError } from '../src/modules.ts';
import { createExecutor } from '../src/runtime.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { TaskRegistry } from '../src/tasks.ts';

const loaded = () => ({
  path: '/config',
  // "discover": these tests must never touch the developer's real OpenCode service.
  config: configSchema.parse({
    version: 1,
    host: { port: 0 },
    opencode: { lifecycle: 'discover' },
    search: { provider: 'qmd' },
  }),
  sources: [],
  projects: [],
});
const auth = { mode: 'token' as const, token: 'test-token-for-local-host-only' };
const noOpenCode = async () => {
  throw new Error('OpenCode must not be contacted in this test');
};

test('one host starts modules with shared services and stops them in reverse order before knowledge closes', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const events: string[] = [];
  const knowledge = {
    async index() {
      events.push('index');
    },
    async search() {
      return [];
    },
    async close() {
      events.push('knowledge.stop');
    },
  };
  const modules: HostModule[] = ['discord', 'future-module'].map(id => ({
    id,
    async start(services) {
      assert.equal(services.store, store);
      assert.equal(services.knowledge, knowledge);
      assert.equal(typeof services.opencode, 'function');
      assert.equal(typeof services.log.info, 'function');
      events.push(`${id}.start`);
      return {
        async stop() {
          assert.equal(services.signal.aborted, true);
          events.push(`${id}.stop`);
        },
      };
    },
  }));
  const abort = new AbortController();
  const resources = async (): Promise<HostResources> => ({
    knowledge,
    browser: {
      async execute() {
        return {};
      },
      async close() {
        events.push('browser.stop');
      },
    },
  });
  await runHost({
    loaded: loaded(),
    store,
    resources,
    modules,
    auth,
    signal: abort.signal,
    onReady: () => {
      events.push('ready');
      abort.abort();
    },
  });
  assert.deepEqual(events, [
    'index',
    'discord.start',
    'future-module.start',
    'ready',
    'future-module.stop',
    'discord.stop',
    'browser.stop',
    'knowledge.stop',
  ]);
  store.acquireDaemon('another');
  store.releaseDaemon('another');
});

test('a configuration error at module start unwinds earlier modules and releases ownership', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const events: string[] = [];
  const resources = async () => ({
    knowledge: {
      async search() {
        return [];
      },
      async index() {},
      async close() {
        events.push('close');
      },
    },
  });
  const modules: HostModule[] = [
    {
      id: 'first',
      async start() {
        return {
          async stop() {
            events.push('stop');
          },
        };
      },
    },
    {
      id: 'broken',
      async start() {
        throw new ConfigurationError('start failed');
      },
    },
  ];
  await assert.rejects(
    runHost({ loaded: loaded(), store, resources, modules, auth, signal: new AbortController().signal }),
    /start failed/,
  );
  assert.deepEqual(events, ['stop', 'close']);
  store.acquireDaemon('another');
  store.releaseDaemon('another');
});

const sweepJob = () =>
  jobSchema.parse({
    id: 'linear-sweep',
    cron: '0 4 * * *',
    task: { kind: 'invocation', name: 'linear.sweep' },
  });

test('a composed module seeds its system jobs and claims operations under its own id', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const resources = async (): Promise<HostResources> => ({
    knowledge: {
      async search() {
        return [];
      },
      async index() {},
      async close() {},
    },
  });
  const modules: HostModule[] = [
    {
      id: 'linear',
      jobs: () => [sweepJob()],
      async start(services) {
        services.tasks.claim('linear.sweep', async () => ({ state: 'succeeded', result: null }));
        // The door carries this module's id: a host operation is not its name to claim.
        assert.throws(
          () => services.tasks.claim('dreaming', async () => ({ state: 'succeeded', result: null })),
          ConfigurationError,
        );
        return { async stop() {} };
      },
    },
  ];
  const abort = new AbortController();
  await runHost({
    loaded: loaded(),
    store,
    resources,
    modules,
    auth,
    signal: abort.signal,
    onReady: () => abort.abort(),
  });
  const seeded = store.job('linear-sweep');
  assert.equal(seeded.source, 'system');
  assert.equal(seeded.spec.task.kind, 'invocation');
});

test('two system job definitions sharing an id is fatal, not a silent overwrite', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const resources = async () => ({
    knowledge: {
      async search() {
        return [];
      },
      async index() {},
      async close() {},
    },
  });
  const modules: HostModule[] = ['first', 'second'].map(id => ({
    id,
    jobs: () => [sweepJob()],
    async start() {
      return { async stop() {} };
    },
  }));
  await assert.rejects(
    runHost({ loaded: loaded(), store, resources, modules, auth, signal: new AbortController().signal }),
    /Two system job definitions claim job id linear-sweep/,
  );
  store.acquireDaemon('another');
  store.releaseDaemon('another');
});

test('two modules claiming one operation name take the host down with the clash in the message', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const resources = async () => ({
    knowledge: {
      async search() {
        return [];
      },
      async index() {},
      async close() {},
    },
  });
  const modules: HostModule[] = ['first', 'second'].map(id => ({
    id,
    async start(services) {
      services.tasks.claim('shared.thing', async () => ({ state: 'succeeded', result: null }));
      return { async stop() {} };
    },
  }));
  await assert.rejects(
    runHost({ loaded: loaded(), store, resources, modules, auth, signal: new AbortController().signal }),
    /Operation "shared.thing" is already claimed by first/,
  );
  store.acquireDaemon('another');
  store.releaseDaemon('another');
});

test('the failure that ended the host survives a failing cleanup step', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const resources = async () => ({
    knowledge: {
      async search() {
        return [];
      },
      async index() {},
      async close() {
        throw new Error('close failed');
      },
    },
  });
  const modules: HostModule[] = [
    {
      id: 'broken',
      async start() {
        throw new ConfigurationError('start failed');
      },
    },
  ];
  await assert.rejects(
    runHost({ loaded: loaded(), store, resources, modules, auth, signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.map(e => (e as Error).message).join(',') === 'start failed,close failed',
  );
  store.acquireDaemon('another');
  store.releaseDaemon('another');
});

test('duplicate host is rejected before initializing shared services', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.acquireDaemon('existing');
  let called = false;
  const resources = async () => {
    called = true;
    throw new Error('must not run');
  };
  await assert.rejects(
    runHost({ loaded: loaded(), store, resources, auth, signal: new AbortController().signal }),
    /already owns/,
  );
  assert.equal(called, false);
  store.releaseDaemon('existing');
});

test('scheduled knowledge indexing uses the same injected service', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let indexed = 0;
  const knowledge = {
    async index() {
      indexed++;
      return { indexed: 2 };
    },
    async search() {
      return [];
    },
    async close() {},
  };
  const config = loaded();
  const job = store.enqueue({ kind: 'invocation', name: 'knowledge.index' }, 'local-model', 'index');
  const scheduler = new Scheduler(
    store,
    config.config.scheduler,
    createExecutor(config, {
      store,
      knowledge,
      events: { watch: () => () => {} },
      opencode: noOpenCode,
      tasks: new TaskRegistry(),
    }),
  );
  scheduler.tick();
  await scheduler.drain();
  assert.equal(indexed, 1);
  assert.equal(store.run(job.id).state, 'succeeded');
});

test('the host sleeps until the next due instant and a wake dispatches a job created meanwhile at once', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const knowledge = {
    async index() {},
    async search() {
      return [];
    },
    async close() {},
  };
  const ran: number[] = [];
  const abort = new AbortController();
  let woke: (() => void) | undefined;
  const module: HostModule = {
    id: 'probe',
    async start(services) {
      woke = services.wake;
      return { async stop() {} };
    },
  };
  // Nothing periodic exists: only the wake can make the job below run.
  const config = configSchema.parse({
    version: 1,
    host: { port: 0 },
    opencode: { lifecycle: 'discover' },
  });
  const host = runHost({
    loaded: { path: '/config', config, sources: [], projects: [] },
    store,
    resources: async () => ({ knowledge }),
    modules: [module],
    auth,
    signal: abort.signal,
    onReady: () => {
      // Created after the loop went to sleep: only a wake makes it run before the safety-net tick.
      store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', 'while-asleep');
      woke!();
    },
  });
  const started = Date.now();
  while (store.counts().succeeded < 1 && Date.now() - started < 5000) await new Promise(r => setTimeout(r, 20));
  ran.push(Date.now() - started);
  abort.abort();
  await host;
  assert.equal(store.counts().succeeded, 1, 'the job ran on the wake; nothing periodic exists to fall back on');
  assert.ok(ran[0]! < 4000, `ran after ${ran[0]}ms`);
});

test('a module whose start fails is retried with backoff while the host serves; status shows it degraded', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const knowledge = {
    async index() {},
    async search() {
      return [];
    },
    async close() {},
  };
  let attempts = 0;
  const flaky: HostModule = {
    id: 'flaky',
    async start() {
      attempts++;
      if (attempts < 3) throw new Error(`Unexpected server response: 503 (attempt ${attempts})`);
      return { async stop() {} };
    },
  };
  const steady: HostModule = {
    id: 'steady',
    async start() {
      return { async stop() {} };
    },
  };
  const abort = new AbortController();
  let address: { port: number } | undefined;
  const host = runHost({
    loaded: loaded(),
    store,
    resources: async () => ({ knowledge }),
    modules: [flaky, steady],
    auth,
    signal: abort.signal,
    moduleRetry: { baseMs: 20, maxMs: 100 },
    onReady: a => {
      address = a as { port: number };
    },
  });
  const fetchStatus = async () =>
    (await (
      await fetch(`http://127.0.0.1:${address!.port}/v1/status`, { headers: { authorization: `Bearer ${auth.token}` } })
    ).json()) as {
      modules: { id: string; state: string; attempts: number; lastError: string | null }[];
    };
  const started = Date.now();
  while (!address && Date.now() - started < 5000) await new Promise(r => setTimeout(r, 10));
  assert.ok(address, 'the host is ready although a module failed to start');
  const first = await fetchStatus();
  assert.deepEqual(
    first.modules.map(m => [m.id, m.state]),
    [
      ['flaky', 'degraded'],
      ['steady', 'running'],
    ],
    'readiness never waits for retries; later modules still start',
  );
  assert.match(first.modules[0]!.lastError ?? '', /503/);
  while (attempts < 3 && Date.now() - started < 5000) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30));
  const later = await fetchStatus();
  assert.deepEqual(later.modules.find(m => m.id === 'flaky')!.state, 'running');
  assert.equal(later.modules.find(m => m.id === 'flaky')!.attempts, 3);
  abort.abort();
  await host;
});
