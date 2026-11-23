/** The composition root as a unit. The things `runHost` builds around the
 *  host's own state are replaced where they reach the outside: OpenCode's
 *  discovery, the HTTP listener and its exec door, and the ticket
 *  orchestrator are module mocks that record how they were built; the store,
 *  the dispatcher, the scheduler and the channel router are the real ones over
 *  an in-memory database. Nothing here binds a port or reaches a service. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { configSchema, jobSchema, type LoadedConfig, promptDefaults } from '@aivi/core';
import type { ChannelModule } from '@aivi/plugin/channel';
import type { AiviModule, AiviServices } from '@aivi/plugin/module';
import type { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { RunLedger } from '../src/orchestrator/ledger.ts';
import { Store } from '../src/store.ts';
import { recorder } from './support.ts';

/** The listener: it never binds, it remembers where it was told to. */
class FakeServer extends EventEmitter {
  listening = false;
  bound: { port: number; bind: string } | undefined;
  listen(port: number, bind: string, ready: () => void) {
    this.bound = { port, bind };
    this.listening = true;
    scene.healthAtListen = scene.apis.at(-1)?.health();
    ready();
    return this;
  }
  address() {
    return { port: 4321 };
  }
  close(done: () => void) {
    this.listening = false;
    scene.closed++;
    done();
    return this;
  }
}

/** The orchestrator: it keeps how it was built and answers the host's questions from the scene. */
class FakeOrchestrator {
  readonly options: Record<string, any>;
  readonly leaseEnded = mock.fn(async (..._ended: unknown[]) => {});
  readonly recover = mock.fn(async () => {});
  readonly runBySession = mock.fn((_session: string) => scene.run);
  readonly tracker = mock.fn((_id: string) => scene.tracker);
  readonly wake = mock.fn(async (_project: string) => {});
  constructor(options: Record<string, any>) {
    this.options = options;
    scene.orchestrators.push(this);
  }
  tools() {
    return scene.workerTools;
  }
}

/** One host's world: what the mocks answer, and what they were asked. */
const scene = {
  client: undefined as unknown,
  restarted: false,
  restartFailure: undefined as unknown,
  restarts: [] as unknown[],
  discovered: [] as { config: unknown; env: unknown; hooks: { onStart(reason: string): void }; log: unknown }[],
  apis: [] as Record<string, any>[],
  healthAtListen: undefined as unknown,
  servers: [] as FakeServer[],
  execs: [] as { server: unknown; deps: Record<string, any> }[],
  closed: 0,
  resourcesOpened: 0,
  orchestrators: [] as FakeOrchestrator[],
  workerTools: [] as { descriptor: unknown; handler: unknown }[],
  run: undefined as unknown,
  tracker: undefined as unknown,
};

mock.module('../src/opencode.ts', {
  exports: {
    connectOpenCode: async (config: unknown, env: unknown, hooks: { onStart(reason: string): void }, log: unknown) => {
      scene.discovered.push({ config, env, hooks, log });
      return scene.client;
    },
    restartOpenCode: async (config: unknown) => {
      scene.restarts.push(config);
      if (scene.restartFailure) throw scene.restartFailure;
      return scene.restarted;
    },
  },
});
mock.module('../src/api/app.ts', {
  exports: {
    createApp: (options: Record<string, any>) => {
      scene.apis.push(options);
      return { app: options };
    },
    serveApp: () => {
      const server = new FakeServer();
      scene.servers.push(server);
      return server;
    },
  },
});
mock.module('../src/api/exec.ts', {
  exports: {
    attachExec: (server: unknown, deps: Record<string, any>) => {
      scene.execs.push({ server, deps });
    },
  },
});
mock.module('../src/orchestrator/orchestrator.ts', { exports: { Orchestrator: FakeOrchestrator } });
const { runHost } = await import('../src/application.ts');

