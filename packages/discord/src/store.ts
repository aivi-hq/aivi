import { randomUUID } from 'node:crypto';
import type { Config } from '@aivi/core';
import type { Store } from '@aivi/host';

export interface Turn {
  id: string;
  channel: string;
  user: string;
  name: string;
  text: string;
  session: string;
  ready: boolean;
  state: TurnState;
  result: string | null;
  error: string | null;
}
export type TurnState = 'queued' | 'running' | 'replying' | 'sent' | 'blocked' | 'discarded';
type Row = Record<string, unknown>;
const turn = (r: Row): Turn => ({
  id: String(r.id),
  channel: String(r.channel),
  user: String(r.user),
  name: String(r.name),
  text: String(r.text),
  session: String(r.session),
  ready: Boolean(Number(r.ready)),
  state: r.state as TurnState,
  result: r.result === null ? null : String(r.result),
  error: r.error === null ? null : String(r.error),
});

export const LEASE_OWNER = 'discord';
export const leaseID = (id: string) => `discord:${id}`;
const newSession = () => `ses_discord_${randomUUID().replaceAll('-', '')}`;

const migrations = [
  `CREATE TABLE discord_binding(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
   CREATE TABLE discord_sessions(channel TEXT PRIMARY KEY, session TEXT NOT NULL, ready INTEGER NOT NULL);
   CREATE TABLE discord_turns(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
     channel TEXT NOT NULL, user TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
     session TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT);
   CREATE INDEX discord_pending ON discord_turns(state,seq);`,
];

/**
 * Durable Discord inbox and channel-to-session bindings, stored in the host
 * database under the `discord_` prefix. Capacity is shared with scheduled jobs
 * through host resource leases; a turn's claim and its lease are one transaction.
 */
export class DiscordStore {
  readonly core: Store;
  constructor(core: Store, binding: string) {
    this.core = core;
    core.migrate('discord', migrations);
    core.transaction(() => {
      const previous = core.db.prepare('SELECT value FROM discord_binding WHERE id=1').get();
      if (previous && previous.value !== binding) {
        // A deliberate rebind (new agent or directory) is a /new for every conversation: old sessions
        // stay in OpenCode, the next message in each channel starts fresh. Pending work must be finished first.
        const pending = core.db
          .prepare("SELECT count(*) AS n FROM discord_turns WHERE state IN ('queued','running','replying','blocked')")
          .get()!.n;
        if (Number(pending))
          throw new Error(
            `Discord application/agent/directory binding changed while ${pending} turn(s) are pending; resolve or finish them first`,
          );
        for (const row of core.db.prepare('SELECT channel FROM discord_sessions').all())
          core.db
            .prepare('UPDATE discord_sessions SET session=?,ready=0 WHERE channel=?')
            .run(newSession(), String(row.channel));
        core.db.prepare('UPDATE discord_binding SET value=? WHERE id=1').run(binding);
        this.rebound = true;
        return;
      }
      core.db.prepare('INSERT OR IGNORE INTO discord_binding VALUES(1,?)').run(binding);
    });
  }
  /** True when this start replaced a previous binding and rotated every conversation's session. */
  rebound = false;

  /**
   * Restart recovery. A conversation turn's only external effect is its reply, so an
   * interrupted turn is discarded and its capacity released; the caller tells the person.
   * `running` means no reply was sent; `replying` means it may have been partial.
   */
  recover(): { id: string; channel: string; state: 'running' | 'replying' }[] {
    return this.core.transaction(() => {
      const interrupted = (
        this.core.db
          .prepare("SELECT id,channel,state FROM discord_turns WHERE state IN ('running','replying') ORDER BY seq")
          .all() as Row[]
      ).map(r => ({ id: String(r.id), channel: String(r.channel), state: r.state as 'running' | 'replying' }));
      for (const turn of interrupted) {
        this.core.db
          .prepare(
            "UPDATE discord_turns SET state='discarded',text='',result=NULL,error='Interrupted by a restart' WHERE id=?",
          )
          .run(turn.id);
        this.core.releaseLease(leaseID(turn.id), LEASE_OWNER);
      }
      return interrupted;
    });
  }

  enqueue(
    input: { id: string; channel: string; user: string; name: string; text: string },
    maxPending: number,
  ): boolean {
    return this.core.transaction(() => {
      if (this.core.db.prepare('SELECT id FROM discord_turns WHERE id=?').get(input.id)) return false;
      const pending = Number(
        this.core.db
          .prepare("SELECT count(*) AS n FROM discord_turns WHERE state IN ('queued','running','replying','blocked')")
          .get()!.n,
      );
      if (pending >= maxPending) throw new Error('The Discord queue is full. Try again later.');
      this.core.db.prepare('INSERT OR IGNORE INTO discord_sessions VALUES(?,?,0)').run(input.channel, newSession());
      const session = String(
        this.core.db.prepare('SELECT session FROM discord_sessions WHERE channel=?').get(input.channel)!.session,
      );
      this.core.db
        .prepare("INSERT INTO discord_turns(id,channel,user,name,text,session,state) VALUES(?,?,?,?,?,?,'queued')")
        .run(input.id, input.channel, input.user, input.name, input.text, session);
      return true;
    });
  }

