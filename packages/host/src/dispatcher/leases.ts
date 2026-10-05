import { randomBytes } from 'node:crypto';
import type { Store } from '../store.ts';

/**
 * The durable record of dispatcher leases: one row, one slot held. This is
 * the reason a restart is survivable for work in flight: the row, not
 * memory, is the truth (docs/orchestrator.md: "Active work survives
 * restarts. Claims and leases are persisted and can be reconciled").
 *
 * What a lease is **not** here: no prompt text (a turn lease's prompt lives
 * in OpenCode's inbox, which OpenCode owns), no queue position (the queue is
 * deliberately ephemeral — the dispatcher's memory, never this table), and
 * no claim (the orchestrator's mirror of a ticket's lease is the
 * orchestrator's own record; the dispatcher never knows tickets).
 *
 * Pure storage: it performs no external effect — no session is created,
 * killed or consulted here. The state machine is the dispatcher's.
 */

/** The two lease types (docs/orchestrator.md): a **turn** lease asks the
 *  dispatcher to run a prompt; a **session** lease gives the caller direct
 *  use of one slot (the orchestrator, for ticket work). */
export type LeaseKind = 'turn' | 'session';

/** `preparing`: granted, no session yet (the prepare timeout watches it).
 *  `active`: a session is attached (the idle timeout times its silence).
 *  `expiring`: the dispatcher is killing the session to take the slot back —
 *  the slot stays **unavailable** until the kill is confirmed, so nothing
 *  double-books capacity that may still be spending. */
export type LeaseState = 'preparing' | 'active' | 'expiring';

export interface DispatcherLease {
  id: string;
  kind: LeaseKind;
  /** The service's callback namespace: 'orchestrator', 'discord', 'jobs'…
   *  one pending queue request per service and pool lives with this name. */
  service: string;
  /** The pool whose slot this holds. A session keeps the pool it was created
   *  in for life; a resume is only ever granted against that pool. In
   *  unlimited mode every lease names the `unlimited` pool. */
  pool: string;
  sessionId?: string;
  /** The ephemeral dispatcher-queue request this lease answers, when it does
   *  (the dispatcher's memory; persisted so a boot can tell the service
   *  which request landed while nobody was listening). */
  requestId?: string;
  state: LeaseState;
  /** The last sign of activity the idle monitor times against. */
  activityAt: number;
  createdAt: number;
}

type Row = Record<string, unknown>;

/** The pool every lease names when capacity is not moderated at all. */
export const UNLIMITED = 'unlimited';

/** A lease holds its slot from the moment it is granted: preparing, active,
 *  and expiring all count. An expiring lease's session may still be
 *  spending, so its slot is not handed to anyone else. */
const HOLDING = "state IN ('preparing','active','expiring')";

const map = (r: Row): DispatcherLease => ({
  id: String(r.id),
  kind: r.kind as LeaseKind,
  service: String(r.service),
  pool: String(r.pool),
  ...(r.session_id === null || r.session_id === undefined ? {} : { sessionId: String(r.session_id) }),
  ...(r.request_id === null || r.request_id === undefined ? {} : { requestId: String(r.request_id) }),
  state: r.state as LeaseState,
  activityAt: Number(r.activity_at),
  createdAt: Number(r.created_at),
});

const migrations = [
  `CREATE TABLE dispatcher_leases(
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, service TEXT NOT NULL, pool TEXT NOT NULL,
     session_id TEXT, request_id TEXT, state TEXT NOT NULL,
     activity_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX dispatcher_leases_pool_state ON dispatcher_leases(pool, state);
   CREATE INDEX dispatcher_leases_session ON dispatcher_leases(session_id);`,
  // A session keeps the pool it was created in for its whole life (docs/
  // orchestrator.md), and that fact must outlive every lease it held: the
  // elicitation answer resumes a session whose lease was already released.
  `CREATE TABLE dispatcher_sessions(
     session_id TEXT PRIMARY KEY, pool TEXT NOT NULL, created_at INTEGER NOT NULL);`,
];

export class LeaseStore {
  private readonly core: Store;
  constructor(core: Store) {
    this.core = core;
    core.migrate('dispatcher', migrations);
  }

  /** How many slots of `pool` the leases hold right now. */
  held(pool: string): number {
    return Number(
      this.core.db.prepare(`SELECT count(*) AS n FROM dispatcher_leases WHERE pool=? AND ${HOLDING}`).get(pool)!.n,
    );
  }

