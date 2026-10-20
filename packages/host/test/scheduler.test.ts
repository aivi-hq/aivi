import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, taskSchema } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore } from '../src/dispatcher/leases.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';

const config = configSchema.parse({ version: 1, scheduler: { agentSchedules: false } }).scheduler;

/** A real dispatcher over the real lease tables. The scheduler watches leases
 *  here but never prompts a session in these tests, so the fake client only
 *  answers create/get/active/interrupt. Timeouts are far beyond the test. */
function capacity(store: Store, pools?: Record<string, { capacity: number }>) {
  const sessions = new Map<string, { agent: string; directory: string }>();
  const client = {
    agent: { list: async () => ({ data: [] }) },
    session: {
      create: async (body: { id: string; agent: string; location: { directory: string } }) => {
        sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`session ${sessionID} not found`);
        return { agent: session.agent, location: { directory: session.directory } };
      },
      active: async () => ({}),
      interrupt: async () => {},
    },
  } as unknown as OpenCodeClient;
  return new Dispatcher({
    leases: new LeaseStore(store),
    dispatcher: configSchema.parse({ version: 1, ...(pools ? { dispatcher: { pools } } : {}) }).dispatcher,
    opencode: async () => client,
    idleMs: 600_000,
    prepareMs: 600_000,
    signal: AbortSignal.timeout(1_500),
  });
}

const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

test('a slow task queues the next task; execution failure blocks further dispatch', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', 'one', 1);
  const second = store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', 'two', 2);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  let calls = 0;
  // Capacity one: the second run waits on the dispatcher queue, not the store.
  const scheduler = new Scheduler(
    store,
    config,
    capacity(store, { 'local-model': { capacity: 1 } }),
    () => true,
    async () => {
      calls++;
      await pending;
      throw new Error('Tool may still be running');
    },
  );
  scheduler.tick();
  await wait();
  assert.equal(calls, 1);
  scheduler.tick();
  assert.equal(store.run(second.id).state, 'queued');
  release();
  await scheduler.drain();
  assert.equal(store.run(first.id).state, 'blocked');
  scheduler.tick();
  assert.equal(calls, 1, 'the blocked run keeps its slot; the next one still waits');
});

test('startup applies removed jobs before dispatching any stale queued run', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs(
    [
      {
        id: 'old',
        cron: '* * * * *',
        timezone: 'UTC',
        resource: 'local-model',
        enabled: true,
        task: { kind: 'invocation', name: 'system.check' },
      },
    ],
    [],
    0,
  );
  store.materializeDue(60_000);
  let calls = 0;
  const scheduler = new Scheduler(
    store,
    config,
    capacity(store),
    () => false,
    async () => {
      calls++;
      return { state: 'succeeded', result: null };
    },
  );
  // The host always reconciles configured jobs before its first tick.
  store.syncJobs([], [], 61_000);
  scheduler.tick(61_000);
  await scheduler.drain();
  assert.equal(calls, 0);
  assert.equal(store.runs()[0]!.state, 'cancelled');
});

test('a missed occurrence is reported like a failure and never executed', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs(
    [
      {
        id: 'standup',
        cron: '0 9 * * *',
        timezone: 'UTC',
        resource: 'local-model',
        enabled: true,
        task: { kind: 'invocation', name: 'system.check' },
        report: { to: 'session', session: 'ses_1', on: 'failure' },
      },
    ],
    [],
    0,
  );
  const nine = store.job('standup').nextAt!;
  let calls = 0;
  const reported: string[] = [];
  const scheduler = new Scheduler(
    store,
    config,
    capacity(store),
    () => false,
    async () => {
      calls++;
      return { state: 'succeeded', result: null };
    },
    undefined,
    async (run, state, _result, reason) => {
      reported.push(`${run.jobId}:${state}:${reason}`);
    },
  );
  scheduler.tick(nine + 3_600_000);
  await scheduler.drain();
  assert.equal(calls, 0);
  assert.equal(reported.length, 1);
  assert.match(reported[0]!, /^standup:missed:missed: aivi was not running at/);
  assert.equal(store.runs()[0]!.state, 'missed');
});

test('runs abort stops one running run; it ends blocked and keeps its capacity', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', 'long');
  let seen: AbortSignal | undefined;
  const dispatcher = capacity(store, { 'local-model': { capacity: 1 } });
  const scheduler = new Scheduler(
    store,
    config,
    dispatcher,
    () => true,
    async (_run, context) => {
      seen = context.signal;
      if (!context.signal.aborted)
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { state: 'blocked', result: null, reason: 'Host stopped while working' };
    },
  );
  scheduler.tick();
  await wait();
  assert.equal(scheduler.activeCount, 1);
  assert.equal(dispatcher.held(), 1, 'the run works inside its slot');
  assert.throws(() => store.requestCancel('missing'), /Only a running run/);
  store.requestCancel(job.id);
  scheduler.tick();
  await scheduler.drain();
  assert.ok(seen?.aborted);
  const done = store.run(job.id);
  assert.equal(done.state, 'blocked');
  assert.match(done.error ?? '', /^Aborted by operator\./);
  assert.equal(
    store
      .history(job.id)
      .map(h => h.action)
      .includes('abort-requested'),
    true,
  );
  assert.equal(dispatcher.held(), 1, 'a blocked run keeps its slot; the monitor is the reclaim');
  assert.equal(scheduler.stopped, false, 'aborting one run does not stop the scheduler');
});

test('a prompt run parks behind a full pool and starts when a slot frees', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const promptTask = (prompt: string) => taskSchema.parse({ kind: 'prompt', prompt, agent: 'dev', directory: '/w' });
  const first = store.enqueue(promptTask('one'), 'local-model', 'a', 1);
  const second = store.enqueue(promptTask('two'), 'local-model', 'b', 2);
  const started: string[] = [];
  let freeFirst!: () => void;
  const dispatcher = capacity(store, { 'local-model': { capacity: 1 } });
  const scheduler = new Scheduler(
    store,
    config,
    dispatcher,
    () => true,
    async (run, context) => {
      started.push(run.id);
      const provided = await context.lease!.provide({ agent: 'dev', directory: '/w' });
      context.attachSession(provided.sessionId!);
      if (run.id === first.id)
        await new Promise<void>(resolve => {
          freeFirst = resolve;
        });
      return { state: 'succeeded', result: null };
    },
  );
  scheduler.tick();
  await wait();
  assert.deepEqual(started, [first.id], 'the second prompt waits for capacity');
  assert.equal(store.run(second.id).state, 'queued');
  freeFirst();
  await wait();
  assert.deepEqual(started, [first.id, second.id], 'the freed slot woke the waiting request');
  assert.equal(store.run(second.id).state, 'succeeded');
  await scheduler.drain();
  assert.equal(dispatcher.held(), 0, 'settled runs pay their slots back');
});
