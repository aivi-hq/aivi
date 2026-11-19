/** The executor as a unit: the host's own operations, the shell it runs and the
 *  turn it drives. The machine is replaced where the executor reaches it: the
 *  shell is a recorded `execFile`, OpenCode is a client the test hands in, the
 *  dreamer's run is a module mock (`dream`), and the clock is a mock `Date`. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { configSchema, type ExecutionContext, type KnowledgeSource, type LoadedConfig, taskSchema } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { Forges } from '../src/forges.ts';
import { Store } from '../src/store.ts';
import { TaskRegistry } from '../src/tasks.ts';
import { recorder } from './support.ts';

/** What the dreamer's run was asked, and what the test makes it answer. */
const dreamer = {
  calls: [] as { task: Record<string, unknown>; runId: string; deps: Record<string, unknown> }[],
  outcome: undefined as unknown,
  failure: undefined as unknown,
};
mock.module('../src/dreaming.ts', {
  exports: {
    dream: async (task: Record<string, unknown>, runId: string, deps: Record<string, unknown>) => {
      dreamer.calls.push({ task, runId, deps });
      if (dreamer.failure) throw dreamer.failure;
      return dreamer.outcome;
    },
  },
});
const { createExecutor } = await import('../src/runtime.ts');

const HOME = '/work/aivi';
const quiet = { watch: () => () => {} };
const unreachable = async (): Promise<OpenCodeClient> => {
  throw new Error('OpenCode must not be reached here');
};
const core = (id: string, path: string): KnowledgeSource => ({ id, path, kind: 'memory', scope: 'core' });

type Deps = Parameters<typeof createExecutor>[1];

/** An executor over a real in-memory store, with the log on record. */
function world(t: TestContext, over: Partial<Deps> = {}, loaded: Partial<LoadedConfig> = {}) {
  dreamer.calls = [];
  dreamer.failure = undefined;
  dreamer.outcome = undefined;
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { log, said } = recorder();
  const config = configSchema.parse({ version: 1, stateDirectory: '/work/aivi/state' });
  const execute = createExecutor(
    { path: join(HOME, 'config.json'), config, projects: [], sources: [], ...loaded },
    { store, events: quiet, opencode: unreachable, tasks: new TaskRegistry(), forges: new Forges(), log, ...over },
  );
  const run = (task: unknown, key: string) => store.enqueue(taskSchema.parse(task), 'local-model', key);
  const context = (given: Partial<ExecutionContext> = {}): ExecutionContext => ({
    signal: new AbortController().signal,
    attachSession() {},
    ...given,
  });
  return { store, execute, run, context, said };
}

const operation = (name: string, args?: unknown) => ({ kind: 'invocation', name, ...(args ? { args } : {}) });

for (const [name, args] of [
  ['args of the wrong kind', { olderThanDays: 'soon' }],
  ['no args at all', undefined],
] as const)
  test(`an operation with ${name} fails the run with a readable reason and never throws at the scheduler`, async t => {
    const { execute, run, context } = world(t);
    const outcome = await execute(run(operation('runs.prune', args), 'bad'), context());
    assert.equal(outcome.state, 'failed');
    assert.match(outcome.reason ?? '', /^Bad args for runs\.prune: /);
  });

test('retention deletes what ended before the cutoff, runs and request diary alike, and says where the cutoff was', async t => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const { store, execute, run, context } = world(t);
  const day = 86_400_000;
  const old = store.enqueue(taskSchema.parse(operation('system.check')), 'local-model', 'old', now - 60 * day);
  store.finish(store.claimRun(old.id, 'host', now - 60 * day)!.id, 'host', 'succeeded', null, 'done', now - 59 * day);
  const diary = { method: 'GET', path: '/health', status: 200, body: null, truncated: false, headers: {} };
  store.logRequest({ ...diary, at: now - 45 * day });
  store.logRequest({ ...diary, at: now - day });
  const outcome = await execute(run(operation('runs.prune', { olderThanDays: 30 }), 'prune'), context());
  assert.deepEqual(outcome, {
    state: 'succeeded',
    result: { olderThan: new Date(now - 30 * day).toISOString(), runs: 1, jobs: 1, linkCodes: 0, requests: 1 },
  });
  assert.equal(store.requests().length, 1, 'the diary row from yesterday stays');
});

