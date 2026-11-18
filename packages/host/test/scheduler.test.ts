import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, type ExecutionContext, type ExecutionResult, type Task, taskSchema } from '@aivi/core';
import type { DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore } from '../src/dispatcher/leases.ts';
import { type Execute, Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { recorder, TestCapacity } from './support.ts';

const config = configSchema.parse({ version: 1, scheduler: { agentSchedules: false } }).scheduler;

/** A real dispatcher over the real lease tables. The scheduler watches leases
 *  here but never prompts a session in these tests, so the fake client only
 *  answers create/get/active/interrupt. Timeouts are far beyond the test.
 *  `busy` holds the sessions that keep spending whatever anyone says. */
function capacity(store: Store, pools?: Record<string, { capacity: number }>, busy = new Set<string>()) {
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
      active: async () => Object.fromEntries([...busy].map(id => [id, {}])),
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

const check: Task = { kind: 'invocation', name: 'system.check' };
/** A task that calls a model: it needs a slot. */
const model = (prompt: string): Task => taskSchema.parse({ kind: 'prompt', prompt, agent: 'dev', directory: '/w' });
const hourly = {
  id: 'hourly',
  cron: '0 * * * *',
  timezone: 'UTC',
  resource: 'local-model',
  enabled: true,
  task: check,
};

/** The work the scheduler starts, held open by the test: `started` settles
 *  with a run's context once the scheduler launched it, `end` finishes it. */
function work() {
  const begun = new Map<string, PromiseWithResolvers<ExecutionContext>>();
  const ended = new Map<string, PromiseWithResolvers<ExecutionResult>>();
  const of = <T>(all: Map<string, PromiseWithResolvers<T>>, id: string) =>
    all.get(id) ?? all.set(id, Promise.withResolvers<T>()).get(id)!;
  const execute: Execute = (run, context) => {
    of(begun, run.id).resolve(context);
    return of(ended, run.id).promise;
  };
  return {
    execute,
    started: (id: string) => of(begun, id).promise,
    end: (id: string, outcome: ExecutionResult = { state: 'succeeded', result: null }) =>
      of(ended, id).resolve(outcome),
  };
}

/** The stand-in, counting what it is asked. */
class Asked extends TestCapacity {
  readonly asks: string[] = [];
  override request(input: { service: string; pool?: string; resume?: string }) {
    this.asks.push(input.pool ?? 'default');
    return super.request(input);
  }
}

/** The stand-in, keeping the callback a service registered: a test can say a grant itself. */
class Heard extends TestCapacity {
  heard: (requestId: string, lease: DispatcherLeaseRef) => void = () => {};
  override registerCallback(service: string, callback: (requestId: string, lease: DispatcherLeaseRef) => void): void {
    this.heard = callback;
    super.registerCallback(service, callback);
  }
}

test('a stopped scheduler lets nothing come due and takes nothing', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([hourly], [], 0);
  const waiting = store.enqueue(check, 'local-model', 'now', 1);
  const scheduler = new Scheduler(store, config, new TestCapacity(), () => false, work().execute);
  scheduler.stop();
  scheduler.tick(store.job('hourly').nextAt!);
  await scheduler.drain();
  assert.deepEqual(
    store.runs().map(run => [run.id, run.state]),
    [[waiting.id, 'queued']],
    'no occurrence was made into a run, and the queued run was left alone',
  );
});

test('an occurrence that comes due is made into a run and started in the same pass', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([hourly], [], 0);
  const scheduler = new Scheduler(
    store,
    config,
    new TestCapacity(),
    () => false,
    async () => ({
      state: 'succeeded',
      result: null,
    }),
  );
  scheduler.tick(store.job('hourly').nextAt!);
  await scheduler.drain();
  assert.deepEqual(
    store.runs().map(run => [run.jobId, run.state]),
    [['hourly', 'succeeded']],
  );
});

test('a missed occurrence with nobody to tell is still written down as missed', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([{ ...hourly, id: 'standup', cron: '0 9 * * *' }], [], 0);
  const scheduler = new Scheduler(store, config, new TestCapacity(), () => false, work().execute);
  scheduler.tick(store.job('standup').nextAt! + 3_600_000);
  assert.deepEqual(
    store.runs().map(run => run.state),
    ['missed'],
  );
  assert.equal(scheduler.activeCount, 0, 'nothing runs and nothing is reported');
});