  reset(channel: string): void {
    this.core.transaction(() => {
      if (
        this.core.db
          .prepare(
            "SELECT id FROM discord_turns WHERE channel=? AND state IN ('queued','running','replying','blocked')",
          )
          .get(channel)
      ) {
        throw new Error('This conversation still has queued or unresolved work. Finish it before starting fresh.');
      }
      this.core.db
        .prepare(
          'INSERT INTO discord_sessions VALUES(?,?,0) ON CONFLICT(channel) DO UPDATE SET session=excluded.session,ready=0',
        )
        .run(channel, newSession());
    });
  }

  /** One turn per channel at a time; the lease reserves shared model capacity. */
  claim(config: Config['scheduler'], resource: string): Turn | null {
    const rows = this.core.db
      .prepare(`SELECT t.*,s.ready FROM discord_turns t JOIN discord_sessions s ON s.channel=t.channel
      WHERE t.state='queued' AND NOT EXISTS (
        SELECT 1 FROM discord_turns busy WHERE busy.channel=t.channel AND busy.state IN ('running','replying','blocked')
      ) ORDER BY t.seq`)
      .all() as Row[];
    for (const row of rows) {
      const acquired = this.core.acquireLease(
        leaseID(String(row.id)),
        LEASE_OWNER,
        resource,
        config.maxConcurrent,
        config.resources,
        () => {
          this.core.db.prepare("UPDATE discord_turns SET state='running' WHERE id=?").run(String(row.id));
        },
      );
      if (acquired) return turn({ ...row, state: 'running' });
      // Every turn uses the same pool, so a refusal is a capacity refusal for all of them.
      break;
    }
    return null;
  }

  state(id: string): TurnState | undefined {
    const row = this.core.db.prepare('SELECT state FROM discord_turns WHERE id=?').get(id);
    return row ? (row.state as TurnState) : undefined;
  }
  /** aivi already takes part in this conversation. */
  has(channel: string): boolean {
    return Boolean(this.core.db.prepare('SELECT 1 FROM discord_sessions WHERE channel=?').get(channel));
  }
  ready(channel: string): void {
    this.core.db.prepare('UPDATE discord_sessions SET ready=1 WHERE channel=?').run(channel);
  }
  result(id: string, result: string): void {
    this.core.db.prepare("UPDATE discord_turns SET state='replying',result=? WHERE id=?").run(result, id);
  }

  sent(id: string): void {
    this.core.transaction(() => {
      // The native session keeps the transcript; the inbox only needs the delivery record.
      this.core.db.prepare("UPDATE discord_turns SET state='sent',text='',result=NULL WHERE id=?").run(id);
      this.core.releaseLease(leaseID(id), LEASE_OWNER);
    });
  }

  block(id: string): void {
    this.core.transaction(() => {
      // Avoid persisting provider/Discord error bodies that may contain credentials or private tool output.
      this.core.db
        .prepare(
          "UPDATE discord_turns SET state='blocked',error='Turn or delivery interrupted; operator inspection required' WHERE id=?",
        )
        .run(id);
      this.core.blockLease(leaseID(id), LEASE_OWNER, 'Turn or delivery interrupted');
    });
  }

  /** The turn never reached the agent: nothing to inspect, so capacity is released at once. */
  fail(id: string): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          "UPDATE discord_turns SET state='discarded',text='',error='Not started: agent runtime unreachable or session setup failed' WHERE id=? AND state='running'",
        )
        .run(id);
      this.core.releaseLease(leaseID(id), LEASE_OWNER);
    });
  }

  resolve(id: string, reason: string): void {
    if (!reason.trim()) throw new Error('A reason is required');
    this.core.transaction(() => {
      const result = this.core.db
        .prepare("UPDATE discord_turns SET state='discarded',error=? WHERE id=? AND state='blocked'")
        .run(reason, id);
      if (!Number(result.changes)) throw new Error('Only a blocked turn can be resolved');
      this.core.releaseLease(leaseID(id), LEASE_OWNER);
    });
  }

  list(channel?: string): Turn[] {
    const rows = channel
      ? this.core.db
          .prepare(
            'SELECT t.*,s.ready FROM discord_turns t JOIN discord_sessions s ON s.channel=t.channel WHERE t.channel=? ORDER BY t.seq',
          )
          .all(channel)
      : this.core.db
          .prepare(
            'SELECT t.*,s.ready FROM discord_turns t JOIN discord_sessions s ON s.channel=t.channel ORDER BY t.seq',
          )
          .all();
    return (rows as Row[]).map(turn);
  }
}