  /**
   * Take one slot of `pool`, atomically. `capacity` is the pool's slots;
   * `undefined` capacity is unlimited mode — always granted. `onAcquire` runs
   * inside the same transaction (the caller's own bookkeeping must not open
   * another write). Returns the lease, or undefined when the pool is full —
   * the caller queues or skips; the store never waits.
   */
  grant(
    input: {
      kind: LeaseKind;
      service: string;
      pool: string;
      capacity?: number;
      sessionId?: string;
      requestId?: string;
    },
    onAcquire: () => void = () => {},
    now = Date.now(),
  ): DispatcherLease | undefined {
    return this.core.transaction(() => {
      if (input.capacity !== undefined && this.held(input.pool) >= input.capacity) return undefined;
      const id = `lease_${randomBytes(6).toString('hex')}`;
      this.core.db
        .prepare(
          `INSERT INTO dispatcher_leases(id,kind,service,pool,session_id,request_id,state,activity_at,created_at)
           VALUES(?,?,?,?,?,?,?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          input.service,
          input.pool,
          input.sessionId ?? null,
          input.requestId ?? null,
          input.sessionId ? 'active' : 'preparing',
          now,
          now,
        );
      onAcquire();
      return this.require(id);
    });
  }

  require(id: string): DispatcherLease {
    const row = this.core.db.prepare('SELECT * FROM dispatcher_leases WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error(`No lease ${id}`);
    return map(row);
  }

  get(id: string): DispatcherLease | undefined {
    const row = this.core.db.prepare('SELECT * FROM dispatcher_leases WHERE id=?').get(id) as Row | undefined;
    return row && map(row);
  }

  /** Provide the lease with its session: preparing → active. Only a lease
   *  that has no session yet is provided — one that already has a session
   *  keeps it (a session keeps its pool for life). */
  attach(id: string, sessionId: string, now = Date.now()): DispatcherLease {
    const result = this.core.db
      .prepare(
        "UPDATE dispatcher_leases SET session_id=?, state='active', activity_at=? WHERE id=? AND state='preparing'",
      )
      .run(sessionId, now, id);
    if (Number(result.changes) !== 1) throw new Error(`Lease ${id} was not preparing; nothing attached`);
    return this.require(id);
  }

  /** A sign of life: the idle monitor restarts its clock from here. */
  touch(id: string, now = Date.now()): void {
    this.core.db.prepare('UPDATE dispatcher_leases SET activity_at=? WHERE id=?').run(now, id);
  }

  /** The lease is over: the slot is free. Ending a lease never deletes the
   *  session — that is someone else's call. */
  release(id: string): void {
    const result = this.core.db.prepare('DELETE FROM dispatcher_leases WHERE id=?').run(id);
    if (Number(result.changes) !== 1) throw new Error(`Lease ${id} was already gone`);
  }

  /** The dispatcher decided to end this lease and is killing its session.
   *  The slot stays held (state `expiring`) until the kill is confirmed. */
  beginExpiry(id: string): DispatcherLease {
    const result = this.core.db.prepare("UPDATE dispatcher_leases SET state='expiring' WHERE id=?").run(id);
    if (Number(result.changes) !== 1) throw new Error(`Lease ${id} was already gone`);
    return this.require(id);
  }

  /** Every lease, in grant order: what the boot pass walks to reconcile. */
  all(): DispatcherLease[] {
    return (this.core.db.prepare('SELECT * FROM dispatcher_leases ORDER BY created_at, id').all() as Row[]).map(map);
  }

  /** The pool a session was created in — asked again whenever the session
   *  returns for a new lease, because fallback never applies to a resume.
   *  Undefined for a session the dispatcher never created or attached. */
  sessionPool(sessionId: string): string | undefined {
    const row = this.core.db.prepare('SELECT pool FROM dispatcher_sessions WHERE session_id=?').get(sessionId);
    return row && String(row.pool);
  }

  /** Set the pool a session belongs to, once, at its first appearance here;
   *  later sightings never change it. */
  record(sessionId: string, pool: string, now = Date.now()): void {
    this.core.db
      .prepare('INSERT OR IGNORE INTO dispatcher_sessions(session_id, pool, created_at) VALUES(?,?,?)')
      .run(sessionId, pool, now);
  }
}