test('a full pool is asked once: later runs of that pool wait behind the queue place, and a stop gives the place back', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue(model('one'), 'local-model', 'a', 1);
  store.enqueue(model('two'), 'local-model', 'b', 2);
  store.enqueue(model('three'), 'local-model', 'c', 3);
  const pool = new Asked(1);
  const jobs = work();
  const scheduler = new Scheduler(store, config, pool, () => true, jobs.execute);
  scheduler.tick();
  await jobs.started(first.id);
  assert.equal(pool.asks.length, 2, 'the first run got the slot, the second the queue place; the third did not ask');
  scheduler.tick();
  assert.equal(pool.asks.length, 2, 'and no later pass asks again while the place is held');

  scheduler.stop();
  assert.equal(pool.cancelled.length, 1, 'a queue place outlives nobody');
  jobs.end(first.id);
  await scheduler.drain();
  assert.equal(pool.heldCount(), 0);
});

test('a pool that refuses is not asked again in the same pass', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue(model('one'), 'pool-a', 'a', 1);
  store.enqueue(model('two'), 'pool-a', 'b', 2);
  store.enqueue(model('three'), 'pool-b', 'c', 3);
  store.enqueue(model('four'), 'pool-b', 'd', 4);
  // This stand-in has one slot and one queue place for a whole service: with
  // the place taken in pool-a, an ask for pool-b is refused as `waiting`.
  const pool = new Asked(1);
  const jobs = work();
  const scheduler = new Scheduler(store, config, pool, () => true, jobs.execute);
  scheduler.tick();
  await jobs.started(first.id);
  assert.deepEqual(pool.asks, ['pool-a', 'pool-a', 'pool-b'], 'the fourth run did not ask the pool that just refused');

  scheduler.stop();
  jobs.end(first.id);
  await scheduler.drain();
});

test('a run whose pool the dispatcher does not know is said once and waits; the other pools are served', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const lost = store.enqueue(model('one'), 'nowhere', 'a', 1);
  const served = store.enqueue(model('two'), 'local-model', 'b', 2);
  const pool = new TestCapacity();
  pool.throwing.add('nowhere');
  const { log, said } = recorder();
  const jobs = work();
  const scheduler = new Scheduler(store, config, pool, () => true, jobs.execute, log);
  scheduler.tick();
  scheduler.tick();
  await jobs.started(served.id);
  assert.equal(store.run(lost.id).state, 'queued', 'it waits for the configuration');
  assert.deepEqual(
    said('warn').map(line => [line.event, line.resource]),
    [['pool.unknown', 'nowhere']],
    'said once, not on every pass',
  );
  jobs.end(served.id);
  await scheduler.drain();
});

test('a run cancelled while it waited for a slot pays the slot back when the grant lands', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue(model('one'), 'local-model', 'a', 1);
  const second = store.enqueue(model('two'), 'local-model', 'b', 2);
  const pool = new TestCapacity(1);
  const jobs = work();
  const scheduler = new Scheduler(store, config, pool, () => true, jobs.execute);
  scheduler.tick();
  await jobs.started(first.id);
  store.cancelQueued(second.id);

  jobs.end(first.id);
  await scheduler.drain();
  assert.equal(pool.released.length, 2, 'the slot granted for the cancelled run went straight back');
  assert.equal(pool.heldCount(), 0);
  assert.equal(store.run(second.id).state, 'cancelled');
});

test('a run cancelled between a pass’s read and its claim pays its slot straight back', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = store.enqueue(model('one'), 'local-model', 'a', 1);
  const pool = new TestCapacity(1);
  // The CLI is another process on the same store: its cancel can land
  // between the read and the claim. This hook sits exactly there.
  const cancelledMeanwhile = () => {
    store.cancelQueued(run.id);
    return true;
  };
  const scheduler = new Scheduler(store, config, pool, cancelledMeanwhile, work().execute);
  scheduler.tick();
  assert.equal(pool.released.length, 1);
  assert.equal(pool.heldCount(), 0);
  assert.equal(scheduler.activeCount, 0, 'nothing was started');
});

test('a lease the dispatcher already ended is said when its run finishes, and the run still ends', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = store.enqueue(model('one'), 'local-model', 'a', 1);
  const dispatcher = capacity(store, { 'local-model': { capacity: 1 } });
  const { log, said } = recorder();
  const jobs = work();
  const scheduler = new Scheduler(store, config, dispatcher, () => true, jobs.execute, log);
  scheduler.tick();
  const lease = (await jobs.started(run.id)).lease!;
  // The run never brought a session, and the prepare window closed on it.
  await dispatcher.expire(lease.id, 'no session was provided within the prepare timeout');

  jobs.end(run.id);
  await scheduler.drain();
  assert.equal(store.run(run.id).state, 'succeeded');
  assert.deepEqual(
    said('warn').map(line => [line.event, line.lease]),
    [['lease.release.failed', lease.id]],
  );
});

