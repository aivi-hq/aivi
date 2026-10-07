/**
 * Linear's own durable pair: the agent session ↔ the OpenCode session ↔ the
 * ticket. The orchestrator does not know what an agent session is, so the
 * follower keeps that join itself — it is the whole reason a webhook naming
 * an agent session can find its worker's OpenCode session without asking
 * anybody, and the list a boot pass reconciles against Linear.
 *
 * Its own namespace, its own table (the `Store.migrate` contract every module
 * has: namespaced tables, never host tables).
 */
import type { Store } from '@aivi/plugin';

export interface RunLink {
  agentSession: string;
  ticketId: string;
  opencodeSession?: string;
  /** When the closing landed — the pair is settled and boot asks Linear
   *  about it no more. Absent means the closing is still owed. */
  endedAt?: number;
}

type Row = Record<string, unknown>;

const map = (r: Row): RunLink => ({
  agentSession: String(r.agent_session),
  ticketId: String(r.ticket_id),
  ...(r.opencode_session === null ? {} : { opencodeSession: String(r.opencode_session) }),
  ...(r.ended_at === null || r.ended_at === undefined ? {} : { endedAt: Number(r.ended_at) }),
});

const migrations = [
  `CREATE TABLE tracker_linear_run_links(
     agent_session TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, opencode_session TEXT UNIQUE,
     created_at INTEGER NOT NULL);
   CREATE INDEX tracker_linear_run_links_ticket ON tracker_linear_run_links(ticket_id);`,
  // The boot pass reads only the pairs whose closing has not landed, so the
  // index is **partial**: it holds the owed rows and nothing else, and the
  // settled history never weighs on a boot.
  `ALTER TABLE tracker_linear_run_links ADD COLUMN ended_at INTEGER;
   CREATE INDEX tracker_linear_run_links_owed ON tracker_linear_run_links(created_at) WHERE ended_at IS NULL;`,
];

export class RunLinks {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.migrate('tracker-linear', migrations);
  }

  /** The delegation happened: record the agent session and its ticket. The
   *  OpenCode session joins when the orchestrator's `started` event names
   *  this ticket's run. */
  bind(agentSession: string, ticketId: string, now = Date.now()): void {
    this.store.db
      .prepare(
        `INSERT INTO tracker_linear_run_links(agent_session, ticket_id, created_at) VALUES(?,?,?)
         ON CONFLICT(agent_session) DO UPDATE SET ticket_id=excluded.ticket_id`,
      )
      .run(agentSession, ticketId, now);
  }

  /** The run's session exists: attach it to the newest unattached pair for
   *  the ticket. Absent means the pair was already recorded (a replay). */
  attach(ticketId: string, opencodeSession: string): boolean {
    const changed = this.store.db
      .prepare(
        `UPDATE tracker_linear_run_links SET opencode_session=?
         WHERE agent_session = (
           SELECT agent_session FROM tracker_linear_run_links
           WHERE ticket_id=? AND opencode_session IS NULL ORDER BY created_at DESC LIMIT 1)
           AND opencode_session IS NULL`,
      )
      .run(opencodeSession, ticketId);
    return changed.changes > 0;
  }

  byAgentSession(agentSession: string): RunLink | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM tracker_linear_run_links WHERE agent_session=?')
      .get(agentSession) as Row | undefined;
    return row && map(row);
  }

  byOpencodeSession(opencodeSession: string): RunLink | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM tracker_linear_run_links WHERE opencode_session=?')
      .get(opencodeSession) as Row | undefined;
    return row && map(row);
  }

  /** Every pair whose closing has not landed: the boot pass reads the run
   *  state for each and catches Linear up wherever the run has ended. A
   *  settled pair is absent — its closing spoke Linear's own state once, and
   *  asking again forever was the bug (live, 2026-10-06). Follow-up routing
   *  never comes through here: it asks `byAgentSession` directly, settled or
   *  not. The lane move is not this list's business: it is the orchestrator's
   *  own debt in its own ledger. */
  owed(): RunLink[] {
    return (
      this.store.db
        .prepare(
          'SELECT * FROM tracker_linear_run_links WHERE opencode_session IS NOT NULL AND ended_at IS NULL ORDER BY created_at',
        )
        .all() as Row[]
    ).map(map);
  }

  /** The closing landed: settle the pair. The row stays — it is still the
   *  route a person's later message finds its run through. */
  closingLanded(agentSession: string, now = Date.now()): void {
    this.store.db
      .prepare('UPDATE tracker_linear_run_links SET ended_at=? WHERE agent_session=?')
      .run(now, agentSession);
  }

  /** Retire a pair for good. Its use today is the gone-closing: Linear
   *  answers the agent session with `Entity not found` — the ticket was
   *  deleted — so there is nothing left to pay and no reason for the next
   *  boot to ask again. */
  drop(agentSession: string): void {
    this.store.db.prepare('DELETE FROM tracker_linear_run_links WHERE agent_session=?').run(agentSession);
  }
}