const unreachable = async (): Promise<never> => {
  throw new Error('OpenCode must not be contacted in this test');
};
const knowledge = { index: async () => ({ indexed: 0 }), search: async () => [], close: async () => {} };

interface Options {
  config?: Record<string, unknown>;
  modules?: AiviModule[];
  /** `false`: the host discovers OpenCode itself, through the mocked `connectOpenCode`. */
  opencode?: false;
  /** What the mocks answer, from the first question on. */
  answers?: Partial<Pick<typeof scene, 'client' | 'restarted' | 'restartFailure' | 'workerTools' | 'run' | 'tracker'>>;
  /** Run against the store before the host starts: seeded jobs, a ledger row, a mock. */
  seed?: (store: Store) => void;
  /** An already-given stop signal. */
  stopped?: boolean;
  /** The referee `aivi_config` writes are checked with; the boot hands it in. */
  compose?: (configPath: string) => Promise<unknown>;
  sources?: LoadedConfig['sources'];
  projects?: LoadedConfig['projects'];
  home?: string;
}

/** A host over an in-memory store. `ready` settles when it serves; `stop()` ends it and waits for it. */
function host(t: TestContext, options: Options = {}) {
  Object.assign(scene, {
    client: { session: { active: async () => ({}) } },
    restarted: false,
    restartFailure: undefined,
    restarts: [],
    discovered: [],
    apis: [],
    healthAtListen: undefined,
    servers: [],
    execs: [],
    closed: 0,
    resourcesOpened: 0,
    orchestrators: [],
    workerTools: [],
    run: undefined,
    tracker: undefined,
    ...options.answers,
  });
  const store = new Store(':memory:');
  options.seed?.(store);
  const abort = new AbortController();
  if (options.stopped) abort.abort();
  const { log, said, next } = recorder();
  const config = configSchema.parse({
    version: 1,
    host: { port: 0 },
    opencode: { lifecycle: 'discover' },
    scheduler: { retention: false, projectsSync: false },
    ...options.config,
  });
  const loaded: LoadedConfig = {
    path: join(options.home ?? '/work/aivi', 'config.json'),
    config,
    sources: options.sources ?? [],
    projects: options.projects ?? [],
  };
  const ready = Promise.withResolvers<void>();
  const done = runHost({
    loaded,
    store,
    resources: async () => {
      scene.resourcesOpened++;
      return { knowledge };
    },
    modules: options.modules ?? [],
    signal: abort.signal,
    log,
    ...(options.opencode === false ? {} : { opencode: unreachable }),
    ...(options.compose ? { compose: options.compose } : {}),
    onReady: () => ready.resolve(),
  });
  done.catch(() => {});
  // However the test ended, the host is stopped and has let go of the store before the store closes.
  t.after(async () => {
    abort.abort();
    await done.catch(() => {});
    store.close();
  });
  return {
    store,
    loaded,
    abort,
    said,
    next,
    done,
    ready: ready.promise,
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}

/** A module that does nothing but keep the services it was started with. */
function probe(id = 'probe') {
  const seen = Promise.withResolvers<AiviServices>();
  const module: AiviModule = {
    id,
    async start(services) {
      seen.resolve(services);
      return { async stop() {} };
    },
  };
  return { module, services: seen.promise };
}

/** A host that is up, with a probe among its modules: the services a module is given, and the host that gave them. */
async function serving(t: TestContext, options: Options = {}) {
  const p = probe();
  const w = host(t, { ...options, modules: [p.module, ...(options.modules ?? [])] });
  const services = await p.services;
  await w.ready;
  return { w, services };
}

/** A module that registers one chat platform with the channel router. */
function channel(platform: string, over: Partial<ChannelModule> = {}): AiviModule {
  return {
    id: `channel-${platform}`,
    async start(services) {
      services.channels.register({
        id: platform,
        accepts: () => true,
        ownsSession: () => false,
        channelOf: async () => undefined,
        reenter: async () => {},
        post: async () => {},
        ...over,
      });
      return { async stop() {} };
    },
  };
}

test('a module hears every wake until it stops listening', async t => {
  const { w, services } = await serving(t);
  const heard: string[] = [];
  const stopListening = services.onWake(() => heard.push('woke'));
  services.wake();
  services.wake();
  stopListening();
  services.wake();
  assert.deepEqual(heard, ['woke', 'woke']);
  await w.stop();
});

test('a failure a module cannot recover from stops the host, and the first failure is the one it ends with', async t => {
  const { w, services } = await serving(t);
  const first = new Error('the socket died');
  services.fail(first);
  services.fail(new Error('and then the second'));
  await assert.rejects(w.done, (error: unknown) => error === first);
  assert.deepEqual(
    w.said('error').map(line => [line.event, line.error]),
    [['host.failed', first]],
    'one failure is said, however many follow it',
  );
});

test('an error from the listener after it opened stops the host with that error', async t => {
  const w = host(t);
  await w.ready;
  const failure = new Error('EMFILE: too many open files');
  scene.servers[0]!.emit('error', failure);
  await assert.rejects(w.done, (error: unknown) => error === failure);
  assert.equal(scene.closed, 1, 'the listener is closed on the way out');
});

test('a host that is asked to stop before it starts never takes the daemon lock or opens its resources', async t => {
  const w = host(t, { stopped: true });
  await assert.rejects(w.done, { name: 'AbortError' });
  w.store.acquireDaemon('another host');
  assert.equal(scene.resourcesOpened, 0);
  assert.equal(scene.servers.length, 0, 'no listener was made');
});

test('without a client of its own the host discovers OpenCode from the config and the environment, and logs a service it starts', async t => {
  const { w, services } = await serving(t, { opencode: false });
  assert.equal(await services.opencode(), scene.client);
  const found = scene.discovered.at(-1)!;
  assert.equal(found.config, w.loaded.config.opencode);
  assert.equal(found.env, process.env);
  found.hooks.onStart('version-mismatch');
  assert.deepEqual(
    w
      .said('info')
      .filter(line => line.event === 'opencode.started')
      .map(line => line.reason),
    ['version-mismatch'],
  );
  await w.stop();
});

test('a service the host owns is restarted before any module starts', async t => {
  const order: string[] = [];
  const first: AiviModule = {
    id: 'first',
    async start() {
      order.push(`start after ${scene.restarts.length} restart(s)`);
      return { async stop() {} };
    },
  };
  const w = host(t, {
    modules: [first],
    config: { opencode: { lifecycle: 'own' } },
    answers: { restarted: true },
  });
  await w.ready;
  await w.stop();
  assert.deepEqual(scene.restarts, [w.loaded.config.opencode]);
  assert.deepEqual(order, ['start after 1 restart(s)']);
  assert.ok(w.said('info').some(line => line.event === 'opencode.restarted'));
});

test('a restart that fails is said and the host serves all the same', async t => {
  const failure = new Error('the service would not stop');
  const w = host(t, { config: { opencode: { lifecycle: 'own' } }, answers: { restartFailure: failure } });
  await w.ready;
  assert.deepEqual(
    w
      .said('warn')
      .filter(line => line.event === 'opencode.restart.failed')
      .map(line => line.error),
    [failure],
  );
  await w.stop();
});

for (const [bind, open] of [
  ['127.0.0.1', false],
  ['::1', false],
  ['localhost', false],
  ['[::1]', false],
  ['0.0.0.0', true],
] as const)
  test(`the host listens on ${bind}${open ? ' and says that anyone who can reach it can use it' : ' and says nothing of it'}`, async t => {
    const w = host(t, { config: { host: { port: 0, bind } } });
    await w.ready;
    assert.deepEqual(scene.servers[0]!.bound, { port: 0, bind });
    assert.deepEqual(
      w
        .said('warn')
        .filter(line => line.event === 'api.open')
        .map(line => line.bind),
      open ? [bind] : [],
    );
    await w.stop();
  });

test('the orchestrator is built from the loaded config: lanes, project directories, git identity, keep-alive and editable prompts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'prompts'));
  await writeFile(join(home, 'prompts', 'nudge.md'), 'Say what you did, then stop.\n');
  const { w, services } = await serving(t, {
    home,
    config: {
      projects: {
        site: {
          lanes: [
            { name: 'Todo', agent: 'dev' },
            { name: 'Done', queue: false },
          ],
        },
      },
      identity: { github: { user: 'aivi-bot', email: 'bot@example.com' } },
      orchestrator: { elicitationKeepAlive: '2h', turnEndDebounce: '3s' },
    },
    projects: [{ id: 'site', directory: join(home, 'projects', 'site', 'source') }],
  });
  const [orchestrator] = scene.orchestrators;
  const options = orchestrator!.options;
  assert.deepEqual(options.lanes('site'), w.loaded.config.projects.site!.lanes);
  assert.deepEqual(options.lanes('unknown'), []);
  assert.equal(options.directory('site'), join(home, 'projects', 'site', 'source'));
  assert.throws(() => options.directory('ghost'), /no project ghost in the loaded config/);
  assert.deepEqual(await options.identity(), { name: 'aivi-bot', email: 'bot@example.com' });
  assert.equal(options.keepAliveMs, 2 * 3_600_000);
  assert.equal(options.turnEndDebounceMs, 3_000);
  assert.equal(
    await options.prompt('nudge'),
    'Say what you did, then stop.',
    'an edit of the home’s copy lands at once',
  );
  assert.equal(await options.prompt('worker-contract'), promptDefaults['worker-contract'], 'no copy: the default');
  assert.equal(options.dispatcher, services.dispatcher);
  assert.equal(options.forges, services.forges);
  assert.equal(options.events, services.events);
  assert.equal(services.orchestrator, orchestrator);
  assert.equal(orchestrator!.recover.mock.callCount(), 1, 'recovery ran once, before the host served');
  assert.equal(options.signal.aborted, false);
  await w.stop();
  assert.equal(options.signal.aborted, true, 'the orchestrator stops with the host');
});

