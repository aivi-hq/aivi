import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobSource, JobState, Report, Run, RunState, Task } from '@aivi/core';
import { formatInstant, jobSchema, nextOccurrence } from '@aivi/core';

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
  runId: string;
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
  runId: String(r.run_id),
  at: Number(r.at),
  action: String(r.action),
  reason: String(r.reason),
});
const states: RunState[] = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'missed'];
const OUTSTANDING = "('queued','running','blocked')";
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const run = (r: Row): Run => ({
  id: String(r.id),
  jobId: String(r.job_id),
  task: JSON.parse(String(r.task)) as Task,
  resource: String(r.resource),
  state: r.state as RunState,
  createdAt: Number(r.created_at),
  scheduledFor: Number(r.scheduled_for),
  startedAt: r.started_at === null ? null : Number(r.started_at),
  finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  sessionId: r.session_id as string | null,
  owner: r.owner as string | null,
  error: r.error as string | null,
  result: r.result === null ? null : JSON.parse(String(r.result)),
  report: r.report === null || r.report === undefined ? null : (JSON.parse(String(r.report)) as Report),
});

const HOST_SCHEMA_VERSION = 7;

/** Pre-v6 reports overloaded `channel`: a session id for `to: "session"`, a platform channel id for a module name. */
function migrateReport(raw: unknown): Report | null {
  const old = raw as { to?: string; channel?: string; on?: Report['on'] } | null;
  if (!old || typeof old !== 'object' || !old.to) return null;
  if ('session' in old || 'module' in old) return raw as Report;
  if (!old.channel) return null;
  if (old.to === 'session') return { to: 'session', session: old.channel, on: old.on ?? 'always' };
  return { to: 'channel', module: old.to, channel: old.channel, on: old.on ?? 'always' };
}

export interface JobEntry {
  spec: Job;
  source: JobSource;
  state: JobState;
  /** The next occurrence to materialize; null once a one-off has fired or when nothing is left. */
  nextAt: number | null;
  createdAt: number;
  /** Idempotency key of a job created outside aivi.json (a tool message id, a CLI `--key`). */
  dedupeKey: string | null;
}
const jobEntry = (r: Row): JobEntry => ({
  spec: JSON.parse(String(r.spec)) as Job,
  source: r.source as JobSource,
  state: r.state as JobState,
  nextAt: r.next_at === null ? null : Number(r.next_at),
  createdAt: Number(r.created_at),
  dedupeKey: r.dedupe_key === null ? null : String(r.dedupe_key),
});
export interface AddJobOptions {
  /** Identical requests with the same key create one job; a different task under the same key is refused. */
  dedupeKey?: string;
  /** Audit reason for the first run's `enqueued` entry; default `job:<id>`. */
  reason?: string;
}
export interface RunFilter {
  jobId?: string;
  state?: RunState;
  /** Keep only the newest `limit` runs. */
  limit?: number;
}
const oneOffId = (source: JobSource) => `${source === 'agent' ? 'agent' : 'job'}-${randomUUID().slice(0, 8)}`;
/** What makes two one-off requests "the same": everything but the generated id and the instant. */
const requestFingerprint = ({ id: _id, at: _at, ...rest }: Job) => hash(rest);

