import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobSchema } from '@aivi/core';
import { Store } from '../src/store.ts';

const check = { kind: 'invocation', name: 'system.check' } as const;
const start = Date.parse('2026-09-13T00:00:00Z');
const daily = () => jobSchema.parse({ id: 'daily', cron: '* * * * *', task: check });
const pools = { 'local-model': 1 };
const iso = (t: number) => new Date(t).toISOString();

test('schema v1 upgrades in place without losing existing runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-migration-'));
  const path = join(root, 'queue.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new Store(path);
  // Rebuild the v1 shape by hand: one schedule-less job in the old `jobs` table.
  old.db.exec(`
    DROP TABLE runs; DROP TABLE jobs; DROP TABLE resource_leases; DROP TABLE migrations; DROP INDEX audit_job;
    DROP TABLE IF EXISTS person; DROP TABLE IF EXISTS token;
    CREATE TABLE schedules(id TEXT PRIMARY KEY, spec TEXT NOT NULL, fingerprint TEXT NOT NULL,
      next_at INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
    CREATE TABLE jobs(id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      task TEXT NOT NULL, resource TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, scheduled_for INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      schedule_id TEXT, session_id TEXT, owner TEXT, result TEXT, error TEXT);
    INSERT INTO jobs VALUES('run-1','existing','f','{"kind":"invocation","name":"system.check"}','local-model','queued',${start},${start},NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    ALTER TABLE audit RENAME COLUMN run_id TO job_id;
    INSERT INTO audit(job_id,at,action,reason) VALUES('run-1',${start},'enqueued','operator');
    PRAGMA user_version=1;
  `);
  old.close();
  const upgraded = new Store(path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.run('run-1').state, 'queued');
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 8);
  assert.equal(upgraded.run('run-1').report, null);
  assert.equal(upgraded.history('run-1')[0]!.action, 'enqueued');
  assert.equal(upgraded.acquireLease('discord:one', 'discord', 'local-model', 1, pools), true);
  assert.equal(upgraded.claim('host', 1, pools), null);
  assert.equal(upgraded.leaseCount(), 1);
  assert.equal(upgraded.leases()[0]!.state, 'running');
});