test('the ticket desk answers for the run of the calling session through the orchestrator, and the worker tools are the host’s', async t => {
  const desk = {
    read: async () => ({ identifier: 'X-1', title: 'Ship it' }),
    create: async () => ({ identifier: 'X-9', url: 'https://x/9' }),
  };
  const finish = async () => ({ done: true });
  const w = host(t, {
    answers: {
      run: { id: 'run_1', projectId: 'site', trackerId: 'tracker-linear', state: 'working' },
      tracker: { id: 'tracker-linear', desk },
      workerTools: [
        {
          descriptor: {
            namespace: 'aivi',
            name: 'work_complete',
            description: 'End the run.',
            input: { type: 'object' },
          },
          handler: finish,
        },
      ],
    },
  });
  await w.ready;
  const tools = scene.apis[0]!.tools;
  assert.equal(tools.get('aivi_work_complete').handler, finish);
  assert.deepEqual(
    tools.claimed().filter((claim: { id: string }) => claim.id === 'aivi_work_complete'),
    [{ id: 'aivi_work_complete', owner: 'host' }],
  );
  assert.deepEqual(await tools.get('aivi_ticket_read').handler({ sessionId: 'ses_worker', input: {} }), {
    identifier: 'X-1',
    title: 'Ship it',
  });
  await tools
    .get('aivi_ticket_create')
    .handler({ sessionId: 'ses_worker', input: { title: 'Other', description: 'Found.' } });
  const [orchestrator] = scene.orchestrators;
  assert.deepEqual(
    orchestrator!.runBySession.mock.calls.map(call => call.arguments),
    [['ses_worker'], ['ses_worker']],
  );
  assert.deepEqual(
    orchestrator!.tracker.mock.calls.map(call => call.arguments),
    [['tracker-linear'], ['tracker-linear']],
  );
  assert.deepEqual(
    orchestrator!.wake.mock.calls.map(call => call.arguments),
    [['site']],
    'a created ticket wakes the walk of its project',
  );
  await w.stop();
});

