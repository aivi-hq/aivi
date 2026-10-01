/**
 * The tickets a person stopped. The board may still hold a stopped ticket
 * in a worker lane — a stop leaves it where the person left it — and the
 * eligibility walk would otherwise hand it a fresh worker the next breath.
 * **Stop means stop**: the walk does not take a ticket whose worker a
 * person cancelled, until the person acts again.
 *
 * The person's next act is what clears the memory, and only a person's:
 * moving the ticket (its state changed: a fresh approval to enter work) or
 * a new run starting on it (a fresh delegation says so through the run
 * itself). A restart keeps the memory — a stopped ticket that survived
 * the restart is still stopped.
 *
 * Why the module holds this and not the orchestrator: the orchestrator's
 * ledger keeps the run’s record as fact, and a new run is always allowed
 * over a cancelled one (the ledger's guard speaks of **active** runs only);
 * deciding what the board may offer again is the follower's reading of its
 * own platform's moves.
 */
import type { Store } from '@aivi/plugin';

const migrations = [
  `CREATE TABLE tracker_linear_stopped(
     ticket_id TEXT PRIMARY KEY, stopped_at INTEGER NOT NULL);`,
];

export class StoppedTickets {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.migrate('tracker-linear-stopped', migrations);
  }

  /** The person stopped this ticket's worker: it stays off the walk's list. */
  mark(ticketId: string, now = Date.now()): void {
    this.store.db
      .prepare('INSERT OR REPLACE INTO tracker_linear_stopped(ticket_id, stopped_at) VALUES(?,?)')
      .run(ticketId, now);
  }

  /** The person moved the ticket or delegated it again: the stop is answered. */
  clear(ticketId: string): void {
    this.store.db.prepare('DELETE FROM tracker_linear_stopped WHERE ticket_id=?').run(ticketId);
  }

  has(ticketId: string): boolean {
    return this.store.db.prepare('SELECT 1 FROM tracker_linear_stopped WHERE ticket_id=?').get(ticketId) !== undefined;
  }
}