test('schema v7 gives every one-off its own job definition and keeps schedule anchors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-v7-migration-'));
  const path = join(root, 'queue.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new Store(path);
  const spec = jobSchema.parse({ id: 'nightly', cron: '0 3 * * *', task: check, misfire: { graceSeconds: 3600 } });
  old.syncJobs([spec], [], start);
  const { nextAt } = old.job('nightly');
  // Recreate the v6 tables from the v7 ones: definitions in `schedules`, executions in `jobs`.
  old.db.exec(`
    CREATE TABLE schedules(id TEXT PRIMARY KEY, spec TEXT NOT NULL, fingerprint TEXT NOT NULL,
      next_at INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      source TEXT NOT NULL DEFAULT 'config' CHECK(source IN ('config','agent')));
    INSERT INTO schedules SELECT id,spec,fingerprint,next_at,1,source FROM jobs;
    DROP TABLE jobs; DROP TABLE runs;
    DROP TABLE IF EXISTS person; DROP TABLE IF EXISTS token;
    CREATE TABLE jobs(id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      task TEXT NOT NULL, resource TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','blocked','cancelled')),
      created_at INTEGER NOT NULL, scheduled_for INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      schedule_id TEXT, session_id TEXT, owner TEXT, result TEXT, error TEXT, report TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0);
    INSERT INTO jobs(id,dedupe_key,fingerprint,task,resource,state,created_at,scheduled_for,finished_at,schedule_id,report) VALUES
      ('run-a','agent:ses_1:msg_1','f','{"kind":"invocation","name":"system.check"}','local-model','queued',${start},${start + 3_600_000},NULL,NULL,
        '{"to":"session","session":"ses_1","on":"always"}'),
      ('run-b','manual:smoke','f','{"kind":"invocation","name":"system.check"}','maintenance','succeeded',${start},${start},${start + 5},NULL,NULL),
      ('run-c','schedule:nightly:1','f','{"kind":"invocation","name":"system.check"}','local-model','failed',${start},${start},${start + 5},'nightly',NULL);
    ALTER TABLE audit RENAME COLUMN run_id TO job_id;
    PRAGMA user_version=6;
  `);
  old.close();
  const upgraded = new Store(path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.job('nightly').nextAt, nextAt, 'the recurring definition keeps its anchor');
  assert.equal(upgraded.job('nightly').state, 'active');
  const a = upgraded.run('run-a');
  const agentJob = upgraded.job(a.jobId);
  assert.match(a.jobId, /^agent-[0-9a-f]{8}$/);
  assert.equal(agentJob.source, 'agent');
  assert.equal(agentJob.state, 'active', 'its run is still queued');
  assert.equal(agentJob.nextAt, null, 'the run exists, so the occurrence is spent');
  assert.equal(agentJob.spec.at, iso(start + 3_600_000));
  assert.deepEqual(agentJob.spec.report, { to: 'session', session: 'ses_1', on: 'always' });
  const b = upgraded.run('run-b');
  assert.match(b.jobId, /^job-[0-9a-f]{8}$/);
  assert.equal(upgraded.job(b.jobId).source, 'operator');
  assert.equal(upgraded.job(b.jobId).state, 'done');
  assert.equal(upgraded.job(b.jobId).spec.resource, 'maintenance');
  assert.equal(upgraded.run('run-c').jobId, 'nightly');
  assert.equal(upgraded.lastRun('nightly')!.id, 'run-c');
  assert.equal(upgraded.jobs().length, 3);
  // The same definition in the new shape is not a change.
  upgraded.syncJobs([spec], [], start + 60_000);
  assert.equal(upgraded.job('nightly').nextAt, nextAt);
  // Idempotency keys survive on the definition.
  assert.throws(
    () =>
      upgraded.addJob({ ...agentJob.spec, id: 'agent-x', resource: 'other' }, 'agent', start, {
        dedupeKey: 'agent:ses_1:msg_1',
      }),
    /different task/,
  );
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
  const two = { 'local-model': 2 };
  assert.equal(store.acquireLease('discord:1', 'discord', 'local-model', 2, two), true);
  assert.equal(store.acquireLease('slack:1', 'slack', 'local-model', 2, two), true);
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

test('an immediate one-off is a job with its run; duplicate keys are idempotent, changed payloads refused', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = store.enqueue(check, 'local-model', 'request-1', start);
  assert.equal(store.enqueue(check, 'local-model', 'request-1', start + 1).id, first.id);
  assert.throws(() => store.enqueue(check, 'other', 'request-1'), /different task/);
  assert.equal(store.runs().length, 1);
  const job = store.job(first.jobId);
  assert.equal(job.source, 'operator');
  assert.equal(job.spec.at, iso(start));
  assert.deepEqual([job.state, job.nextAt], ['active', null]);
  assert.equal(store.history(first.id)[0]!.reason, 'operator');
  const claimed = store.claim('host', 1, pools, start)!;
  store.finish(claimed.id, 'host', 'succeeded', null, 'done', start + 10);
  assert.equal(store.job(first.jobId).state, 'done', 'the one-off is done when its run finishes');
  assert.equal(store.nextDue(start), null);
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
  const two = { 'local-model': 1, io: 1 };
  assert.equal(a.claim('one', 2, two)!.id, first.id);
  assert.equal(b.claim('two', 2, two)!.id, third.id);
  a.finish(first.id, 'one', 'blocked', null, 'inspect native session');
  b.finish(third.id, 'two', 'succeeded', {}, 'done');
  assert.equal(b.claim('two', 2, two), null);
  assert.throws(() => b.finish(first.id, 'two', 'succeeded', {}, 'wrong owner'), /Lost run ownership/);
  assert.equal(a.job(first.jobId).state, 'active', 'a blocked run keeps its one-off open');
  a.resolveBlocked(first.id, 'succeeded', 'Native session and all its child work have stopped');
  assert.equal(a.job(first.jobId).state, 'done');
  assert.equal(b.claim('two', 2, two)!.id, second.id);
  assert.equal(a.history(first.id).at(-1)!.action, 'operator-resolved');
});

test('an occurrence within its grace runs; outstanding runs suppress subsequent ticks', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([daily()], [], start);
  assert.equal(store.materializeDue(start + 60_000).created, 1);
  assert.equal(store.materializeDue(start + 61_000).created, 0);
  assert.equal(store.runs().length, 1);
  const run = store.claim('owner', 1, pools)!;
  store.finish(run.id, 'owner', 'succeeded', null, 'done');
  assert.equal(store.materializeDue(start + 61_000).created, 0);
  assert.equal(store.materializeDue(start + 120_000).created, 1);
  assert.equal(store.nextDue(start + 120_000), start + 180_000);
});