test('a finished run whose slot is still being taken back hears that the dispatcher keeps trying', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = store.enqueue(model('one'), 'local-model', 'a', 1);
  const spending = new Set<string>();
  const dispatcher = capacity(store, { 'local-model': { capacity: 1 } }, spending);
  const { log, said } = recorder();
  const jobs = work();
  const scheduler = new Scheduler(store, config, dispatcher, () => true, jobs.execute, log);
  scheduler.tick();
  const lease = (await jobs.started(run.id)).lease!;
  spending.add((await lease.provide({ agent: 'dev', directory: '/w' })).sessionId!);
  // The idle monitor strikes and the session spends on: the kill stands unconfirmed.
  await dispatcher.expire(lease.id, 'idle beyond the timeout');

  jobs.end(run.id);
  await scheduler.drain();
  assert.equal(dispatcher.held(), 1, 'the slot stays held until the kill confirms');
  assert.deepEqual(
    said('warn').map(line => [line.event, line.lease]),
    [['lease.expire.pending', lease.id]],
  );
});

test('an operator’s abort is the reason given to a run that ended without one', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = store.enqueue(check, 'local-model', 'a', 1);
  const jobs = work();
  const scheduler = new Scheduler(store, config, new TestCapacity(), () => false, jobs.execute);
  scheduler.tick();
  await jobs.started(run.id);
  store.requestCancel(run.id);
  scheduler.tick();

  jobs.end(run.id, { state: 'failed', result: null });
  await scheduler.drain();
  const done = store.run(run.id);
  assert.equal(done.state, 'blocked', 'an abort is not proof that the work stopped');
  assert.equal(done.error, 'Aborted by operator.');
});

test('a store that fails under a finishing run stops the scheduler, and drain says why', async () => {
  const store = new Store(':memory:');
  const run = store.enqueue(check, 'local-model', 'a', 1);
  const { log, said } = recorder();
  const jobs = work();
  const scheduler = new Scheduler(store, config, new TestCapacity(), () => false, jobs.execute, log);
  scheduler.tick();
  await jobs.started(run.id);
  store.close(); // the outcome has nowhere to go

  jobs.end(run.id);
  await assert.rejects(scheduler.drain());
  assert.equal(scheduler.stopped, true, 'an unreliable store ends dispatching');
  assert.deepEqual(
    said('error').map(line => line.event),
    ['scheduler.failed'],
  );
});

test('a grant that lands while a pass runs waits for that pass to end, then gets a pass of its own', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue(model('one'), 'local-model', 'a', 1);
  const second = store.enqueue(model('two'), 'local-model', 'b', 2);
  const pool = new TestCapacity(1);
  const other = pool.request({ service: 'other' });
  assert.ok('lease' in other);
  // Nothing in the shipped dispatcher calls back while a pass runs. The
  // scheduler promises to cope all the same, and this hook is the one point
  // inside a pass where a test can let another service's slot go.
  let midPass = () => {};
  const jobs = work();
  const scheduler = new Scheduler(
    store,
    config,
    pool,
    () => {
      midPass();
      return true;
    },
    jobs.execute,
  );
  scheduler.tick(); // the pool is full: the first run takes the queue place
  midPass = () => {
    midPass = () => {};
    void pool.release(other.lease.id);
  };
  scheduler.tick();
  await jobs.started(first.id);
  assert.equal(pool.heldCount(), 1, 'the freed slot went to the run that waited for it');

  jobs.end(first.id);
  await jobs.started(second.id);
  jobs.end(second.id);
  await scheduler.drain();
  assert.equal(pool.heldCount(), 0);
});

test('a grant for a request this scheduler never made is paid straight back', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const pool = new Heard(1);
  const scheduler = new Scheduler(store, config, pool, () => true, work().execute);
  // A queue place that a scheduler before this one left behind can still land here.
  const stray = pool.request({ service: 'jobs' });
  assert.ok('lease' in stray);
  pool.heard('req_from_before', stray.lease);
  assert.deepEqual(pool.released, [stray.lease.id]);
  assert.equal(scheduler.activeCount, 0);
});

test('a grant that arrives after the stop is paid straight back', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = store.enqueue(model('one'), 'local-model', 'a', 1);
  const pool = new Heard(1);
  const scheduler = new Scheduler(store, config, pool, () => true, work().execute);
  scheduler.stop();
  const late = pool.request({ service: 'jobs' });
  assert.ok('lease' in late);
  pool.heard('req_late', late.lease);
  assert.deepEqual(pool.released, [late.lease.id], 'stopped: nobody is left to hand the slot to');
  assert.equal(store.run(run.id).state, 'queued');
});
