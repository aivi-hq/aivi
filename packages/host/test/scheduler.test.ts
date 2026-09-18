import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';

const config = configSchema.parse({ version: 1, scheduler: { agentSchedules: false } }).scheduler;

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
  const scheduler = new Scheduler(store, config, async () => {
    calls++;
    await pending;
    throw new Error('Tool may still be running');
  });
  scheduler.tick();
  await Promise.resolve();
  assert.equal(calls, 1);
  scheduler.tick();
  assert.equal(store.run(second.id).state, 'queued');
  release();
  await scheduler.drain();
  assert.equal(store.run(first.id).state, 'blocked');
  scheduler.tick();
  assert.equal(calls, 1);
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
  const scheduler = new Scheduler(store, config, async () => {
    calls++;
    return { state: 'succeeded', result: null };
  });
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
  const scheduler = new Scheduler(store, config, async (_run, context) => {
    seen = context.signal;
    if (!context.signal.aborted)
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { state: 'blocked', result: null, reason: 'Host stopped while working' };
  });
  scheduler.tick();
  assert.equal(scheduler.activeCount, 1);
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
  assert.equal(scheduler.stopped, false, 'aborting one run does not stop the scheduler');
});