test('downtime past the grace records one missed run per job for the whole gap and moves on', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([daily()], [], start);
  // A week down at one-minute cadence: one line, not ten thousand.
  const back = start + 7 * 86_400_000 + 30_000;
  const { created, missed } = store.materializeDue(back);
  assert.equal(created, 0);
  assert.equal(missed.length, 1);
  const run = missed[0]!;
  assert.equal(run.state, 'missed');
  assert.equal(run.scheduledFor, start + 60_000, 'the occurrence the gap started with');
  assert.equal(run.finishedAt, back);
  assert.match(run.error ?? '', /^missed: aivi was not running at Sep 13, 2026, 12:01.AM \(UTC\)$/);
  assert.deepEqual(
    store.history(run.id).map(h => h.action),
    ['missed'],
  );
  assert.equal(store.job('daily').nextAt, back + 30_000, 'the next occurrence is in the future');
  assert.equal(store.claim('host', 1, pools, back), null, 'a missed run never executes');
  assert.equal(store.recent(back).length, 1, 'missed runs are recent outcomes');
  assert.equal(store.failureStreak('daily'), 0, 'a missed run says nothing about the job itself');
  // Per-job grace overrides the default: a lenient job runs however late it is found.
  const lenient = jobSchema.parse({
    id: 'lenient',
    cron: '* * * * *',
    task: check,
    misfire: { graceSeconds: 864_000 },
  });
  store.syncJobs([daily(), lenient], [], back);
  const later = store.materializeDue(back + 86_400_000, 1000);
  assert.equal(later.created, 1);
  assert.equal(later.missed.length, 1);
  assert.equal(later.missed[0]!.jobId, 'daily');
  assert.equal(store.runs({ jobId: 'lenient', state: 'queued' }).length, 1);
});

test('a one-off fires once within its grace, or is missed; then its definition is done or missed', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const at = start + 3_600_000;
  const reminder = store.addJob(
    jobSchema.parse({ id: 'agent-1', title: 'Coffee', at: iso(at), task: check }),
    'agent',
    start,
    { dedupeKey: 'agent:ses_1:msg_1', reason: 'agent:ses_1' },
  );
  assert.deepEqual([reminder.state, reminder.nextAt, reminder.source], ['active', at, 'agent']);
  assert.equal(store.runs().length, 0, 'nothing is queued before the instant');
  assert.equal(store.nextDue(start), at);
  assert.equal(store.materializeDue(at - 1).created, 0);
  assert.equal(store.materializeDue(at + 10_000).created, 1);
  const run = store.runs({ jobId: 'agent-1' })[0]!;
  assert.equal(run.scheduledFor, at);
  assert.equal(store.history(run.id)[0]!.reason, 'job:agent-1');
  assert.deepEqual([store.job('agent-1').state, store.job('agent-1').nextAt], ['active', null]);
  assert.equal(store.materializeDue(at + 20_000).created, 0, 'it fires once');
  store.cancelQueued(run.id, at + 30_000);
  assert.equal(store.job('agent-1').state, 'done', 'a cancelled run still spends the single occurrence');
  assert.throws(() => store.setJobEnabled('agent-1', true), /has finished/);

  const late = store.addJob(jobSchema.parse({ id: 'agent-2', at: iso(at), task: check }), 'agent', start);
  const found = store.materializeDue(at + 3_600_000);
  assert.equal(found.missed[0]!.jobId, 'agent-2');
  assert.deepEqual([store.job('agent-2').state, store.job('agent-2').nextAt], ['missed', null]);
  assert.ok(late);

  // Paused before its time: never fires; resumed afterwards it is found late and missed, honestly.
  store.addJob(jobSchema.parse({ id: 'agent-3', at: iso(at + 10_000), task: check }), 'agent', start);
  store.setJobEnabled('agent-3', false, start + 1);
  assert.equal(store.materializeDue(at + 20_000).created, 0);
  assert.equal(store.setJobEnabled('agent-3', true, at + 20_000).nextAt, at + 10_000);
  assert.equal(store.materializeDue(at + 20_000).created, 1, 'within grace it still runs');
});