test('a lease the dispatcher ends on its own is cleared from the orchestrator that claimed it', async t => {
  const { w, services } = await serving(t);
  const grant = services.dispatcher.request({ service: 'probe', pool: 'any' });
  assert.ok('lease' in grant);
  await (services.dispatcher as unknown as Dispatcher).expire(
    grant.lease.id,
    'no session was provided within the prepare timeout',
  );
  const [orchestrator] = scene.orchestrators;
  assert.deepEqual(
    orchestrator!.leaseEnded.mock.calls.map(call => [(call.arguments[0] as { id: string }).id, call.arguments[1]]),
    [[grant.lease.id, 'no session was provided within the prepare timeout']],
  );
  await w.stop();
});

test('the API reads the host’s health and held leases as they are, wakes the host, and carries the exec door and the referee', async t => {
  const compose = async () => 'the composed config';
  const { w, services } = await serving(t, { compose });
  const api = scene.apis[0]!;
  assert.deepEqual(scene.healthAtListen, [], 'a request that lands as the listener opens finds no modules yet');
  assert.deepEqual(
    api.health().map((module: { id: string; state: string }) => [module.id, module.state]),
    [['probe', 'running']],
  );
  assert.equal(api.leases(), 0);
  assert.ok('lease' in services.dispatcher.request({ service: 'probe', pool: 'any' }));
  assert.equal(api.leases(), 1);
  const heard: string[] = [];
  services.onWake(() => heard.push('woke'));
  api.wake();
  assert.deepEqual(heard, ['woke']);
  assert.equal(api.compose, compose);
  assert.deepEqual(await api.jobs({ action: 'list', sessionId: 'ses_1' }), {
    summary: 'No agent-created jobs exist.',
    items: [],
  });
  const [exec] = scene.execs;
  assert.equal(exec!.server, scene.servers[0], 'the exec door rides the API’s listener');
  assert.equal(exec!.deps.store, w.store);
  assert.equal(exec!.deps.loaded, w.loaded);
  assert.equal(exec!.deps.signal.aborted, false);
  await w.stop();
  assert.equal(exec!.deps.signal.aborted, true);
});