test('a sources check says which knowledge sources are on disk and which are gone, and when it looked', async t => {
  const checkedAt = Date.parse('2026-11-19T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: checkedAt });
  const there = await mkdtemp(join(tmpdir(), 'aivi-check-'));
  t.after(() => rm(there, { recursive: true, force: true }));
  const sources: KnowledgeSource[] = [
    core('handbook', there),
    { id: 'adrs', path: join(there, 'missing'), kind: 'decision', scope: 'project', projectId: 'app' },
  ];
  const { execute, run, context } = world(t, {}, { sources });
  const outcome = await execute(run(operation('system.check'), 'check'), context());
  assert.deepEqual(outcome, {
    state: 'succeeded',
    result: {
      sources: [
        { id: 'handbook', projectId: undefined, available: true },
        { id: 'adrs', projectId: 'app', available: false },
      ],
      checkedAt: new Date(checkedAt).toISOString(),
    },
  });
});

test('an index of the knowledge asks the knowledge service, and without one the operation throws for the scheduler to block', async t => {
  const knowledge = { index: t.mock.fn(async () => ({ indexed: 2 })) } as unknown as Deps['knowledge'];
  const served = world(t, { knowledge });
  const done = await served.execute(served.run(operation('knowledge.index'), 'index'), served.context());
  assert.deepEqual(done, { state: 'succeeded', result: { indexed: 2 } });
  const bare = world(t);
  await assert.rejects(
    bare.execute(bare.run(operation('knowledge.index'), 'index'), bare.context()),
    /Knowledge service is not available/,
  );
});

/** A forge that owns every project and answers each one's sync from `answers`. */
function ownedBy(answers: Record<string, unknown>) {
  const forges = new Forges();
  forges.register({
    async repoFor(project: { id: string }) {
      return { id: project.id, remote: `https://github.com/acme/${project.id}` };
    },
    async syncSource(repo: { id: string }) {
      return answers[repo.id];
    },
  } as never);
  return forges;
}
const checkouts = ['site', 'api', 'docs'].map(id => ({ id, directory: `/work/aivi/projects/${id}/source` }));

test('a projects sync reports what moved, what was held and why, and re-indexes the knowledge after a move', async t => {
  const knowledge = { index: t.mock.fn(async () => ({ indexed: 5 })) } as unknown as Deps['knowledge'];
  const forges = ownedBy({
    site: { state: 'updated', from: 'a1', to: 'b2' },
    api: { state: 'held', reason: 'diverged' },
    docs: { state: 'current', from: 'c3', to: 'c3' },
  });
  const { execute, run, context, said } = world(t, { forges, knowledge }, { projects: checkouts });
  const outcome = await execute(run(operation('projects.sync'), 'sync'), context());
  assert.deepEqual(outcome, {
    state: 'succeeded',
    result: {
      projects: [
        { id: 'site', state: 'updated', from: 'a1', to: 'b2' },
        { id: 'api', state: 'skipped', reason: 'diverged' },
        { id: 'docs', state: 'current', from: 'c3', to: 'c3' },
      ],
      indexed: { indexed: 5 },
    },
  });
  assert.deepEqual(
    said('warn').map(line => [line.event, line.project, line.reason]),
    [['projects.sync.skipped', 'api', 'diverged']],
  );
});

for (const [name, site, withService] of [
  ['every checkout is current', { state: 'current' }, true],
  ['a checkout moved but there is no knowledge service', { state: 'updated' }, false],
] as const)
  test(`a projects sync where ${name} indexes nothing and reports no index`, async t => {
    const index = t.mock.fn(async () => ({ indexed: 1 }));
    const { execute, run, context } = world(
      t,
      {
        forges: ownedBy({ site, api: { state: 'current' }, docs: { state: 'current' } }),
        ...(withService ? { knowledge: { index } as never } : {}),
      },
      { projects: checkouts },
    );
    const outcome = await execute(run(operation('projects.sync'), 'sync'), context());
    assert.equal(Object.hasOwn(outcome.result as object, 'indexed'), false);
    assert.equal(index.mock.callCount(), 0);
  });

/** The shell the executor starts: every `execFile` on record, ended by `end`. */
function shell(t: TestContext, end: { error?: Record<string, unknown>; stdout?: string; stderr?: string }) {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const execFile = t.mock.method(childProcess, 'execFile', ((
    file: string,
    args: string[],
    options: Record<string, unknown>,
    done: (...answer: unknown[]) => void,
  ) => {
    calls.push({ file, args, options });
    const error = end.error && Object.assign(new Error('the command failed'), end.error);
    queueMicrotask(() => done(error ?? null, end.stdout ?? '', end.stderr ?? ''));
    return { pid: 4242 };
  }) as never);
  syncBuiltinESMExports();
  t.after(() => {
    execFile.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

const script = { kind: 'shell', command: ['sh', 'build.sh', '--ci'] };

test('a script runs in the state directory unless it names its own, with its time limit', async t => {
  const calls = shell(t, { stdout: 'built\n' });
  const { execute, run, context } = world(t);
  await execute(run(script, 'default'), context());
  await execute(run({ ...script, cwd: '/work/build', timeoutMs: 5_000 }, 'own'), context());
  assert.deepEqual(
    calls.map(call => [call.file, call.args, call.options.cwd, call.options.timeout]),
    [
      ['sh', ['build.sh', '--ci'], '/work/aivi/state', 600_000],
      ['sh', ['build.sh', '--ci'], '/work/build', 5_000],
    ],
  );
});

const ended: [string, Record<string, unknown>, boolean, string][] = [
  [
    'the host stopped while it ran',
    { code: 'ABORT_ERR', name: 'AbortError' },
    true,
    'Host stopped while the command was running',
  ],
  ['a signal killed it', { killed: true, signal: 'SIGTERM' }, false, 'Command killed by SIGTERM'],
  [
    'it hit the output limit and exited on its own',
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    false,
    'Command did not exit cleanly',
  ],
];
for (const [name, error, hostStopped, reason] of ended)
  test(`a script that ended because ${name} is blocked, never failed: it may still be running`, async t => {
    shell(t, { error });
    const { execute, run, context } = world(t);
    const abort = new AbortController();
    if (hostStopped) abort.abort();
    const outcome = await execute(run(script, 'ended'), context({ signal: abort.signal }));
    assert.equal(outcome.state, 'blocked');
    assert.equal(outcome.reason, reason);
  });

test('a script that prints more than sixteen kilobytes is reported by its end', async t => {
  shell(t, { stdout: `${'a'.repeat(100)}${'z'.repeat(16 * 1024)}` });
  const { execute, run, context } = world(t);
  const outcome = await execute(run(script, 'chatty'), context());
  assert.equal((outcome.result as { stdout: string }).stdout, `…${'z'.repeat(16 * 1024)}`);
});

const dreaming = { directory: '.', memoryDirectory: 'memory', origins: ['discord'] };
const sources = {
  org: core('memory', join(HOME, 'memory')),
  site: {
    id: 'memory',
    path: join(HOME, 'projects', 'site', 'memory'),
    kind: 'memory',
    scope: 'project',
    projectId: 'site',
  },
  adrs: { id: 'adrs', path: '/work/adrs', kind: 'decision', scope: 'project', projectId: 'site' },
} satisfies Record<string, KnowledgeSource>;
const dreamClient = { marker: 'the OpenCode client' } as unknown as OpenCodeClient;
const reviewed = (count: number) => ({
  state: 'succeeded',
  result: { reviewed: count, since: 0, until: 5, sessions: [], changed: [] },
});

test('dreaming with no origin named and no channel registered says there is nothing to review', async t => {
  const { execute, run, context } = world(t, {}, { sources: [sources.org] });
  const outcome = await execute(
    run(operation('dreaming', { directory: '.', memoryDirectory: 'memory' }), 'none'),
    context(),
  );
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.reason ?? '', /no channel module is registered/);
});

test('dreaming that was granted no slot fails before it reaches OpenCode', async t => {
  const { execute, run, context } = world(t, {}, { sources: [sources.org] });
  const outcome = await execute(run(operation('dreaming', dreaming), 'no-slot'), context());
  assert.deepEqual(outcome, {
    state: 'failed',
    result: null,
    reason: 'Dreaming: no dispatcher slot was granted; the dreamer turn needs one',
  });
});

test('a dreamer run gets its session from the slot, its task resolved against the home and every project memory', async t => {
  const index = t.mock.fn(async () => ({ indexed: 3 }));
  const { execute, run, context } = world(
    t,
    { opencode: async () => dreamClient, knowledge: { index } as never },
    { sources: [sources.org, sources.site, sources.adrs] },
  );
  dreamer.outcome = reviewed(2);
  const queued = run(operation('dreaming', dreaming), 'dream');
  const provide = t.mock.fn(async (_work: unknown) => ({ sessionId: 'ses_aivi_dream' }));
  const attached: string[] = [];
  const outcome = await execute(
    queued,
    context({ lease: { id: 'lease_1', provide }, attachSession: id => void attached.push(id) }),
  );
  assert.deepEqual(outcome, reviewed(2));
  const [{ task, runId, deps }] = dreamer.calls as [(typeof dreamer.calls)[number]];
  assert.equal(runId, queued.id);
  assert.deepEqual(task, {
    ...dreaming,
    agent: 'dreamer',
    directory: resolve(HOME, '.'),
    memoryDirectory: resolve(HOME, 'memory'),
    maxSessions: 50,
    timeoutMs: 1_800_000,
  });
  assert.deepEqual(deps.projects, [{ id: 'site', memory: sources.site.path }], 'only the project memory sources');
  assert.equal(deps.client, dreamClient);
  assert.equal(deps.stateDirectory, '/work/aivi/state');
  assert.deepEqual(attached, [deps.sessionId], 'the session id is on the run before OpenCode is asked anything');
  assert.deepEqual(provide.mock.calls[0]!.arguments[0], {
    agent: 'dreamer',
    directory: resolve(HOME, '.'),
    sessionId: deps.sessionId,
    create: true,
    title: `aivi dreaming ${new Date().toISOString().slice(0, 10)}`,
    metadata: { aivi: { origin: 'dreaming', run: queued.id } },
  });
  assert.equal(index.mock.callCount(), 1, 'what was reviewed is searchable at once');
});

test('an index that fails after a review is said and changes nothing; a run that reviewed nothing indexes nothing', async t => {
  const failure = new Error('index is busy');
  const index = t.mock.fn(async () => {
    throw failure;
  });
  const { execute, run, context, said } = world(
    t,
    { opencode: async () => dreamClient, knowledge: { index } as never },
    { sources: [sources.org] },
  );
  const slot = () => ({ lease: { id: 'lease_1', provide: async () => ({ sessionId: 'ses_aivi_dream' }) } });
  dreamer.outcome = reviewed(1);
  assert.deepEqual(await execute(run(operation('dreaming', dreaming), 'busy'), context(slot())), reviewed(1));
  assert.deepEqual(
    said('warn').map(line => [line.event, line.error]),
    [['dreaming.index.failed', failure]],
  );
  dreamer.outcome = reviewed(0);
  await execute(run(operation('dreaming', dreaming), 'quiet'), context(slot()));
  assert.equal(index.mock.callCount(), 1, 'only the review that found something asked for an index');
});

test('a dreamer run that dies while the host stops is blocked with the host named, and its session left to inspect', async t => {
  const { execute, run, context } = world(t, { opencode: async () => dreamClient }, { sources: [sources.org] });
  dreamer.failure = new Error('the stream was cut');
  const abort = new AbortController();
  abort.abort();
  const queued = run(operation('dreaming', dreaming), 'stopped');
  const outcome = await execute(
    queued,
    context({ signal: abort.signal, lease: { id: 'lease_1', provide: async () => ({ sessionId: 'ses_aivi_dream' }) } }),
  );
  const session = `ses_aivi_${queued.id.replaceAll('-', '')}`;
  assert.deepEqual(outcome, {
    state: 'blocked',
    result: { sessionId: session },
    reason: `Host stopped during dreaming. Inspect session ${session} and resolve this run.`,
  });
});

const prompt = { kind: 'prompt', agent: 'assistant', directory: '/work/team', prompt: 'Read the handbook' };

test('a prompt that was granted no slot fails before it reaches OpenCode', async t => {
  const { execute, run, context } = world(t);
  const outcome = await execute(run(prompt, 'no-slot'), context());
  assert.deepEqual(outcome, {
    state: 'failed',
    result: null,
    reason: 'Prompt job: no dispatcher slot was granted; prompt work needs one',
  });
});

test('a turn that is running when the host stops is blocked with the host named, not failed', async t => {
  const waiting = Promise.withResolvers<void>();
  const client = {
    session: {
      get: async () => ({ agent: 'assistant', location: { directory: '/work/team' } }),
      prompt: async () => undefined,
      wait: (_query: unknown, request: { signal: AbortSignal }) => {
        waiting.resolve();
        return new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
        );
      },
    },
    permission: { list: async () => [] },
  } as unknown as OpenCodeClient;
  const { execute, run, context } = world(t, { opencode: async () => client });
  const abort = new AbortController();
  const queued = run(prompt, 'running');
  const outcome = execute(
    queued,
    context({ signal: abort.signal, lease: { id: 'lease_1', provide: async () => ({ sessionId: 'ses_aivi_x' }) } }),
  );
  await waiting.promise;
  abort.abort();
  const session = `ses_aivi_${queued.id.replaceAll('-', '')}`;
  assert.deepEqual(await outcome, {
    state: 'blocked',
    result: { sessionId: session },
    reason: `Host stopped during turn. Inspect session ${session} and resolve this run.`,
  });
});

const asked = { id: 'per_1', action: 'shell', resources: ['rm -rf'] };
const unfinished: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
  [
    'the agent needs a permission nobody can give',
    { ...prompt, onPermission: 'fail' },
    { permission: { list: async () => [asked] } },
    'Agent requires approval: shell rm -rf',
  ],
  [
    'OpenCode cannot say how the turn ended',
    prompt,
    {
      session: {
        context: async () => {
          throw new Error('the context is unreadable');
        },
      },
    },
    'the context is unreadable',
  ],
];
for (const [name, task, over, reason] of unfinished)
  test(`a turn that stops because ${name} is blocked with that said, and its session left to inspect`, async t => {
    const client = {
      session: {
        get: async () => ({ agent: 'assistant', location: { directory: '/work/team' } }),
        prompt: async () => undefined,
        wait: async () => undefined,
        ...(over.session as object),
      },
      permission: { list: async () => [], ...(over.permission as object) },
    } as unknown as OpenCodeClient;
    const { execute, run, context } = world(t, { opencode: async () => client });
    const queued = run(task, 'unfinished');
    const outcome = await execute(
      queued,
      context({ lease: { id: 'lease_1', provide: async () => ({ sessionId: 'ses_aivi_x' }) } }),
    );
    const session = `ses_aivi_${queued.id.replaceAll('-', '')}`;
    assert.deepEqual(outcome, {
      state: 'blocked',
      result: { sessionId: session },
      reason: `${reason}. Inspect session ${session} and resolve this run.`,
    });
  });