test('reconciling config preserves due times but cancels stale queued runs of changed definitions', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const original = daily();
  store.syncJobs([original], [], start);
  store.syncJobs([original], [], start + 30_000);
  assert.equal(store.materializeDue(start + 60_000).created, 1);
  const stale = store.runs()[0]!;
  store.syncJobs([{ ...original, cron: '*/2 * * * *' }], [], start + 61_000);
  assert.equal(store.run(stale.id).state, 'cancelled');
  assert.equal(store.materializeDue(start + 120_000).created, 1);
  const running = store.claim('owner', 1, pools)!;
  store.syncJobs([], [], start + 121_000);
  assert.equal(store.run(running.id).state, 'running');
  assert.equal(store.job('daily').state, 'paused');
  assert.equal(store.materializeDue(start + 3600_000).created, 0);
});

test('system jobs are seeded by sync, listed with the others, and removed when the setting goes away', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const retention = jobSchema.parse({
    id: 'retention',
    cron: '0 4 * * *',
    task: { kind: 'invocation', name: 'runs.prune', args: { olderThanDays: 30 } },
  });
  store.syncJobs([daily()], [retention], start);
  assert.deepEqual(
    store.jobs().map(j => [j.spec.id, j.source, j.state]),
    [
      ['daily', 'config', 'active'],
      ['retention', 'system', 'active'],
    ],
  );
  assert.throws(
    () => store.syncJobs([{ ...daily(), id: 'retention' }], [], start),
    /already exists with source system/,
  );
  assert.throws(() => store.setJobEnabled('retention', false), /defined in aivi.json/);
  store.materializeDue(store.job('retention').nextAt!);
  const queued = store.runs({ jobId: 'retention' })[0]!;
  store.syncJobs([daily()], [], start + 1);
  assert.throws(() => store.job('retention'), /Unknown job/);
  assert.equal(store.run(queued.id).state, 'cancelled');
});

test('restart recovery blocks interrupted work without resubmitting it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'queue.sqlite');
  const before = new Store(path);
  const run = before.enqueue(check, 'local-model', 'one');
  before.claim('old', 1, pools);
  before.attachSession(run.id, 'old', 'ses_test');
  before.close();
  const after = new Store(path);
  t.after(() => after.close());
  after.acquireDaemon('new');
  assert.equal(after.run(run.id).state, 'blocked');
  assert.equal(after.run(run.id).sessionId, 'ses_test');
  assert.equal(after.claim('new', 1, pools), null);
  assert.throws(() => after.acquireDaemon('duplicate'), /already owns/);
  assert.throws(() => after.cancelQueued(run.id), /Only queued/);
  assert.throws(() => after.resolveBlocked(run.id, 'failed', ' '), /reason/);
  after.releaseDaemon('new');
});

test('agent-created jobs live beside config ones: sync never touches them, mutations never touch config ones', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([daily()], [], start);
  const agent = store.addJob(
    jobSchema.parse({ id: 'agent-1', cron: '0 9 * * 1', timezone: 'Europe/Amsterdam', task: check }),
    'agent',
    start,
  );
  assert.equal(agent.source, 'agent');
  assert.deepEqual(
    store.jobs().map(j => [j.spec.id, j.source, j.state]),
    [
      ['daily', 'config', 'active'],
      ['agent-1', 'agent', 'active'],
    ],
  );
  // Reconciling the config (even to nothing) leaves the agent job active and unchanged.
  store.syncJobs([], [], start + 1);
  assert.deepEqual(
    store.jobs().map(j => [j.spec.id, j.state]),
    [
      ['daily', 'paused'],
      ['agent-1', 'active'],
    ],
  );
  assert.throws(
    () => store.syncJobs([{ ...daily(), id: 'agent-1' }], [], start + 2),
    /already exists with source agent/,
  );
  assert.throws(() => store.setJobEnabled('daily', false), /defined in aivi.json/);
  assert.throws(() => store.removeJob('daily'), /defined in aivi.json/);
  assert.throws(() => store.addJob(agent.spec, 'agent', start), /already exists/);

  // Pause cancels queued runs; resume re-anchors to the next future occurrence.
  store.materializeDue(agent.nextAt!);
  const queued = store.runs().find(r => r.jobId === 'agent-1')!;
  assert.equal(queued.state, 'queued');
  store.setJobEnabled('agent-1', false, agent.nextAt! + 1);
  assert.equal(store.run(queued.id).state, 'cancelled');
  assert.equal(store.history(queued.id).at(-1)!.reason, 'job paused');
  assert.equal(store.materializeDue(agent.nextAt! + 8 * 86_400_000).created, 0, 'paused jobs never catch up');
  const resumed = store.setJobEnabled('agent-1', true, agent.nextAt! + 8 * 86_400_000);
  assert.ok(resumed.nextAt! > agent.nextAt! + 8 * 86_400_000);

  // Manual run: one outstanding run at a time, like scheduled ones.
  const manual = store.runJob('agent-1', resumed.nextAt! - 1000);
  assert.equal(manual.jobId, 'agent-1');
  assert.throws(() => store.runJob('agent-1', resumed.nextAt! - 900), /outstanding/);
  assert.equal(store.lastRun('agent-1')!.id, manual.id);
  store.removeJob('agent-1', resumed.nextAt! - 800);
  assert.equal(store.run(manual.id).state, 'cancelled');
  assert.throws(() => store.job('agent-1'), /Unknown job/);
});