/**
 * Durable host state in one SQLite file. Host tables (jobs, runs, leases,
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
          const spec = JSON.parse(String(row.spec)) as Job;
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
      if (version < 7) this.migrateToJobsAndRuns(Date.now());
    });
  }
  /**
   * v7: definitions and executions. `schedules` becomes `jobs`, `jobs` becomes
   * `runs`, and every one-off (a run without a schedule) gets a definition of
   * its own so that `runs.job_id` is never null.
   */
  private migrateToJobsAndRuns(now: number): void {
    this.db.exec(`
      CREATE TABLE jobs_v7(id TEXT PRIMARY KEY, spec TEXT NOT NULL, fingerprint TEXT NOT NULL, next_at INTEGER,
        state TEXT NOT NULL CHECK(state IN ('active','paused','done','missed')),
        source TEXT NOT NULL CHECK(source IN ('config','agent','operator','system')),
        dedupe_key TEXT UNIQUE, created_at INTEGER NOT NULL);
      INSERT INTO jobs_v7(id,spec,fingerprint,next_at,state,source,dedupe_key,created_at)
        SELECT id,spec,fingerprint,next_at,CASE enabled WHEN 1 THEN 'active' ELSE 'paused' END,source,NULL,${now}
        FROM schedules;
      CREATE TABLE runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL, task TEXT NOT NULL, resource TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','blocked','cancelled','missed')),
        created_at INTEGER NOT NULL, scheduled_for INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        session_id TEXT, owner TEXT, result TEXT, error TEXT, report TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0);
    `);
    for (const row of this.db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all() as Row[]) {
      let jobId = row.schedule_id as string | null;
      if (jobId === null) {
        const key = String(row.dedupe_key);
        const source: JobSource = key.startsWith('agent:') ? 'agent' : 'operator';
        jobId = oneOffId(source);
        const spec = jobSchema.parse({
          id: jobId,
          at: new Date(Number(row.scheduled_for)).toISOString(),
          resource: String(row.resource),
          task: JSON.parse(String(row.task)),
          ...(row.report ? { report: JSON.parse(String(row.report)) } : {}),
        });
        const state: JobState = ['queued', 'running', 'blocked'].includes(String(row.state)) ? 'active' : 'done';
        this.db
          .prepare(
            'INSERT INTO jobs_v7(id,spec,fingerprint,next_at,state,source,dedupe_key,created_at) VALUES(?,?,?,NULL,?,?,?,?)',
          )
          .run(jobId, JSON.stringify(spec), hash(spec), state, source, key, Number(row.created_at));
      }
      this.db
        .prepare(`INSERT INTO runs(id,job_id,dedupe_key,fingerprint,task,resource,state,created_at,scheduled_for,
          started_at,finished_at,session_id,owner,result,error,report,cancel_requested)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          String(row.id),
          jobId,
          String(row.dedupe_key),
          String(row.fingerprint),
          String(row.task),
          String(row.resource),
          String(row.state),
          Number(row.created_at),
          Number(row.scheduled_for),
          row.started_at as number | null,
          row.finished_at as number | null,
          row.session_id as string | null,
          row.owner as string | null,
          row.result as string | null,
          row.error as string | null,
          row.report as string | null,
          Number(row.cancel_requested ?? 0),
        );
    }
    this.db.exec(`
      DROP TABLE jobs;
      DROP TABLE schedules;
      ALTER TABLE jobs_v7 RENAME TO jobs;
      CREATE INDEX runs_ready ON runs(state,scheduled_for,created_at);
      CREATE INDEX runs_job ON runs(job_id,finished_at);
      CREATE UNIQUE INDEX one_outstanding_run ON runs(job_id) WHERE state IN ('queued','running','blocked');
      ALTER TABLE audit RENAME COLUMN job_id TO run_id;
      PRAGMA user_version=7;
    `);
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
    this.db.prepare('INSERT INTO audit(run_id,at,action,reason) VALUES(?,?,?,?)').run(id, now, action, reason);
  }
  /** Append an audit entry that is not a state transition (for example a delivery attempt). */
  note(id: string, action: string, reason: string, now = Date.now()): void {
    this.record(id, action, reason, now);
  }

  // Runs: executions.

  runs(filter: RunFilter = {}): Run[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.jobId) {
      where.push('job_id=?');
      args.push(filter.jobId);
    }
    if (filter.state) {
      where.push('state=?');
      args.push(filter.state);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = filter.limit
      ? this.db
          .prepare(
            `SELECT * FROM (SELECT * FROM runs${clause} ORDER BY created_at DESC,id DESC LIMIT ?) ORDER BY created_at,id`,
          )
          .all(...args, filter.limit)
      : this.db.prepare(`SELECT * FROM runs${clause} ORDER BY created_at,id`).all(...args);
    return (rows as Row[]).map(run);
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown run: ${id}`);
    return run(row);
  }
  counts(): Record<RunState, number> {
    const result = Object.fromEntries(states.map(s => [s, 0])) as Record<RunState, number>;
    for (const r of this.db.prepare('SELECT state,count(*) AS n FROM runs GROUP BY state').all())
      result[r.state as RunState] = Number(r.n);
    return result;
  }
  /** Sugar for "run this once, now": an operator one-off job and its queued run in one transaction. */
  enqueue(task: Task, resource: string, dedupeKey: string, now = Date.now(), report: Report | null = null): Run {
    const spec = jobSchema.parse({
      id: oneOffId('operator'),
      at: new Date(now).toISOString(),
      resource,
      task,
      ...(report ? { report } : {}),
    });
    const entry = this.addJob(spec, 'operator', now, { dedupeKey, reason: 'operator' });
    return this.runs({ jobId: entry.spec.id }).at(-1)!;
  }
  private insertRun(
    job: Pick<Job, 'id' | 'task' | 'resource' | 'report'>,
    key: string,
    now: number,
    due: number,
    reason: string,
    missed?: string,
  ): Run {
    const id = randomUUID();
    const fingerprint = hash({ task: job.task, resource: job.resource });
    // A resumed one-off fires for the same instant again; its cancelled run keeps the plain key.
    if (this.db.prepare('SELECT 1 FROM runs WHERE dedupe_key=?').get(key)) key = `${key}:${now}`;
    this.db
      .prepare(`INSERT INTO runs(id,job_id,dedupe_key,fingerprint,task,resource,state,created_at,scheduled_for,finished_at,error,report)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        job.id,
        key,
        fingerprint,
        JSON.stringify(job.task),
        job.resource,
        missed ? 'missed' : 'queued',
        now,
        due,
        missed ? now : null,
        missed ?? null,
        job.report ? JSON.stringify(job.report) : null,
      );
    this.record(id, missed ? 'missed' : 'enqueued', missed ?? reason, now);
    return this.run(id);
  }
  private outstanding(jobId: string): boolean {
    return Boolean(this.db.prepare(`SELECT id FROM runs WHERE job_id=? AND state IN ${OUTSTANDING}`).get(jobId));
  }

  // Jobs: definitions.

  jobs(): JobEntry[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY next_at IS NULL,next_at,created_at,id').all() as Row[]).map(
      jobEntry,
    );
  }
  job(id: string): JobEntry {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown job: ${id}`);
    return jobEntry(row);
  }
  private firstOccurrence(spec: Job, now: number): number {
    return spec.at !== undefined ? Date.parse(spec.at) : nextOccurrence(spec.cron!, spec.timezone, now);
  }
  /**
   * Reconcile the definitions the operator owns: `config` (aivi.json) and
   * `system` (what the host seeds from its settings). Agent and operator jobs
   * are left alone. A config job that disappeared is paused; a system job that
   * disappeared is removed.
   */
  syncJobs(config: Job[], system: Job[] = [], now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state='paused' WHERE source='config' AND state='active'").run();
      for (const [source, specs] of [
        ['config', config],
        ['system', system],
      ] as const) {
        for (const spec of specs) {
          const fingerprint = hash(spec);
          const current = this.db.prepare('SELECT fingerprint,next_at,state,source FROM jobs WHERE id=?').get(spec.id);
          if (current && current.source !== source)
            throw new Error(`Job ${spec.id} already exists with source ${current.source}; choose another id`);
          const unchanged = current?.fingerprint === fingerprint;
          if (current && !unchanged) this.cancelQueuedOf(spec.id, 'job definition changed', now);
          const finished = unchanged && ['done', 'missed'].includes(String(current.state));
          const state: JobState = !spec.enabled ? 'paused' : finished ? (current.state as JobState) : 'active';
          const next = unchanged ? (current.next_at as number | null) : this.firstOccurrence(spec, now);
          this.db
            .prepare(`INSERT INTO jobs(id,spec,fingerprint,next_at,state,source,created_at) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET spec=excluded.spec,fingerprint=excluded.fingerprint,next_at=excluded.next_at,state=excluded.state`)
            .run(spec.id, JSON.stringify(spec), fingerprint, next, state, source, now);
        }
      }
      const keep = system.map(s => s.id);
      for (const row of this.db.prepare("SELECT id FROM jobs WHERE source='system'").all()) {
        if (keep.includes(String(row.id))) continue;
        this.cancelQueuedOf(String(row.id), 'job removed', now);
        this.db.prepare('DELETE FROM jobs WHERE id=?').run(String(row.id));
      }
      this.cancelQueuedOfPaused(now);
    });
  }
  /** Disabling a job cancels its queued runs, never active work. */
  private cancelQueuedOfPaused(now: number): void {
    for (const row of this.db
      .prepare(`SELECT id FROM runs WHERE state='queued' AND job_id IN (SELECT id FROM jobs WHERE state='paused')`)
      .all()) {
      this.db.prepare("UPDATE runs SET state='cancelled',finished_at=? WHERE id=?").run(now, String(row.id));
      this.record(String(row.id), 'cancelled', 'job disabled or removed', now);
    }
  }
  private cancelQueuedOf(jobId: string, reason: string, now: number): void {
    for (const row of this.db.prepare("SELECT id FROM runs WHERE state='queued' AND job_id=?").all(jobId)) {
      this.db.prepare("UPDATE runs SET state='cancelled',finished_at=? WHERE id=?").run(now, String(row.id));
      this.record(String(row.id), 'cancelled', reason, now);
    }
  }
  /**
   * A job created outside aivi.json: by an agent through the tool or by the
   * operator CLI. A one-off whose instant has already come is materialized at
   * once; a later one waits for `materializeDue`.
   */
  addJob(spec: Job, source: 'agent' | 'operator', now = Date.now(), options: AddJobOptions = {}): JobEntry {
    return this.transaction(() => {
      if (options.dedupeKey) {
        const existing = this.db.prepare('SELECT * FROM jobs WHERE dedupe_key=?').get(options.dedupeKey);
        if (existing) {
          const entry = jobEntry(existing);
          if (requestFingerprint(entry.spec) !== requestFingerprint(spec))
            throw new Error('Idempotency key already used for a different task');
          return entry;
        }
      }
      if (this.db.prepare('SELECT id FROM jobs WHERE id=?').get(spec.id))
        throw new Error(`Job ${spec.id} already exists`);
      this.db
        .prepare(
          'INSERT INTO jobs(id,spec,fingerprint,next_at,state,source,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          spec.id,
          JSON.stringify(spec),
          hash(spec),
          this.firstOccurrence(spec, now),
          spec.enabled ? 'active' : 'paused',
          source,
          options.dedupeKey ?? null,
          now,
        );
      if (spec.enabled && spec.at !== undefined && Date.parse(spec.at) <= now)
        this.fire(this.job(spec.id), now, Infinity, options.reason);
      return this.job(spec.id);
    });
  }
  private mutable(id: string): JobEntry {
    const entry = this.job(id);
    if (entry.source === 'config' || entry.source === 'system')
      throw new Error(`Job ${id} is defined in aivi.json; edit the configuration instead`);
    return entry;
  }
  /** Pause (`false`) or resume (`true`) an agent or operator job. Resuming re-anchors to the next occurrence. */
  setJobEnabled(id: string, enabled: boolean, now = Date.now()): JobEntry {
    return this.transaction(() => {
      const entry = this.mutable(id);
      if (entry.state === 'done' || entry.state === 'missed')
        throw new Error(`Job ${id} has finished (${entry.state})`);
      if (enabled)
        this.db
          .prepare("UPDATE jobs SET state='active',next_at=? WHERE id=?")
          .run(this.firstOccurrence(entry.spec, now), id);
      else {
        this.db.prepare("UPDATE jobs SET state='paused' WHERE id=?").run(id);
        this.cancelQueuedOf(id, 'job paused', now);
      }
      return this.job(id);
    });
  }
  removeJob(id: string, now = Date.now()): void {
    this.transaction(() => {
      this.mutable(id);
      this.cancelQueuedOf(id, 'job removed', now);
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    });
  }
  /** Queue one run of a job now, outside its schedule; refused while one is outstanding. */
  runJob(id: string, now = Date.now()): Run {
    return this.transaction(() => {
      const { spec } = this.job(id);
      if (this.outstanding(id)) throw new Error(`Job ${id} already has an outstanding run`);
      return this.insertRun(spec, `job:${id}:manual:${now}`, now, now, 'manual run');
    });
  }
  /**
   * Turn due occurrences into runs. An occurrence found more than its grace
   * late is recorded as one `missed` run and never executed; a whole gap of
   * downtime yields one such run per job, and the job moves past `now`.
   * Occurrences that arrive while a run is still outstanding are skipped.
   */
  materializeDue(now = Date.now(), graceMs = 60_000): { created: number; missed: Run[] } {
    return this.transaction(() => {
      let created = 0;
      const missed: Run[] = [];
      for (const row of this.db
        .prepare("SELECT * FROM jobs WHERE state='active' AND next_at IS NOT NULL AND next_at<=? ORDER BY next_at,id")
        .all(now) as Row[]) {
        const entry = jobEntry(row);
        const grace = entry.spec.misfire ? entry.spec.misfire.graceSeconds * 1000 : graceMs;
        const outcome = this.fire(entry, now, grace);
        if (outcome?.state === 'missed') missed.push(outcome);
        else if (outcome) created++;
      }
      return { created, missed };
    });
  }
  /** One due occurrence of a job: a queued run, a missed run, or nothing while a run is outstanding. */
  private fire(entry: JobEntry, now: number, graceMs: number, reason = `job:${entry.spec.id}`): Run | null {
    const { spec } = entry;
    const at = entry.nextAt!;
    const late = now - at;
    const oneOff = spec.at !== undefined;
    let result: Run | null = null;
    if (!this.outstanding(spec.id)) {
      const tooLate = late > graceMs;
      result = this.insertRun(
        spec,
        `job:${spec.id}:${at}`,
        now,
        at,
        reason,
        tooLate ? `missed: aivi was not running at ${formatInstant(at, spec.timezone)} (${spec.timezone})` : undefined,
      );
      if (tooLate && oneOff) {
        this.db.prepare("UPDATE jobs SET state='missed',next_at=NULL WHERE id=?").run(spec.id);
        return result;
      }
    }
    if (oneOff) this.db.prepare('UPDATE jobs SET next_at=NULL WHERE id=?').run(spec.id);
    else
      this.db
        .prepare('UPDATE jobs SET next_at=? WHERE id=?')
        .run(nextOccurrence(spec.cron!, spec.timezone, now), spec.id);
    if (oneOff && !result) this.settle(spec.id);
    return result;
  }
  /** A one-off whose single occurrence has fired and whose run is over is done. */
  private settle(jobId: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='done' WHERE id=? AND state='active' AND next_at IS NULL
         AND json_extract(spec,'$.at') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM runs WHERE job_id=jobs.id AND state IN ${OUTSTANDING})`,
      )
      .run(jobId);
  }
  claim(owner: string, maxConcurrent: number, resources: Record<string, number>, now = Date.now()): Run | null {
    return this.transaction(() => {
      const active = this.capacityUsage();
      if (active.reduce((sum, r) => sum + Number(r.n), 0) >= maxConcurrent) return null;
      const counts = new Map(active.map(r => [String(r.resource), Number(r.n)]));
      for (const row of this.db
        .prepare("SELECT * FROM runs WHERE state='queued' AND scheduled_for<=? ORDER BY scheduled_for,created_at,id")
        .all(now)) {
        const resource = String(row.resource);
        const limit = resources[resource];
        if (limit === undefined || (counts.get(resource) ?? 0) >= limit) continue;
        this.db
          .prepare("UPDATE runs SET state='running',owner=?,started_at=? WHERE id=?")
          .run(owner, now, String(row.id));
        this.record(String(row.id), 'claimed', owner, now);
        return this.run(String(row.id));
      }
      return null;
    });
  }
  private capacityUsage(): Row[] {
    return this.db
      .prepare(`SELECT resource,count(*) AS n FROM (
      SELECT resource FROM runs WHERE state IN ('running','blocked')
      UNION ALL SELECT resource FROM resource_leases
    ) GROUP BY resource`)
      .all();
  }
  /** Pools that queued work is waiting for; lets the scheduler notice a pool that no longer exists. */
  queuedResources(): string[] {
    return this.db
      .prepare("SELECT DISTINCT resource FROM runs WHERE state='queued'")
      .all()
      .map(r => String(r.resource));
  }
  /**
   * The next future instant a job occurrence becomes due. Work that is already
   * due waits for capacity, and a finishing run wakes the loop for it.
   */
  nextDue(now = Date.now()): number | null {
    const row = this.db.prepare("SELECT MIN(next_at) AS due FROM jobs WHERE state='active' AND next_at>?").get(now);
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
      .prepare("UPDATE runs SET session_id=? WHERE id=? AND owner=? AND state='running'")
      .run(sessionId, id, owner);
    if (Number(result.changes) !== 1) throw new Error('Lost run ownership while attaching session');
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
        .prepare("UPDATE runs SET state=?,result=?,error=?,finished_at=? WHERE id=? AND owner=? AND state='running'")
        .run(
          state,
          JSON.stringify(result ?? null),
          state === 'succeeded' ? null : reason,
          state === 'blocked' ? null : now,
          id,
          owner,
        );
      if (Number(update.changes) !== 1) throw new Error('Lost run ownership while finishing');
      this.record(id, state, reason, now);
      this.settle(this.run(id).jobId);
    });
  }
  cancelQueued(id: string, now = Date.now()): void {
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE runs SET state='cancelled',finished_at=? WHERE id=? AND state='queued'")
        .run(now, id);
      if (Number(update.changes) !== 1)
        throw new Error('Only queued runs can be cancelled; running work needs reconciliation');
      this.record(id, 'cancelled', 'operator', now);
      this.settle(this.run(id).jobId);
    });
  }
  resolveBlocked(id: string, outcome: 'succeeded' | 'failed', reason: string, now = Date.now()): void {
    if (!reason.trim()) throw new Error('A repair/completion reason is required');
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE runs SET state=?,error=?,finished_at=? WHERE id=? AND state='blocked'")
        .run(outcome, outcome === 'failed' ? reason : null, now, id);
      if (Number(update.changes) !== 1) throw new Error('Only blocked runs can be resolved');
      this.record(id, 'operator-resolved', reason, now);
      this.settle(this.run(id).jobId);
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
      for (const row of this.db.prepare("SELECT id FROM runs WHERE state='running'").all()) {
        this.db
          .prepare(
            "UPDATE runs SET state='blocked',error='Host interrupted; reconcile external work before releasing capacity' WHERE id=?",
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
    return (this.db.prepare('SELECT * FROM audit WHERE run_id=? ORDER BY seq').all(id) as Row[]).map(audit);
  }
  /** Runs that reached a final state since `since`, newest first. */
  recent(since: number, limit = 50): Run[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE finished_at>=? AND state IN ('succeeded','failed','blocked','cancelled','missed')
           ORDER BY finished_at DESC,id LIMIT ?`,
        )
        .all(since, limit) as Row[]
    ).map(run);
  }
  /** The most recent run of a job that was not cancelled, if any. */
  lastRun(jobId: string): Run | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE job_id=? AND state<>'cancelled' ORDER BY COALESCE(finished_at,started_at,created_at) DESC,id LIMIT 1",
      )
      .get(jobId);
    return row ? run(row) : null;
  }
  /** Consecutive runs of a job that ended failed or blocked, counted back from the latest finished one; missed runs say nothing about the job. */
  failureStreak(jobId: string): number {
    let streak = 0;
    for (const row of this.db
      .prepare(
        "SELECT state FROM runs WHERE job_id=? AND state IN ('succeeded','failed','blocked') ORDER BY finished_at DESC,started_at DESC,id DESC",
      )
      .all(jobId)) {
      if (row.state === 'succeeded') break;
      streak++;
    }
    return streak;
  }
  /** Ask the scheduler to abort a running run; it then ends blocked for `runs resolve`. */
  requestCancel(id: string, now = Date.now()): void {
    this.transaction(() => {
      const update = this.db
        .prepare("UPDATE runs SET cancel_requested=1 WHERE id=? AND state='running' AND cancel_requested=0")
        .run(id);
      if (Number(update.changes) !== 1) throw new Error('Only a running run without a pending abort can be aborted');
      this.record(id, 'abort-requested', 'operator', now);
    });
  }
  cancelRequested(owner: string): string[] {
    return this.db
      .prepare("SELECT id FROM runs WHERE state='running' AND owner=? AND cancel_requested=1")
      .all(owner)
      .map(r => String(r.id));
  }
  /**
   * Retention: delete finished runs (with their audit rows) that ended before
   * `olderThan`, then the finished one-off jobs that have no runs left.
   * Blocked and active work, and recurring definitions, are never touched.
   */
  prune(olderThan: number): { runs: number; jobs: number } {
    return this.transaction(() => {
      const gone = "state IN ('succeeded','failed','cancelled','missed') AND finished_at<?";
      this.db.prepare(`DELETE FROM audit WHERE run_id IN (SELECT id FROM runs WHERE ${gone})`).run(olderThan);
      const runs = Number(this.db.prepare(`DELETE FROM runs WHERE ${gone}`).run(olderThan).changes);
      const jobs = Number(
        this.db
          .prepare(
            `DELETE FROM jobs WHERE state IN ('done','missed') AND json_extract(spec,'$.at') IS NOT NULL
             AND created_at<? AND NOT EXISTS (SELECT 1 FROM runs WHERE job_id=jobs.id)`,
          )
          .run(olderThan).changes,
      );
      return { runs, jobs };
    });
  }
}
