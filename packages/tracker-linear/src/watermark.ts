/**
 * How far this module has rendered run endings on Linear. The delegated era
 * found its owed ceremonies in its own pairs; a run the eligibility walk
 * picked up has no pair — nobody delegated it — so the ending of one that
 * died mid-outage lives only in the orchestrator's record. The watermark
 * is the module's reading position into that record: endings after it get
 * rendered, a failure leaves it where it stands so the next boot tries the
 * same endings, and the closing note's own idempotence means a retry never
 * says anything twice.
 *
 * A fresh watermark starts at *now*: endings before the walk existed have
 * pairs or never happened, and an upgrade owes nobody a retrospective.
 */
import type { Store } from '@aivi/plugin';

const migrations = [
  `CREATE TABLE tracker_linear_walk_watermark(
     id INTEGER PRIMARY KEY CHECK(id=1), watermark INTEGER NOT NULL);`,
];

export class WalkWatermark {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.migrate('tracker-linear-walk', migrations);
    this.store.db
      .prepare('INSERT OR IGNORE INTO tracker_linear_walk_watermark(id, watermark) VALUES(1,?)')
      .run(Date.now());
  }

  /** Renderings after this instant are owed; at or before it are said. */
  since(): number {
    const row = this.store.db.prepare('SELECT watermark FROM tracker_linear_walk_watermark WHERE id=1').get() as {
      watermark: number;
    };
    return Number(row.watermark);
  }

  /** The walk forward never retreats: renderings land in update order. */
  advanceTo(instant: number): void {
    this.store.db
      .prepare('UPDATE tracker_linear_walk_watermark SET watermark=? WHERE id=1 AND watermark<?')
      .run(instant, instant);
  }
}
