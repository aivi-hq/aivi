import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobState, Report, Schedule, Task } from '@aivi/core';
import { nextOccurrence } from '@aivi/core';

type Row = Record<string, unknown>;
export interface Lease {
  id: string;
  owner: string;
  resource: string;
  state: 'running' | 'blocked';
  createdAt: number;
  reason: string | null;
}
export interface AuditEntry {
  seq: number;
  jobId: string;
  at: number;
  action: string;
  reason: string;
}
const lease = (r: Row): Lease => ({
  id: String(r.id),
  owner: String(r.owner),
  resource: String(r.resource),
  state: r.state as Lease['state'],
  createdAt: Number(r.created_at),
  reason: r.reason === null ? null : String(r.reason),
});
const audit = (r: Row): AuditEntry => ({
  seq: Number(r.seq),
  jobId: String(r.job_id),
  at: Number(r.at),
  action: String(r.action),
  reason: String(r.reason),
});
const states: JobState[] = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const job = (r: Row): Job => ({
  id: String(r.id),
  task: JSON.parse(String(r.task)) as Task,
  resource: String(r.resource),
  state: r.state as JobState,
  createdAt: Number(r.created_at),
  scheduledFor: Number(r.scheduled_for),
  startedAt: r.started_at === null ? null : Number(r.started_at),
  finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  scheduleId: r.schedule_id as string | null,
  sessionId: r.session_id as string | null,
  owner: r.owner as string | null,
  error: r.error as string | null,
  result: r.result === null ? null : JSON.parse(String(r.result)),
  report: r.report === null || r.report === undefined ? null : (JSON.parse(String(r.report)) as Report),
});

const HOST_SCHEMA_VERSION = 6;

/** Pre-v6 reports overloaded `channel`: a session id for `to: "session"`, a platform channel id for a module name. */
function migrateReport(raw: unknown): Report | null {
  const old = raw as { to?: string; channel?: string; on?: Report['on'] } | null;
  if (!old || typeof old !== 'object' || !old.to) return null;
  if ('session' in old || 'module' in old) return raw as Report;
  if (!old.channel) return null;
  if (old.to === 'session') return { to: 'session', session: old.channel, on: old.on ?? 'always' };
  return { to: 'channel', module: old.to, channel: old.channel, on: old.on ?? 'always' };
}

export type ScheduleSource = 'config' | 'agent';
export interface ScheduleEntry {
  spec: Schedule;
  nextAt: number;
  enabled: boolean;
  source: ScheduleSource;
}
const scheduleEntry = (r: Row): ScheduleEntry => ({
  spec: JSON.parse(String(r.spec)) as Schedule,
  nextAt: Number(r.next_at),
  enabled: Boolean(Number(r.enabled)),
  source: r.source as ScheduleSource,
});
export interface EnqueueOptions {
  report?: Report | null;
  /** Earliest start; a one-off "run at" is simply a queued job with a future due time. */
  due?: number;
  /** Audit reason for the `enqueued` entry; default `operator`. */
  reason?: string;
}

