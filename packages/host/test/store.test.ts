import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scheduleSchema } from '@aivi/core';
import { Store } from '../src/store.ts';

const check = { kind: 'system.check' } as const;
const start = Date.parse('2026-09-13T00:00:00Z');
const schedule = () => scheduleSchema.parse({ id: 'daily', cron: '* * * * *', task: check });

test('schema v1 upgrades in place without losing existing jobs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-migration-'));
  const path = join(root, 'queue.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new Store(path);
  const job = old.enqueue(check, 'local-model', 'existing');
  old.db.exec(
    'DROP TABLE resource_leases; DROP TABLE migrations; DROP INDEX audit_job; ALTER TABLE jobs DROP COLUMN report; ALTER TABLE jobs DROP COLUMN cancel_requested; ALTER TABLE schedules DROP COLUMN source; PRAGMA user_version=1;',
  );
  old.close();
  const upgraded = new Store(path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.get(job.id).state, 'queued');
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 5);
  assert.equal(upgraded.get(job.id).report, null);
  assert.equal(upgraded.acquireLease('discord:one', 'discord', 'local-model', 1, { 'local-model': 1 }), true);
  assert.equal(upgraded.claim('host', 1, { 'local-model': 1 }), null);
  assert.equal(upgraded.leaseCount(), 1);
  assert.equal(upgraded.leases()[0]!.state, 'running');
});

test('adapters get versioned namespaced migrations and cannot downgrade', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const steps = ['CREATE TABLE demo_a(id INTEGER PRIMARY KEY)', 'ALTER TABLE demo_a ADD COLUMN note TEXT'];
  store.migrate('demo', [steps[0]!]);
  store.migrate('demo', steps); // second step applies once
  store.migrate('demo', steps); // idempotent
  store.db.prepare('INSERT INTO demo_a(id,note) VALUES(1,?)').run('ok');
  assert.throws(() => store.migrate('demo', [steps[0]!]), /newer than this adapter/);
});

test('adapter restart blocks only running leases it owns', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const pools = { 'local-model': 2 };
  assert.equal(store.acquireLease('discord:1', 'discord', 'local-model', 2, pools), true);
  assert.equal(store.acquireLease('slack:1', 'slack', 'local-model', 2, pools), true);
  assert.equal(store.blockLeasesOwnedBy('discord', 'restart'), 1);
  assert.deepEqual(
    store.leases().map(l => [l.id, l.state]),
    [
      ['discord:1', 'blocked'],
      ['slack:1', 'running'],
    ],
  );
  assert.throws(() => store.blockLease('missing', 'discord', 'x'), /Lost resource lease ownership/);
});

test('duplicate requests are idempotent, but changed payloads cannot reuse a key', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue(check, 'local-model', 'request-1', start);
  assert.equal(store.enqueue(check, 'local-model', 'request-1', start + 1).id, first.id);
  assert.throws(() => store.enqueue(check, 'other', 'request-1'), /different task/);
  assert.equal(store.list().length, 1);
});

test('claims share capacity across database connections and blocked work reserves its slot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-store-'));
  const a = new Store(join(root, 'queue.sqlite'));
  const b = new Store(join(root, 'queue.sqlite'));
  t.after(async () => {
    a.close();
    b.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = a.enqueue(check, 'local-model', 'a', start);
  const second = a.enqueue(check, 'local-model', 'b', start + 1);
  const third = a.enqueue(check, 'io', 'c', start + 2);
  const pools = { 'local-model': 1, io: 1 };
  assert.equal(a.claim('one', 2, pools)!.id, first.id);
  assert.equal(b.claim('two', 2, pools)!.id, third.id);
  a.finish(first.id, 'one', 'blocked', null, 'inspect native session');
  b.finish(third.id, 'two', 'succeeded', {}, 'done');
  assert.equal(b.claim('two', 2, pools), null);
  assert.throws(() => b.finish(first.id, 'two', 'succeeded', {}, 'wrong owner'), /Lost job ownership/);
  a.resolveBlocked(first.id, 'succeeded', 'Native session and all its child work have stopped');
  assert.equal(b.claim('two', 2, pools)!.id, second.id);
  assert.equal(a.history(first.id).at(-1)!.action, 'operator-resolved');
});

test('downtime coalesces to one occurrence; outstanding runs suppress subsequent ticks', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncSchedules([schedule()], start);
  assert.equal(store.materializeDue(start + 10 * 60_000), 1);
  assert.equal(store.materializeDue(start + 11 * 60_000), 0);
  assert.equal(store.list().length, 1);
  const job = store.claim('owner', 1, { 'local-model': 1 })!;
  store.finish(job.id, 'owner', 'succeeded', null, 'done');
  assert.equal(store.materializeDue(start + 11 * 60_000), 0);
  assert.equal(store.materializeDue(start + 12 * 60_000), 1);
});

test('reconciling schedules preserves due times but cancels stale queued definitions', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const original = schedule();
  store.syncSchedules([original], start);
  store.syncSchedules([original], start + 30_000);
  assert.equal(store.materializeDue(start + 60_000), 1);
  const stale = store.list()[0]!;
  store.syncSchedules([{ ...original, cron: '*/2 * * * *' }], start + 61_000);
  assert.equal(store.get(stale.id).state, 'cancelled');
  assert.equal(store.materializeDue(start + 120_000), 1);
  const running = store.claim('owner', 1, { 'local-model': 1 })!;
  store.syncSchedules([], start + 121_000);
  assert.equal(store.get(running.id).state, 'running');
  assert.equal(store.materializeDue(start + 3600_000), 0);
});

