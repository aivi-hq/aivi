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
}

type Row = Record<string, unknown>;

const map = (r: Row): RunLink => ({
  agentSession: String(r.agent_session),
  ticketId: String(r.ticket_id),
  ...(r.opencode_session === null ? {} : { opencodeSession: String(r.opencode_session) }),
});

const migrations = [
  `CREATE TABLE tracker_linear_run_links(
     agent_session TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, opencode_session TEXT UNIQUE,
     created_at INTEGER NOT NULL);
   CREATE INDEX tracker_linear_run_links_ticket ON tracker_linear_run_links(ticket_id);`,
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

  /** Every pair that has a worker session: the boot pass reads the run state
   *  for each and catches Linear up wherever the run has ended. */
  attached(): RunLink[] {
    return (
      this.store.db
        .prepare('SELECT * FROM tracker_linear_run_links WHERE opencode_session IS NOT NULL ORDER BY created_at')
        .all() as Row[]
    ).map(map);
  }

  /** Retire a pair for good. Its use today is the gone-closing: Linear
   *  answers the agent session with `Entity not found` — the ticket was
   *  deleted — so there is nothing left to pay and no reason for the next
   *  boot to ask again. */
  drop(agentSession: string): void {
    this.store.db.prepare('DELETE FROM tracker_linear_run_links WHERE agent_session=?').run(agentSession);
  }
}