test('the API asks the router what can be linked, the ledger who is a run, and OpenCode for a session’s context', async t => {
  const get = mock.fn(async (..._args: unknown[]) => ({
    agent: 'assistant',
    location: { directory: '/work/team' },
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
  }));
  const client = {
    session: { active: async () => ({}), get, context: async () => [] },
    plugin: { list: async () => ({ data: [] }) },
  };
  const w = host(t, {
    modules: [channel('discord', { linkHint: 'Send /link and the code you were given.' })],
    opencode: false,
    answers: { client },
    seed: store => {
      const ledger = new RunLedger(store);
      const { run } = ledger.request({
        projectId: 'site',
        trackerId: 'linear',
        ticketId: 'T-1',
        lane: 'Todo',
        agent: 'dev',
      });
      ledger.attachSession(run.id, 'ses_worker', '/work/worktree');
    },
  });
  await w.ready;
  const api = scene.apis[0]!;
  assert.deepEqual(api.linkable(), [{ id: 'discord', hint: 'Send /link and the code you were given.' }]);
  assert.equal(api.runMembership('ses_worker'), true);
  assert.equal(api.runMembership('ses_stranger'), false);
  const signal = AbortSignal.timeout(2_000);
  assert.match(await api.context('ses_1', signal), /^🧠 \*\*Context\*\* · `assistant` in `\/work\/team`/);
  assert.deepEqual(get.mock.calls[0]!.arguments, [{ sessionID: 'ses_1' }, { signal }]);
  await w.stop();
});

