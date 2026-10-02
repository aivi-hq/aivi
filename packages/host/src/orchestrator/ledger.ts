import { randomBytes } from 'node:crypto';
import type { RunOutcome, RunState, RunView } from '@aivi/plugin/run';
import type { Store } from '../store.ts';

/**
 * The durable record of every run: ticket ↔ OpenCode session ↔ state. This
 * is the reason a restart is survivable: the row, not memory, is the truth.
 *
 * What a run is **not** here: no conversation (a tracker's own session is
 * not an orchestrator fact — the tracker keeps that pair in its own store),
 * no delivery flag (whether a platform has been told is the follower's
 * business; the orchestrator emits events and forgets who listens), and no
 * mirror of the open question (the OpenCode form is the record, read from
 * OpenCode). A capacity lease is deliberately absent too: the dispatcher's
 * lease joins this table as a column when capacity lands, and nothing about
 * a run's identity changes.
 *
 * Pure storage: it performs no external effect and knows no platform. It
 * speaks only the neutral vocabulary; the state *machine* is the
 * orchestrator's, not this class's.
 */

/** A full run row, as the orchestrator reads it (the view is the outside's). */
export interface Run {
  id: string;
  projectId: string;
  trackerId: string;
  ticketId: string;
  lane: string;
  agent: string;
  state: RunState;
  sessionId?: string;
  worktree?: string;
  outcome?: RunOutcome;
  /** The lane the terminal run's ticket belongs in, chosen by the
   *  orchestrator from the project's lane order. A stop leaves it unset: a
   *  stopped ticket stays where the person left it. */
  targetLane?: string;
  /** The dispatcher lease this run **claims**: the run row is the ticket's
   *  mirror of the slot its worker spends. Set at the claim, and the lease
   *  is released when the run ends. */
  leaseId?: string;
  /** The feedback loop's bookkeeping (ruled 2026-10-02, docs/plans/git-
   *  workflow.md): the review threads **open when the run started** — the
   *  only ones the completion gate can ever owe — with the refused-completion
   *  count and whether the person has been asked already. Absent means the
   *  run started with nothing open: feedback arriving mid-run is context,
   *  never owed. */
  feedback?: RunFeedback;
  nudges: number;
  createdAt: number;
  updatedAt: number;
}

/** What the feedback loop persists on the run row, in one JSON value that
 *  survives restarts because everything else does. */
export interface RunFeedback {
  /** The pull request's open review-thread ids at the moment the run
   *  started. The completion gate owes exactly these, still open. */
  openThreadIds: string[];
  /** Successes refused by the gate; the person is asked at the third. */
  attempts: number;
  /** The escalation form was made: it is never doubled. `formId` is that
   *  form — the answer that resets the strikes is the answer to *it*, not
   *  to any question the worker asked along the way. */
  escalated: boolean;
  formId?: string;
}

/** What intake needs to open a run: the ticket's facts, in neutral words.
 *  The double-work guard is the ledger's: one **active** run per ticket, and
 *  it holds until the completion tool ends that run. Everything after —
 *  whether a re-delegation is new work — is the tracker module's decision. */
export interface RunRequest {
  projectId: string;
  trackerId: string;
  ticketId: string;
  lane: string;
  agent: string;
}

type Row = Record<string, unknown>;

const ACTIVE = "state IN ('preparing','working','awaiting_input')";