test('recent outcomes and failure streaks are read from the runs table', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([daily()], [], start);
  const finish = (state: 'succeeded' | 'failed', at: number) => {
    store.materializeDue(at);
    const run = store.claim('host', 1, pools, at)!;
    store.finish(run.id, 'host', state, null, state, at);
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
  assert.equal(store.runs({ state: 'failed' }).length, 3);
  assert.deepEqual(
    store.runs({ limit: 2 }).map(r => r.finishedAt),
    [start + 240_000, start + 300_000],
    'limit keeps the newest, still oldest first',
  );
});

test('prune deletes finished runs with their audit rows and finished one-off jobs, never blocked or recurring ones', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncJobs([{ ...daily(), misfire: { graceSeconds: 100 * 86_400 } }], [], start);
  const day = 86_400_000;
  const cycle = (at: number, state: 'succeeded' | 'blocked') => {
    store.materializeDue(at);
    const run = store.claim('host', 5, { 'local-model': 5 }, at)!;
    store.finish(run.id, 'host', state, null, state, at);
    return run;
  };
  const oldRun = cycle(start + 60_000, 'succeeded');
  const blocked = cycle(start + 120_000, 'blocked');
  store.resolveBlocked(blocked.id, 'failed', 'looked', start + 121_000);
  const oldOneOff = store.enqueue(check, 'local-model', 'old', start + 1000);
  store.finish(
    store.claim('host', 5, { 'local-model': 5 }, start + 1000)!.id,
    'host',
    'succeeded',
    null,
    'ok',
    start + 2000,
  );
  const stuck = store.enqueue(check, 'local-model', 'stuck', start + 3000);
  store.finish(
    store.claim('host', 5, { 'local-model': 5 }, start + 3000)!.id,
    'host',
    'blocked',
    null,
    'look',
    start + 4000,
  );
  const fresh = cycle(start + 40 * day, 'succeeded');
  const result = store.prune(start + 30 * day);
  assert.deepEqual(result, { runs: 3, jobs: 1 });
  assert.throws(() => store.run(oldRun.id), /Unknown run/);
  assert.equal(store.history(oldRun.id).length, 0);
  assert.throws(() => store.job(oldOneOff.jobId), /Unknown job/);
  assert.equal(store.run(stuck.id).state, 'blocked', 'blocked work is never pruned');
  assert.equal(store.job(stuck.jobId).state, 'active');
  assert.equal(store.run(fresh.id).state, 'succeeded');
  assert.equal(store.job('daily').state, 'active', 'recurring definitions stay');
});

test('every token belongs to a person and is stored only as a hash', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const nemo = store.createPerson({ name: 'Nemo', email: 'nemo@example.com' }, start);
  assert.match(nemo.id, /^person-[0-9a-f]{8}$/);
  assert.deepEqual(store.person(nemo.id), nemo);
  assert.equal(store.person('person-none'), null);
  const { token, secret } = store.mintToken(nemo.id, 'laptop', start + 1000);
  assert.match(secret, /^aivi-[0-9a-f]{32}$/);
  assert.notEqual(token.hash, secret, 'the secret never sits in the database');
  assert.deepEqual(store.personForToken(secret), { person: nemo, token });
  assert.equal(store.personForToken('aivi-never-minted'), null);
  // The foreign key is the rule: no token row without its person.
  assert.throws(
    () =>
      store.db
        .prepare('INSERT INTO token(token_hash,person_id,label,created_at) VALUES(?,?,?,?)')
        .run('x'.repeat(64), 'person-none', 'ghost', start),
    /FOREIGN KEY/,
  );
  assert.throws(() => store.mintToken('person-none', 'ghost'), /Unknown person/);
  assert.deepEqual(store.people(), [nemo]);
  const ada = store.createPerson({ name: 'Ada' }, start + 1);
  assert.deepEqual(store.people(), [nemo, ada]);
});