test('a change the job tool makes to the queue wakes the host', async t => {
  const { w, services } = await serving(t);
  w.store.addJob(
    jobSchema.parse({
      id: 'agent-nightly',
      at: '2099-01-01T00:00:00Z',
      task: { kind: 'invocation', name: 'system.check' },
    }),
    'agent',
  );
  const heard: string[] = [];
  services.onWake(() => heard.push('woke'));
  await scene.apis[0]!.jobs({ action: 'pause', sessionId: 'ses_1', id: 'agent-nightly' });
  assert.deepEqual(heard, ['woke']);
  await w.stop();
});

const toOps = { to: 'channel', module: 'discord', channel: 'ops', on: 'always' } as const;
const unclaimed = { kind: 'invocation', name: 'nothing.claims.this' } as const;
const sweep = { kind: 'invocation', name: 'system.check' } as const;

/** A job that runs once the host is up, behind `prior` failed runs of the same job. */
function queued(task: typeof unclaimed | typeof sweep, prior: number, report?: unknown) {
  return (store: Store) => {
    store.addJob(
      jobSchema.parse({ id: 'nightly', at: '2099-01-01T00:00:00Z', task, ...(report ? { report } : {}) }),
      'operator',
    );
    for (let i = 0; i < prior; i++) {
      const at = Date.now() - 600_000 + i * 1_000;
      const earlier = store.runJob('nightly', at);
      store.claimRun(earlier.id, 'earlier host', at);
      store.finish(earlier.id, 'earlier host', 'failed', null, 'it broke', at + 1);
    }
    store.runJob('nightly');
  };
}

const failedWords =
  '❌ nightly (nothing.claims.this) failed\nNothing claims the operation "nothing.claims.this"; start the module that provides it';
const reports: [string, Parameters<typeof queued>[0], number, string][] = [
  ['the first failure is told plainly', unclaimed, 0, failedWords],
  [
    'the third failure in a row asks for a look',
    unclaimed,
    2,
    `${failedWords}\nThis job has failed 3 times in a row. Fix it, pause it, or remove it.`,
  ],
  [
    'a success is told in its own words',
    sweep,
    0,
    '✅ nightly (system.check) succeeded\nAll 0 knowledge sources available.',
  ],
];
for (const [name, task, prior, text] of reports)
  test(`a job's outcome is posted to its channel and audited: ${name}`, async t => {
    const posted = Promise.withResolvers<{ channel: string; text: string }>();
    const w = host(t, {
      modules: [channel('discord', { post: async (channel, text) => posted.resolve({ channel, text }) })],
      seed: queued(task, prior, toOps),
    });
    assert.deepEqual(await posted.promise, { channel: 'ops', text });
    await w.stop();
    const run = w.store.runs({ jobId: 'nightly' }).at(-1)!;
    assert.deepEqual(w.store.history(run.id).at(-1)?.reason, 'discord:ops');
    assert.equal(w.store.history(run.id).at(-1)?.action, 'reported');
  });

test('a job that asks for no report posts nothing', async t => {
  const posted: string[] = [];
  const w = host(t, {
    modules: [channel('discord', { post: async (_channel, text) => void posted.push(text) })],
    seed: queued(sweep, 0),
  });
  await w.next('run.finished');
  await w.stop();
  assert.deepEqual(posted, []);
  const run = w.store.runs({ jobId: 'nightly' }).at(-1)!;
  assert.equal(run.state, 'succeeded');
  assert.ok(!w.store.history(run.id).some(entry => entry.action === 'reported'));
});