const map = (r: Row): Run => ({
  id: String(r.id),
  projectId: String(r.project_id),
  trackerId: String(r.tracker_id),
  ticketId: String(r.ticket_id),
  lane: String(r.lane),
  agent: String(r.agent),
  state: r.state as RunState,
  ...(r.session === null ? {} : { sessionId: String(r.session) }),
  ...(r.worktree === null ? {} : { worktree: String(r.worktree) }),
  ...(r.outcome === null ? {} : { outcome: JSON.parse(String(r.outcome)) as RunOutcome }),
  ...(r.target_lane === null ? {} : { targetLane: String(r.target_lane) }),
  ...(r.lease_id === null || r.lease_id === undefined ? {} : { leaseId: String(r.lease_id) }),
  ...(r.feedback === null || r.feedback === undefined
    ? {}
    : { feedback: JSON.parse(String(r.feedback)) as RunFeedback }),
  nudges: Number(r.nudges),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const migrations = [
  // Version 1: the table as first built. Kept as history: every database
  // walks its versions in order, and version 2 below is what the shape is.
  `CREATE TABLE orchestrator_runs(
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, tracker_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
     conversation TEXT NOT NULL, lane TEXT NOT NULL, agent TEXT NOT NULL, state TEXT NOT NULL,
     session TEXT, worktree TEXT, outcome TEXT, question TEXT, move_lane TEXT,
     delivered INTEGER NOT NULL DEFAULT 0, nudges INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX orchestrator_runs_request ON orchestrator_runs(tracker_id, project_id, conversation, ticket_id);
   CREATE INDEX orchestrator_runs_session ON orchestrator_runs(session);
   CREATE INDEX orchestrator_runs_active_ticket ON orchestrator_runs(tracker_id, ticket_id, state);`,
  // Version 2 (ruled 2026-10-01, the follower design): a conversation is a
  // tracker's session, not an orchestrator fact; whether a tracker was told
  // is the follower's outbox, not this row's flag; the open question lives
  // in the OpenCode form. The target lane keeps its meaning under its own
  // name, and `awaiting_input` collapses into `working` — the form is the
  // truth of waiting, read from OpenCode when a turn ends.
  `DROP INDEX orchestrator_runs_request;
   ALTER TABLE orchestrator_runs RENAME COLUMN move_lane TO target_lane;
   ALTER TABLE orchestrator_runs DROP COLUMN conversation;
   ALTER TABLE orchestrator_runs DROP COLUMN question;
   ALTER TABLE orchestrator_runs DROP COLUMN delivered;
   UPDATE orchestrator_runs SET state='working' WHERE state='awaiting_input';`,
  // Version 3 (the dispatcher era, docs/orchestrator.md): a claim mirrors a
  // lease. The run row is the orchestrator's record of the ticket's slot;
  // the dispatcher never learns the ticket, and the orchestrator never
  // counts the slot — the column is the join.
  `ALTER TABLE orchestrator_runs ADD COLUMN lease_id TEXT;
   CREATE INDEX orchestrator_runs_lease ON orchestrator_runs(lease_id);`,
  // Version 4 (the feedback loop, docs/plans/git-workflow.md): the run row
  // remembers which review threads were open when the run started, how many
  // completions the gate refused, and whether the person has been asked.
  // One JSON value; the gate is pure arithmetic over it and one fresh read.
  `ALTER TABLE orchestrator_runs ADD COLUMN feedback TEXT;`,
];

export class RunLedger {
  private readonly core: Store;
  constructor(core: Store) {
    this.core = core;
    core.migrate('orchestrator', migrations);
  }

  /**
   * Open a run for a ticket, idempotently while it matters: a run still
   * **active** on this ticket — however it was reached — is returned, so one
   * ticket never gets two workers at a time. A finished run does not hold
   * the ticket: a later delegation is new work, and whether to ask for it is
   * the tracker's. `created` says whether this call made the row — only then
   * does the orchestrator prepare a session.
   */
  request(request: RunRequest, now = Date.now()): { run: Run; created: boolean } {
    return this.core.transaction(() => {
      const live = this.core.db
        .prepare(
          `SELECT * FROM orchestrator_runs WHERE tracker_id=? AND ticket_id=? AND ${ACTIVE} ORDER BY created_at DESC LIMIT 1`,
        )
        .get(request.trackerId, request.ticketId) as Row | undefined;
      if (live) return { run: map(live), created: false };
      const id = `run_${randomBytes(6).toString('hex')}`;
      this.core.db
        .prepare(
          `INSERT INTO orchestrator_runs(id,project_id,tracker_id,ticket_id,lane,agent,state,created_at,updated_at)
           VALUES(?,?,?,?,?,?, 'preparing', ?, ?)`,
        )
        .run(id, request.projectId, request.trackerId, request.ticketId, request.lane, request.agent, now, now);
      return { run: this.#require(id), created: true };
    });
  }

  #require(id: string): Run {
    const row = this.core.db.prepare('SELECT * FROM orchestrator_runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error(`No run ${id}`);
    return map(row);
  }

  get(id: string): Run | undefined {
    const row = this.core.db.prepare('SELECT * FROM orchestrator_runs WHERE id=?').get(id) as Row | undefined;
    return row && map(row);
  }

  /** Which run a worker session belongs to: how a tool call and turn events find their run. */
  bySession(sessionId: string): Run | undefined {
    const row = this.core.db
      .prepare(`SELECT * FROM orchestrator_runs WHERE session=? ORDER BY created_at DESC LIMIT 1`)
      .get(sessionId) as Row | undefined;
    return row && map(row);
  }

  /** The run, if any, that is still live on this ticket: the double-work guard. */
  activeByTicket(trackerId: string, ticketId: string): Run | undefined {
    const row = this.core.db
      .prepare(
        `SELECT * FROM orchestrator_runs WHERE tracker_id=? AND ticket_id=? AND ${ACTIVE} ORDER BY created_at DESC LIMIT 1`,
      )
      .get(trackerId, ticketId) as Row | undefined;
    return row && map(row);
  }

  /** Bind a run to the lease it claims. */
  /** An elicitation opened: the run parks on the person, and the
   *  keep-alive's clock starts with this row. Only a working run asks. */
  awaiting(id: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db
        .prepare(`UPDATE orchestrator_runs SET state='awaiting_input', updated_at=? WHERE id=? AND state='working'`)
        .run(now, id);
      return this.#require(id);
    });
  }

  /** The answer arrived and capacity stands behind it again: back to
   *  working. Only an awaiting run resumes; anything else stands. */
  resumed(id: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db
        .prepare(`UPDATE orchestrator_runs SET state='working', updated_at=? WHERE id=? AND state='awaiting_input'`)
        .run(now, id);
      return this.#require(id);
    });
  }

  /** The keep-alive ended and the lease went with it: the claim stands,
   *  the slot does not. The session stays where it is — the answer will
   *  find it. */
  clearLease(id: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db.prepare(`UPDATE orchestrator_runs SET lease_id=NULL, updated_at=? WHERE id=?`).run(now, id);
      return this.#require(id);
    });
  }

  setLease(id: string, leaseId: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db.prepare('UPDATE orchestrator_runs SET lease_id=?, updated_at=? WHERE id=?').run(leaseId, now, id);
      return this.#require(id);
    });
  }

  /** The live claim on a lease, if one still stands: the dispatcher's way
   *  back to the ticket when it ends a lease itself. */
  byLease(leaseId: string): Run | undefined {
    const row = this.core.db
      .prepare(`SELECT * FROM orchestrator_runs WHERE lease_id=? AND ${ACTIVE} ORDER BY created_at DESC LIMIT 1`)
      .get(leaseId) as Row | undefined;
    return row && map(row);
  }

  /** Runs that reached their ending after the instant, oldest first: what
   *  a follower's boot pass asks with its own watermark — endings that
   *  arrived while aivi slept, the picked-up work included. */
  terminalSince(trackerId: string, since: number): Run[] {
    return (
      this.core.db
        .prepare(
          `SELECT * FROM orchestrator_runs
           WHERE tracker_id=? AND state IN ('completed','failed','cancelled') AND updated_at > ?
           ORDER BY updated_at`,
        )
        .all(trackerId, since) as Row[]
    ).map(map);
  }

  /** Every run not yet terminal, oldest first: the boot pass re-attaches to these. */
  active(): Run[] {
    return (
      this.core.db.prepare(`SELECT * FROM orchestrator_runs WHERE ${ACTIVE} ORDER BY created_at`).all() as Row[]
    ).map(map);
  }

  /** The session and work directory exist: `preparing` → `working`. */
  attachSession(id: string, sessionId: string, worktree: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db
        .prepare(`UPDATE orchestrator_runs SET session=?, worktree=?, state='working', updated_at=? WHERE id=?`)
        .run(sessionId, worktree, now, id);
      return this.#require(id);
    });
  }

  /** One more premature turn-end counted; the orchestrator decides when the budget is spent. */
  bumpNudge(id: string, now = Date.now()): number {
    return this.core.transaction(() => {
      this.core.db.prepare(`UPDATE orchestrator_runs SET nudges=nudges+1, updated_at=? WHERE id=?`).run(now, id);
      return this.#require(id).nudges;
    });
  }

  /** The moment of the run's start, persisted: these open review threads —
   *  and only these — are what the completion gate can ever owe. A run that
   *  started clean is never snapshotted; feedback arriving mid-run is
   *  context, not a debt (ruled 2026-10-02). */
  snapshotFeedback(id: string, openThreadIds: string[], now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db
        .prepare('UPDATE orchestrator_runs SET feedback=?, updated_at=? WHERE id=?')
        .run(JSON.stringify({ openThreadIds, attempts: 0, escalated: false } satisfies RunFeedback), now, id);
      return this.#require(id);
    });
  }

  /** The gate refused a success: one more strike. Without a snapshot there
   *  is nothing to count — the caller checked, and silence here would be a
   *  bug's hiding place, so the row comes back untouched and unreadable
   *  callers are the orchestrator's problem to not have. */
  countFeedback(id: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      const previous = this.#require(id).feedback;
      if (previous)
        this.core.db
          .prepare('UPDATE orchestrator_runs SET feedback=?, updated_at=? WHERE id=?')
          .run(JSON.stringify({ ...previous, attempts: previous.attempts + 1 } satisfies RunFeedback), now, id);
      return this.#require(id);
    });
  }

  /** The escalation form stands: recorded with its id, so a second gate
   *  never doubles it and the answer that lands can be checked against it. */
  markEscalated(id: string, formId: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      const previous = this.#require(id).feedback;
      if (previous)
        this.core.db
          .prepare('UPDATE orchestrator_runs SET feedback=?, updated_at=? WHERE id=?')
          .run(JSON.stringify({ ...previous, escalated: true, formId } satisfies RunFeedback), now, id);
      return this.#require(id);
    });
  }

  /** The person answered the escalation: the strikes reset. Their words were
   *  "try again with these instructions", not "fail after three more"
   *  (ruled in the walkthrough); the escalated flag stays — the form was
   *  made once, and making it twice would be noise. */
  resetFeedback(id: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      const previous = this.#require(id).feedback;
      if (previous)
        this.core.db
          .prepare('UPDATE orchestrator_runs SET feedback=?, updated_at=? WHERE id=?')
          .run(JSON.stringify({ ...previous, attempts: 0 } satisfies RunFeedback), now, id);
      return this.#require(id);
    });
  }

  /**
   * A validated outcome ends the run: `completed` on success, `failed` on
   * failure. `targetLane` — computed from the project's lane order by the
   * orchestrator, never by a tracker — travels on the `ended` event; the
   * follower performs the move in its own time.
   */
  finish(id: string, outcome: RunOutcome, targetLane?: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db
        .prepare(`UPDATE orchestrator_runs SET outcome=?, target_lane=?, state=?, updated_at=? WHERE id=?`)
        .run(JSON.stringify(outcome), targetLane ?? null, outcome.kind === 'success' ? 'completed' : 'failed', now, id);
      return this.#require(id);
    });
  }

  /** The lane an ending still owes as a move: the run finished with a
   *  target lane and the move has not been reported landed. A boot pass
   *  re-drives these; performing the move is the tracker's, and it is
   *  idempotent, so a move that landed before the restart lands again as
   *  nothing. */
  moveOwed(trackerId: string): Run[] {
    return (
      this.core.db
        .prepare(
          `SELECT * FROM orchestrator_runs
         WHERE tracker_id=? AND state IN ('completed','failed') AND target_lane IS NOT NULL
         ORDER BY updated_at`,
        )
        .all(trackerId) as Row[]
    ).map(map);
  }

  /** The move landed: the debt is paid and the target lane goes quiet. */
  moveLanded(id: string, now = Date.now()): Run {
    this.core.db.prepare('UPDATE orchestrator_runs SET target_lane=NULL, updated_at=? WHERE id=?').run(now, id);
    return this.#require(id);
  }

  /** A stop ended the run without an outcome of the worker's; the ticket stays. */
  cancel(id: string, reason: string, now = Date.now()): Run {
    return this.core.transaction(() => {
      this.core.db
        .prepare(`UPDATE orchestrator_runs SET outcome=?, target_lane=NULL, state='cancelled', updated_at=? WHERE id=?`)
        .run(JSON.stringify({ kind: 'failure', reason } satisfies RunOutcome), now, id);
      return this.#require(id);
    });
  }
}

/** Project a run row to the read-only shape the outside may hold. */
export function view(run: Run): RunView {
  return { ...run };
}