/**
 * Durable host state in one SQLite file. Host tables (jobs, schedules, leases,
 * daemon, audit) are only touched through this class. Adapters may own their
 * own namespaced tables in the same database: declare them with `migrate()`
 * and access them through `db`, never host tables.
 */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.transaction(() => {
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > HOST_SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this host`);
      if (version === 0)
        this.db.exec(`
        CREATE TABLE schedules(id TEXT PRIMARY KEY, spec TEXT NOT NULL, fingerprint TEXT NOT NULL,
          next_at INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
        CREATE TABLE jobs(id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
          task TEXT NOT NULL, resource TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','blocked','cancelled')),
          created_at INTEGER NOT NULL, scheduled_for INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
          schedule_id TEXT, session_id TEXT, owner TEXT, result TEXT, error TEXT);
        CREATE INDEX jobs_ready ON jobs(state,scheduled_for,created_at);
        CREATE UNIQUE INDEX one_outstanding_schedule ON jobs(schedule_id)
          WHERE schedule_id IS NOT NULL AND state IN ('queued','running','blocked');
        CREATE TABLE daemon(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);
        CREATE TABLE audit(seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at INTEGER NOT NULL,
          action TEXT NOT NULL, reason TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      if (version < 2)
        this.db.exec(`
        CREATE TABLE resource_leases(id TEXT PRIMARY KEY, owner TEXT NOT NULL, resource TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('running','blocked')), created_at INTEGER NOT NULL, reason TEXT);
        PRAGMA user_version=2;
      `);
      if (version < 3)
        this.db.exec(`
        CREATE INDEX audit_job ON audit(job_id,seq);
        CREATE TABLE migrations(namespace TEXT PRIMARY KEY, version INTEGER NOT NULL);
        PRAGMA user_version=3;
      `);
      if (version < 4)
        this.db.exec(`
        ALTER TABLE jobs ADD COLUMN report TEXT;
        PRAGMA user_version=4;
      `);
      if (version < 5)
        this.db.exec(`
        ALTER TABLE schedules ADD COLUMN source TEXT NOT NULL DEFAULT 'config' CHECK(source IN ('config','agent'));
        ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=5;
      `);
      if (version < 6) {
        for (const row of this.db.prepare('SELECT id,report FROM jobs WHERE report IS NOT NULL').all()) {
          const report = migrateReport(JSON.parse(String(row.report)));
          this.db
            .prepare('UPDATE jobs SET report=? WHERE id=?')
            .run(report ? JSON.stringify(report) : null, String(row.id));
        }
        // The fingerprint follows the spec so an unchanged schedule keeps its next occurrence on the next sync.
        for (const row of this.db.prepare('SELECT id,spec FROM schedules').all()) {
          const spec = JSON.parse(String(row.spec)) as Schedule;
          if (!spec.report) continue;
          const report = migrateReport(spec.report);
          if (report) spec.report = report;
          else delete spec.report;
          this.db
            .prepare('UPDATE schedules SET spec=?,fingerprint=? WHERE id=?')
            .run(JSON.stringify(spec), hash(spec), String(row.id));
        }
        this.db.exec('PRAGMA user_version=6');
      }
    });
  }
  close(): void {
    this.db.close();
  }
  /**
   * Apply an adapter's ordered schema steps once each. `steps[i]` is version i+1.
   * Adapters must prefix their table names with their namespace.
   */
  migrate(namespace: string, steps: readonly string[]): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT version FROM migrations WHERE namespace=?').get(namespace);
      const current = row ? Number(row.version) : 0;
      if (current > steps.length) throw new Error(`${namespace} schema ${current} is newer than this adapter`);
      for (let i = current; i < steps.length; i++) this.db.exec(steps[i]!);
      this.db
        .prepare(
          'INSERT INTO migrations(namespace,version) VALUES(?,?) ON CONFLICT(namespace) DO UPDATE SET version=excluded.version',
        )
        .run(namespace, steps.length);
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private record(id: string, action: string, reason: string, now: number): void {
    this.db.prepare('INSERT INTO audit(job_id,at,action,reason) VALUES(?,?,?,?)').run(id, now, action, reason);
  }
  /** Append an audit entry that is not a state transition (for example a delivery attempt). */
  note(id: string, action: string, reason: string, now = Date.now()): void {
    this.record(id, action, reason, now);
  }
  list(): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all() as Row[]).map(job);
  }
  get(id: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown job: ${id}`);
    return job(row);
  }
  counts(): Record<JobState, number> {
    const result = Object.fromEntries(states.map(s => [s, 0])) as Record<JobState, number>;
    for (const r of this.db.prepare('SELECT state,count(*) AS n FROM jobs GROUP BY state').all())
      result[r.state as JobState] = Number(r.n);
    return result;
  }
  enqueue(
    task: Task,
    resource: string,
    dedupeKey: string,
    now = Date.now(),
    report: Report | null = null,
    options: Omit<EnqueueOptions, 'report'> = {},
  ): Job {
    return this.transaction(() =>
      this.insert(task, resource, dedupeKey, now, options.due ?? now, null, report, options.reason ?? 'operator'),
    );
  }
  private insert(
    task: Task,
    resource: string,
    key: string,
    now: number,
    due: number,
    scheduleId: string | null,
    report: Report | null,
    reason = scheduleId ? `schedule:${scheduleId}` : 'operator',
  ): Job {
    const fingerprint = hash({ task, resource });
    const existing = this.db.prepare('SELECT * FROM jobs WHERE dedupe_key=?').get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Idempotency key already used for a different task');
      return job(existing);
    }
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO jobs(id,dedupe_key,fingerprint,task,resource,state,created_at,scheduled_for,schedule_id,report)
      VALUES(?,?,?,?,?,'queued',?,?,?,?)`)
      .run(
        id,
        key,
        fingerprint,
        JSON.stringify(task),
        resource,
        now,
        due,
        scheduleId,
        report ? JSON.stringify(report) : null,
      );
    this.record(id, 'enqueued', reason, now);
    return this.get(id);
  }
  /** Reconcile the operator's `schedules[]`; agent-created schedules are left alone. */
  syncSchedules(schedules: Schedule[], now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("UPDATE schedules SET enabled=0 WHERE source='config'").run();
      for (const spec of schedules) {
        const fingerprint = hash(spec);
        const current = this.db.prepare('SELECT fingerprint,next_at,source FROM schedules WHERE id=?').get(spec.id);
        if (current && current.source !== 'config')
          throw new Error(`Schedule ${spec.id} already exists as an agent-created schedule; choose another id`);
        if (current && current.fingerprint !== fingerprint)
          this.cancelQueuedOf(spec.id, 'schedule definition changed', now);
        const next =
          current?.fingerprint === fingerprint
            ? Number(current.next_at)
            : nextOccurrence(spec.cron, spec.timezone, now);
        this.db
          .prepare(`INSERT INTO schedules(id,spec,fingerprint,next_at,enabled,source) VALUES(?,?,?,?,?,'config')
          ON CONFLICT(id) DO UPDATE SET spec=excluded.spec,fingerprint=excluded.fingerprint,next_at=excluded.next_at,enabled=excluded.enabled`)
          .run(spec.id, JSON.stringify(spec), fingerprint, next, Number(spec.enabled));
      }
      this.cancelQueuedOfDisabled(now);
    });
  }
  /** Disabling/removing a schedule cancels queued occurrences, never active work. */
  private cancelQueuedOfDisabled(now: number): void {
    for (const row of this.db
      .prepare(`SELECT id FROM jobs WHERE state='queued' AND schedule_id IS NOT NULL
        AND schedule_id IN (SELECT id FROM schedules WHERE enabled=0)`)
      .all()) {
      this.db.prepare("UPDATE jobs SET state='cancelled',finished_at=? WHERE id=?").run(now, String(row.id));
      this.record(String(row.id), 'cancelled', 'schedule disabled or removed', now);
    }
  }
  private cancelQueuedOf(scheduleId: string, reason: string, now: number): void {
    for (const row of this.db.prepare("SELECT id FROM jobs WHERE state='queued' AND schedule_id=?").all(scheduleId)) {
      this.db.prepare("UPDATE jobs SET state='cancelled',finished_at=? WHERE id=?").run(now, String(row.id));
      this.record(String(row.id), 'cancelled', reason, now);
    }
  }
  schedules(): ScheduleEntry[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY next_at,id').all() as Row[]).map(scheduleEntry);
  }
  schedule(id: string): ScheduleEntry {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown schedule: ${id}`);
    return scheduleEntry(row);
  }
  /** An agent-created schedule. Config schedules are only ever written by `syncSchedules`. */
  addSchedule(spec: Schedule, now = Date.now()): ScheduleEntry {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM schedules WHERE id=?').get(spec.id))
        throw new Error(`Schedule ${spec.id} already exists`);
      this.db
        .prepare("INSERT INTO schedules(id,spec,fingerprint,next_at,enabled,source) VALUES(?,?,?,?,?,'agent')")
        .run(
          spec.id,
          JSON.stringify(spec),
          hash(spec),
          nextOccurrence(spec.cron, spec.timezone, now),
          Number(spec.enabled),
        );
      return this.schedule(spec.id);
    });
  }
  private agentSchedule(id: string): ScheduleEntry {
    const entry = this.schedule(id);
    if (entry.source !== 'agent')
      throw new Error(`Schedule ${id} is defined in aivi.json; edit the configuration instead`);
    return entry;
  }
  /** Pause (`false`) or resume (`true`) an agent-created schedule. Resuming re-anchors to the next future occurrence. */
  setScheduleEnabled(id: string, enabled: boolean, now = Date.now()): ScheduleEntry {
    return this.transaction(() => {
      const { spec } = this.agentSchedule(id);
      const next = enabled ? nextOccurrence(spec.cron, spec.timezone, now) : undefined;
      this.db
        .prepare(`UPDATE schedules SET enabled=?,next_at=COALESCE(?,next_at) WHERE id=?`)
        .run(Number(enabled), next ?? null, id);
      if (!enabled) this.cancelQueuedOf(id, 'schedule paused', now);
      return this.schedule(id);
    });
  }
  removeSchedule(id: string, now = Date.now()): void {
    this.transaction(() => {
      this.agentSchedule(id);
      this.cancelQueuedOf(id, 'schedule removed', now);
      this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
    });
  }
  /** Enqueue one occurrence of a schedule now, outside its cron; refused while one is outstanding. */
  runSchedule(id: string, now = Date.now()): Job {
    return this.transaction(() => {
      const { spec } = this.schedule(id);
      if (
        this.db.prepare("SELECT id FROM jobs WHERE schedule_id=? AND state IN ('queued','running','blocked')").get(id)
      )
        throw new Error(`Schedule ${id} already has an outstanding job`);
      return this.insert(
        spec.task,
        spec.resource,
        `schedule:${id}:manual:${now}`,
        now,
        now,
        id,
        spec.report ?? null,
        'manual run',
      );
    });
  }
  materializeDue(now = Date.now()): number {
    return this.transaction(() => {
      let created = 0;
      for (const row of this.db
        .prepare('SELECT * FROM schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at,id')
        .all(now)) {
        const spec = JSON.parse(String(row.spec)) as Schedule;
        const outstanding = this.db
          .prepare("SELECT id FROM jobs WHERE schedule_id=? AND state IN ('queued','running','blocked')")
          .get(spec.id);
        const late = now - Number(row.next_at);
        if (!outstanding && spec.misfire && late > spec.misfire.skipAfterMs) {
          // Too late to be useful (a 9:00 standup at 14:00): keep a visible record, run nothing.
          const skipped = this.insert(
            spec.task,
            spec.resource,
            `schedule:${spec.id}:${row.next_at}`,
            now,
            Number(row.next_at),
            spec.id,
            spec.report ?? null,
          );
          this.db.prepare("UPDATE jobs SET state='cancelled',finished_at=? WHERE id=?").run(now, skipped.id);
          this.record(skipped.id, 'skipped', `missed by ${Math.round(late / 1000)}s, over misfire.skipAfterMs`, now);
        } else if (!outstanding) {
          this.insert(
            spec.task,
            spec.resource,
            `schedule:${spec.id}:${row.next_at}`,
            now,
            Number(row.next_at),
            spec.id,
            spec.report ?? null,
          );
          created++;
        }
        // Coalesce downtime to one occurrence and skip ticks while one remains outstanding.
        this.db
          .prepare('UPDATE schedules SET next_at=? WHERE id=?')
          .run(nextOccurrence(spec.cron, spec.timezone, now), spec.id);
      }
      return created;
    });
  }
  claim(owner: string, maxConcurrent: number, resources: Record<string, number>, now = Date.now()): Job | null {
    return this.transaction(() => {
      const active = this.capacityUsage();
      if (active.reduce((sum, r) => sum + Number(r.n), 0) >= maxConcurrent) return null;
      const counts = new Map(active.map(r => [String(r.resource), Number(r.n)]));
      for (const row of this.db
        .prepare("SELECT * FROM jobs WHERE state='queued' AND scheduled_for<=? ORDER BY scheduled_for,created_at,id")
        .all(now)) {
        const resource = String(row.resource);
        const limit = resources[resource];
        if (limit === undefined || (counts.get(resource) ?? 0) >= limit) continue;
        this.db
          .prepare("UPDATE jobs SET state='running',owner=?,started_at=? WHERE id=?")
          .run(owner, now, String(row.id));
        this.record(String(row.id), 'claimed', owner, now);
        return this.get(String(row.id));
      }
      return null;
    });
  }
  private capacityUsage(): Row[] {
    return this.db
      .prepare(`SELECT resource,count(*) AS n FROM (
      SELECT resource FROM jobs WHERE state IN ('running','blocked')
      UNION ALL SELECT resource FROM resource_leases
    ) GROUP BY resource`)
      .all();
  }
  /** Pools that queued work is waiting for; lets the scheduler notice a pool that no longer exists. */
  queuedResources(): string[] {
    return this.db
      .prepare("SELECT DISTINCT resource FROM jobs WHERE state='queued'")
      .all()
      .map(r => String(r.resource));
  }
  /**
   * The next future instant anything becomes due: a schedule occurrence or a waiting one-off.
   * Work that is already due waits for capacity, and a finishing job wakes the loop for it.
   */
  nextDue(now = Date.now()): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(t) AS due FROM (
          SELECT MIN(next_at) AS t FROM schedules WHERE enabled=1 AND next_at>?
          UNION ALL SELECT MIN(scheduled_for) FROM jobs WHERE state='queued' AND scheduled_for>?
        )`,
      )
      .get(now, now);
    return row?.due === null || row?.due === undefined ? null : Number(row.due);
  }
  /**
   * Reserve capacity for non-job work (for example one Discord turn). The
   * caller's own state change runs inside the same transaction via `onAcquire`,
   * so it must use `store.db` directly: Store methods that open their own
   * transaction cannot nest here.
   */
  acquireLease(
    id: string,
    owner: string,
    resource: string,
    maxConcurrent: number,
    resources: Record<string, number>,
    onAcquire: () => void = () => {},
    now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM resource_leases WHERE id=?').get(id)) return false;
      const usage = this.capacityUsage();
      if (usage.reduce((n, r) => n + Number(r.n), 0) >= maxConcurrent) return false;
      const count = Number(usage.find(r => r.resource === resource)?.n ?? 0);
      if (resources[resource] === undefined || count >= resources[resource]!) return false;
      this.db.prepare("INSERT INTO resource_leases VALUES(?,?,?,'running',?,NULL)").run(id, owner, resource, now);
      onAcquire();
      return true;
    });
  }
  releaseLease(id: string, owner: string): void {
    const result = this.db.prepare('DELETE FROM resource_leases WHERE id=? AND owner=?').run(id, owner);
    if (Number(result.changes) !== 1) throw new Error('Lost resource lease ownership');
  }
  blockLease(id: string, owner: string, reason: string): void {
    const result = this.db
      .prepare("UPDATE resource_leases SET state='blocked',reason=? WHERE id=? AND owner=?")
      .run(reason, id, owner);
    if (Number(result.changes) !== 1) throw new Error('Lost resource lease ownership');
  }
  /** Restart recovery for an adapter: every lease it held is now unverified and stays reserved. */
  blockLeasesOwnedBy(owner: string, reason: string): number {
    return Number(
      this.db
        .prepare("UPDATE resource_leases SET state='blocked',reason=? WHERE owner=? AND state='running'")
        .run(reason, owner).changes,
    );
  }
  leases(): Lease[] {
    return (this.db.prepare('SELECT * FROM resource_leases ORDER BY created_at,id').all() as Row[]).map(lease);
  }
  leaseCount(): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM resource_leases').get()!.n);
  }
  attachSession(id: string, owner: string, sessionId: string): void {
    const result = this.db
      .prepare("UPDATE jobs SET session_id=? WHERE id=? AND owner=? AND state='running'")
      .run(sessionId, id, owner);
    if (Number(result.changes) !== 1) throw new Error('Lost job ownership while attaching session');
  }
  finish(
    id: string,
    owner: string,
    state: 'succeeded' | 'failed' | 'blocked',
    result: unknown,
    reason: string,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE jobs SET state=?,result=?,error=?,finished_at=? WHERE id=? AND owner=? AND state='running'")
        .run(
          state,
          JSON.stringify(result ?? null),
          state === 'succeeded' ? null : reason,
          state === 'blocked' ? null : now,
          id,
          owner,
        );
      if (Number(update.changes) !== 1) throw new Error('Lost job ownership while finishing');
      this.record(id, state, reason, now);
    });
  }
  cancelQueued(id: string, now = Date.now()): void {
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE jobs SET state='cancelled',finished_at=? WHERE id=? AND state='queued'")
        .run(now, id);
      if (Number(update.changes) !== 1)
        throw new Error('Only queued jobs can be cancelled; running work needs reconciliation');
      this.record(id, 'cancelled', 'operator', now);
    });
  }
  resolveBlocked(id: string, outcome: 'succeeded' | 'failed', reason: string, now = Date.now()): void {
    if (!reason.trim()) throw new Error('A repair/completion reason is required');
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE jobs SET state=?,error=?,finished_at=? WHERE id=? AND state='blocked'")
        .run(outcome, outcome === 'failed' ? reason : null, now, id);
      if (Number(update.changes) !== 1) throw new Error('Only blocked jobs can be resolved');
      this.record(id, 'operator-resolved', reason, now);
    });
  }
  acquireDaemon(owner: string, pid = process.pid, now = Date.now()): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT pid FROM daemon WHERE id=1').get();
      if (existing) {
        let alive = true;
        try {
          process.kill(Number(existing.pid), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive) throw new Error(`A host already owns this database (pid ${existing.pid})`);
      }
      this.db
        .prepare(
          'INSERT INTO daemon(id,owner,pid) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid',
        )
        .run(owner, pid);
      for (const row of this.db.prepare("SELECT id FROM jobs WHERE state='running'").all()) {
        this.db
          .prepare(
            "UPDATE jobs SET state='blocked',error='Host interrupted; reconcile external work before releasing capacity' WHERE id=?",
          )
          .run(String(row.id));
        this.record(String(row.id), 'blocked', 'restart recovery', now);
      }
    });
  }
  releaseDaemon(owner: string): void {
    this.db.prepare('DELETE FROM daemon WHERE id=1 AND owner=?').run(owner);
  }
  history(id: string): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit WHERE job_id=? ORDER BY seq').all(id) as Row[]).map(audit);
  }
  /** Pending one-offs an agent created (`aivi_schedule` with `at`). */
  agentOneOffs(): Job[] {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE state='queued' AND dedupe_key LIKE 'agent:%' ORDER BY scheduled_for,id")
        .all() as Row[]
    ).map(job);
  }
  /** Jobs that reached a final state since `since`, newest first. */
  recent(since: number, limit = 50): Job[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM jobs WHERE finished_at>=? AND state IN ('succeeded','failed','blocked','cancelled')
           ORDER BY finished_at DESC,id LIMIT ?`,
        )
        .all(since, limit) as Row[]
    ).map(job);
  }
  /** The most recent job of a schedule that has started, if any. */
  lastRun(scheduleId: string): Job | null {
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE schedule_id=? AND state<>'cancelled' ORDER BY COALESCE(finished_at,started_at,created_at) DESC,id LIMIT 1",
      )
      .get(scheduleId);
    return row ? job(row) : null;
  }
  /** Consecutive runs of a schedule that ended failed or blocked, counted back from the latest finished one. */
  failureStreak(scheduleId: string): number {
    let streak = 0;
    for (const row of this.db
      .prepare(
        "SELECT state FROM jobs WHERE schedule_id=? AND state IN ('succeeded','failed','blocked') ORDER BY finished_at DESC,started_at DESC,id DESC",
      )
      .all(scheduleId)) {
      if (row.state === 'succeeded') break;
      streak++;
    }
    return streak;
  }
  /** Ask the scheduler to abort a running job; the job then ends blocked for `jobs resolve`. */
  requestCancel(id: string, now = Date.now()): void {
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE jobs SET cancel_requested=1 WHERE id=? AND state='running' AND cancel_requested=0")
        .run(id);
      if (Number(update.changes) !== 1) throw new Error('Only a running job without a pending abort can be aborted');
      this.record(id, 'abort-requested', 'operator', now);
    });
  }
  cancelRequested(owner: string): string[] {
    return this.db
      .prepare("SELECT id FROM jobs WHERE state='running' AND owner=? AND cancel_requested=1")
      .all(owner)
      .map(r => String(r.id));
  }
}
