import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';

const config = { maxConcurrent: 1, resources: { 'local-model': 1 }, pollMs: 100, agentSchedules: false as const };

test('a slow task queues the next task; execution failure blocks further dispatch', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue({ kind: 'system.check' }, 'local-model', 'one', 1);
  const second = store.enqueue({ kind: 'system.check' }, 'local-model', 'two', 2);
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
  assert.equal(store.get(second.id).state, 'queued');
  release();
  await scheduler.drain();
  assert.equal(store.get(first.id).state, 'blocked');
  scheduler.tick();
  assert.equal(calls, 1);
});

test('startup applies removed schedules before dispatching any stale queued occurrence', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncSchedules(
    [
      {
        id: 'old',
        cron: '* * * * *',
        timezone: 'UTC',
        resource: 'local-model',
        enabled: true,
        task: { kind: 'system.check' },
      },
    ],
    0,
  );
  store.materializeDue(60_000);
  let calls = 0;
  const scheduler = new Scheduler(store, config, async () => {
    calls++;
    return { state: 'succeeded', result: null };
  });
  // The host always reconciles configured schedules before its first tick.
  store.syncSchedules([], 61_000);
  scheduler.tick(61_000);
  await scheduler.drain();
  assert.equal(calls, 0);
  assert.equal(store.list()[0]!.state, 'cancelled');
});

test('jobs abort stops one running job; it ends blocked and keeps its capacity', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.enqueue({ kind: 'system.check' }, 'local-model', 'long');
  let seen: AbortSignal | undefined;
  const scheduler = new Scheduler(store, config, async (_job, context) => {
    seen = context.signal;
    if (!context.signal.aborted)
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { state: 'blocked', result: null, reason: 'Host stopped while working' };
  });
  scheduler.tick();
  assert.equal(scheduler.activeCount, 1);
  assert.throws(() => store.requestCancel('missing'), /Only a running job/);
  store.requestCancel(job.id);
  scheduler.tick();
  await scheduler.drain();
  assert.ok(seen?.aborted);
  const done = store.get(job.id);
  assert.equal(done.state, 'blocked');
  assert.match(done.error ?? '', /^Aborted by operator\./);
  assert.equal(
    store
      .history(job.id)
      .map(h => h.action)
      .includes('abort-requested'),
    true,
  );
  assert.equal(scheduler.stopped, false, 'aborting one job does not stop the scheduler');
});