for (const [name, thrown, said] of [
  ['an error', new Error('the channel is closed'), 'the channel is closed'],
  ['a plain rejection', 'the channel is closed for the night', 'the channel is closed for the night'],
] as const)
  test(`a report that cannot be delivered is audited with the reason and never changes the run (${name})`, async t => {
    const w = host(t, {
      modules: [
        channel('discord', {
          post: async () => {
            throw thrown;
          },
        }),
      ],
      seed: queued(sweep, 0, toOps),
    });
    await w.next('run.report.failed');
    await w.stop();
    const run = w.store.runs({ jobId: 'nightly' }).at(-1)!;
    assert.equal(run.state, 'succeeded', 'a delivery failure never changes the run outcome');
    const last = w.store.history(run.id).at(-1)!;
    assert.deepEqual([last.action, last.reason], ['report-failed', said]);
  });

test('a result for a session no module owns goes into that session’s inbox, in the home’s own words', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'prompts'));
  await writeFile(join(home, 'prompts', 'job-result.md'), 'Outcome for you: {text}\n');
  const get = mock.fn(async (..._args: unknown[]) => ({}));
  const prompt = mock.fn(async (..._args: unknown[]) => ({}));
  const client = { session: { active: async () => ({}), get, prompt } };
  const w = host(t, {
    home,
    opencode: false,
    answers: { client },
    seed: queued(sweep, 0, { to: 'session', session: 'ses_native', on: 'always' }),
  });
  await w.next('run.finished');
  await w.stop();
  const run = w.store.runs({ jobId: 'nightly' }).at(-1)!;
  const signal = get.mock.calls[0]!.arguments[1] as { signal: AbortSignal };
  assert.deepEqual(get.mock.calls[0]!.arguments, [{ sessionID: 'ses_native' }, signal]);
  assert.deepEqual(prompt.mock.calls[0]!.arguments, [
    {
      sessionID: 'ses_native',
      text: 'Outcome for you: ✅ nightly (system.check) succeeded\nAll 0 knowledge sources available.',
      delivery: 'queue',
      metadata: { aivi: { origin: 'job-result', run: run.id } },
    },
    signal,
  ]);
  assert.equal(signal.signal.aborted, true, 'the call carries the host’s own signal');
});

const dreaming = { kind: 'invocation', name: 'dreaming', args: { directory: '.', memoryDirectory: 'memory' } } as const;
const voiceRoom: AiviModule = {
  id: 'voice',
  async start(services) {
    services.voice.provide({ room: () => ({}) } as never);
    services.voice.room({ id: 'meet' } as never);
    return { async stop() {} };
  },
};
for (const [name, modules, reason] of [
  ['no channel and no room is registered', [], /^dreaming: no channel module is registered/],
  ['a channel is registered', [channel('discord')], /^Dreaming not started: OpenCode must not be contacted/],
  ['a voice room has been opened', [voiceRoom], /^Dreaming not started: OpenCode must not be contacted/],
] as const)
  test(`dreaming that names no origins reviews the channels and rooms of the moment: ${name}`, async t => {
    const w = host(t, {
      modules: [...modules],
      sources: [{ id: 'memory', path: '/work/aivi/memory', kind: 'memory', scope: 'core' }],
      seed: store => void store.enqueue(dreaming, 'local-model', 'dream'),
    });
    const finished = await w.next('run.finished');
    assert.equal(finished.state, 'failed');
    assert.match(String(finished.reason), reason);
    await w.stop();
  });

test('a store that fails under a finishing run stops the scheduler and then the host, and both failures are told', async t => {
  const { w, services } = await serving(t, {
    seed: store => {
      store.enqueue(unclaimed, 'local-model', 'doomed');
      t.mock.method(store, 'finish', () => {
        throw new Error('disk full');
      });
    },
  });
  await w.next('scheduler.failed');
  services.wake();
  await assert.rejects(
    w.done,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.message === 'Application shutdown failed' &&
      error.errors.map(failure => (failure as Error).message).join(' | ') ===
        'Scheduler stopped unexpectedly | disk full',
  );
});
