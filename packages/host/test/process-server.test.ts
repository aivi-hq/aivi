/** The server boot as a unit: what it builds the host from, what it hands the
 *  host to run, what it tells the log and a pipe when the host listens, and how
 *  the stop signals reach it. The host, the home's context, the plugin
 *  registry and the knowledge service are module mocks; the signals and the
 *  terminal are recorded. */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import { recorder } from './support.ts';

type HostOptions = {
  loaded: unknown;
  store: unknown;
  modules: { id: string }[];
  protectedEnv: string[];
  compose: (configPath: string) => Promise<unknown>;
  log: unknown;
  signal: AbortSignal;
  resources: () => Promise<unknown>;
  onReady: (address: unknown) => void;
};

/** One boot's world: what the mocks answer and what they were asked. */
const scene = {
  loaded: { sources: [{ id: 'handbook' }, { id: 'adrs' }] } as unknown,
  registry: { entries: [] } as unknown,
  protectedEnv: ['DISCORD_BOT_TOKEN'],
  modules: [{ id: 'channel-discord' }, { id: 'tracker-linear' }],
  store: { name: 'the home store' } as unknown,
  log: recorder().log,
  runHost: async (_options: HostOptions): Promise<void> => {},
  built: [] as unknown[][],
  composed: [] as unknown[][],
  knowledge: [] as unknown[][],
};

mock.module('../src/application.ts', { exports: { runHost: (options: HostOptions) => scene.runHost(options) } });
mock.module('../src/cli/context.ts', {
  exports: {
    context: async () => ({
      loaded: scene.loaded,
      registry: scene.registry,
      protectedEnv: scene.protectedEnv,
      log: scene.log,
    }),
    home: () => '/work/aivi',
    withStore: async (_loaded: unknown, work: (store: unknown) => Promise<void>) => work(scene.store),
  },
});
mock.module('../src/cli/registry.ts', {
  exports: {
    buildModules: async (...args: unknown[]) => {
      scene.built.push(args);
      return scene.modules;
    },
    loadComposedConfig: async (...args: unknown[]) => {
      scene.composed.push(args);
      return 'the composed config';
    },
  },
});
mock.module('@aivi/knowledge', {
  exports: {
    createKnowledgeService: async (...args: unknown[]) => {
      scene.knowledge.push(args);
      return 'the knowledge service';
    },
  },
});
const { startServer } = await import('../src/server.ts');

/** The stop signals and the terminal, replaced for one test: the handlers the boot registers are kept, and so are the lines it prints. */
function terminal(t: TestContext, attached: boolean) {
  const handlers = new Map<string, () => void>();
  const removed: [string, () => void][] = [];
  const once = process.once.bind(process);
  const remove = process.removeListener.bind(process);
  const watched = (event: string) => event === 'SIGINT' || event === 'SIGTERM';
  t.mock.method(process, 'once', ((event: string, handler: () => void) => {
    if (!watched(event)) return once(event, handler);
    handlers.set(event, handler);
    return process;
  }) as never);
  t.mock.method(process, 'removeListener', ((event: string, handler: () => void) => {
    if (!watched(event)) return remove(event, handler);
    removed.push([event, handler]);
    return process;
  }) as never);
  const printed = t.mock.method(console, 'log', () => {});
  const was = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: attached, configurable: true });
  t.after(() => {
    if (was) Object.defineProperty(process.stdout, 'isTTY', was);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });
  return { handlers, removed, printed: () => printed.mock.calls.map(call => call.arguments[0]) };
}

function boot(log = recorder()) {
  scene.log = log.log;
  scene.built = [];
  scene.composed = [];
  scene.knowledge = [];
  return log;
}

test('the host is run with the home’s config, its modules, its store and secrets, and a way to compose and open knowledge', async t => {
  terminal(t, false);
  boot();
  let given: HostOptions | undefined;
  let resources: unknown;
  let composed: unknown;
  scene.runHost = async options => {
    given = options;
    resources = await options.resources();
    composed = await options.compose('/work/aivi/config.json');
  };
  await startServer();
  assert.ok(given);
  assert.equal(given.loaded, scene.loaded);
  assert.equal(given.store, scene.store);
  assert.equal(given.modules, scene.modules);
  assert.equal(given.protectedEnv, scene.protectedEnv);
  assert.equal(given.log, scene.log);
  assert.deepEqual(
    scene.built,
    [[scene.registry, scene.loaded, '/work/aivi']],
    'the modules come from the plugin list of the home',
  );
  assert.deepEqual(resources, { knowledge: 'the knowledge service' });
  assert.deepEqual(scene.knowledge, [[scene.loaded, undefined, scene.log]], 'knowledge logs under its own category');
  assert.equal(composed, 'the composed config');
  assert.deepEqual(
    scene.composed,
    [['/work/aivi', '/work/aivi/config.json']],
    'the referee is the home’s composed schema',
  );
});

for (const [name, attached] of [
  ['a pipe', false],
  ['a person at a terminal', true],
] as const)
  test(`when the host listens the record goes to the log, and to ${name === 'a pipe' ? 'the pipe as one JSON line' : 'nobody else: a terminal reads the log'}`, async t => {
    const out = terminal(t, attached);
    const { said } = boot();
    scene.runHost = async options => options.onReady({ host: '127.0.0.1', port: 4321 });
    await startServer();
    const ready = {
      listening: { host: '127.0.0.1', port: 4321 },
      modules: ['channel-discord', 'tracker-linear'],
      sources: 2,
    };
    assert.deepEqual(
      said('info').map(line => [line.event, line.listening, line.modules, line.sources]),
      [['host.listening', ready.listening, ready.modules, ready.sources]],
    );
    assert.deepEqual(out.printed(), attached ? [] : [JSON.stringify(ready)]);
  });

test('a stop signal aborts the host and says so, and both signals are given back when the host is done', async t => {
  const out = terminal(t, false);
  const { said } = boot();
  let signal: AbortSignal | undefined;
  scene.runHost = async options => {
    signal = options.signal;
    assert.equal(signal.aborted, false);
    assert.deepEqual([...out.handlers.keys()].sort(), ['SIGINT', 'SIGTERM']);
    out.handlers.get('SIGINT')!();
  };
  await startServer();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(
    said('info').map(line => line.event),
    ['host.stopping'],
  );
  assert.deepEqual(
    out.removed.map(([event, handler]) => [event, handler === out.handlers.get(event)]),
    [
      ['SIGINT', true],
      ['SIGTERM', true],
    ],
  );
});

test('a host that fails still gives the signals back, and the failure is the boot’s', async t => {
  const out = terminal(t, false);
  boot();
  scene.runHost = async () => {
    throw new Error('Another host owns this database');
  };
  await assert.rejects(startServer(), /Another host owns this database/);
  assert.deepEqual(
    out.removed.map(([event]) => event),
    ['SIGINT', 'SIGTERM'],
  );
});