test('restart recovery blocks interrupted work without resubmitting it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'queue.sqlite');
  const before = new Store(path);
  const job = before.enqueue(check, 'local-model', 'one');
  before.claim('old', 1, { 'local-model': 1 });
  before.attachSession(job.id, 'old', 'ses_test');
  before.close();
  const after = new Store(path);
  t.after(() => after.close());
  after.acquireDaemon('new');
  assert.equal(after.get(job.id).state, 'blocked');
  assert.equal(after.get(job.id).sessionId, 'ses_test');
  assert.equal(after.claim('new', 1, { 'local-model': 1 }), null);
  assert.throws(() => after.acquireDaemon('duplicate'), /already owns/);
  assert.throws(() => after.cancelQueued(job.id), /Only queued/);
  assert.throws(() => after.resolveBlocked(job.id, 'failed', ' '), /reason/);
  after.releaseDaemon('new');
});

test('agent-created schedules live beside config ones: sync never touches them, mutations never touch config ones', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncSchedules([schedule()], start);
  const agent = store.addSchedule(
    scheduleSchema.parse({ id: 'agent-1', cron: '0 9 * * 1', timezone: 'Europe/Amsterdam', task: check }),
    start,
  );
  assert.equal(agent.source, 'agent');
  assert.deepEqual(
    store.schedules().map(s => [s.spec.id, s.source, s.enabled]),
    [
      ['daily', 'config', true],
      ['agent-1', 'agent', true],
    ],
  );
  // Reconciling the config (even to nothing) leaves the agent schedule enabled and unchanged.
  store.syncSchedules([], start + 1);
  assert.deepEqual(
    store.schedules().map(s => [s.spec.id, s.enabled]),
    [
      ['daily', false],
      ['agent-1', true],
    ],
  );
  assert.throws(() => store.syncSchedules([{ ...schedule(), id: 'agent-1' }], start + 2), /agent-created/);
  assert.throws(() => store.setScheduleEnabled('daily', false), /defined in aivi.json/);
  assert.throws(() => store.removeSchedule('daily'), /defined in aivi.json/);

  // Pause cancels queued occurrences; resume re-anchors to the next future occurrence.
  store.materializeDue(agent.nextAt);
  const queued = store.list().find(j => j.scheduleId === 'agent-1')!;
  assert.equal(queued.state, 'queued');
  store.setScheduleEnabled('agent-1', false, agent.nextAt + 1);
  assert.equal(store.get(queued.id).state, 'cancelled');
  assert.equal(store.history(queued.id).at(-1)!.reason, 'schedule paused');
  assert.equal(store.materializeDue(agent.nextAt + 8 * 86_400_000), 0, 'paused schedules never catch up');
  const resumed = store.setScheduleEnabled('agent-1', true, agent.nextAt + 8 * 86_400_000);
  assert.ok(resumed.nextAt > agent.nextAt + 8 * 86_400_000);

  // Manual run: one outstanding occurrence at a time, like cron ones.
  const manual = store.runSchedule('agent-1', resumed.nextAt - 1000);
  assert.equal(manual.scheduleId, 'agent-1');
  assert.throws(() => store.runSchedule('agent-1', resumed.nextAt - 900), /outstanding/);
  assert.equal(store.lastRun('agent-1')!.id, manual.id);
  store.removeSchedule('agent-1', resumed.nextAt - 800);
  assert.equal(store.get(manual.id).state, 'cancelled');
  assert.throws(() => store.schedule('agent-1'), /Unknown schedule/);
});

test('a one-off with a future due time waits in the queue until then', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.enqueue(check, 'local-model', 'later', start, null, {
    due: start + 3600_000,
    reason: 'agent:ses_1',
  });
  assert.equal(job.scheduledFor, start + 3600_000);
  assert.equal(store.history(job.id)[0]!.reason, 'agent:ses_1');
  assert.equal(store.claim('host', 1, { 'local-model': 1 }, start + 3599_000), null);
  assert.equal(store.claim('host', 1, { 'local-model': 1 }, start + 3600_000)?.id, job.id);
});

test('misfire.skipAfterMs records a too-late occurrence as skipped instead of running it', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const standup = scheduleSchema.parse({
    id: 'standup',
    cron: '0 9 * * *',
    task: check,
    misfire: { skipAfterMs: 1800_000 },
  });
  store.syncSchedules([standup], start);
  const nine = store.schedule('standup').nextAt;
  assert.equal(store.materializeDue(nine + 3600_000), 0, 'nothing runnable was created');
  const skipped = store.list()[0]!;
  assert.equal(skipped.state, 'cancelled');
  assert.match(store.history(skipped.id).at(-1)!.reason, /^missed by 3600s/);
  assert.equal(store.history(skipped.id).at(-1)!.action, 'skipped');
  assert.ok(store.schedule('standup').nextAt > nine + 3600_000, 'the schedule moved on to the next occurrence');
  // Within the window the occurrence runs normally.
  const next = store.schedule('standup').nextAt;
  assert.equal(store.materializeDue(next + 60_000), 1);
});

test('recent outcomes and failure streaks are read from the jobs table', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncSchedules([schedule()], start);
  const finish = (state: 'succeeded' | 'failed', at: number) => {
    store.materializeDue(at);
    const job = store.claim('host', 1, { 'local-model': 1 }, at)!;
    store.finish(job.id, 'host', state, null, state, at);
  };
  finish('succeeded', start + 60_000);
  finish('failed', start + 120_000);
  finish('failed', start + 180_000);
  finish('failed', start + 240_000);
  assert.equal(store.failureStreak('daily'), 3);
  assert.equal(store.recent(start + 150_000).length, 2);
  assert.equal(store.recent(start + 150_000)[0]!.finishedAt, start + 240_000, 'newest first');
  finish('succeeded', start + 300_000);
  assert.equal(store.failureStreak('daily'), 0);
});
