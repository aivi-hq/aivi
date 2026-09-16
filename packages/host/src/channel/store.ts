import { randomUUID } from 'node:crypto';
import type { Config } from '@aivi/core';
import type { Store } from '../store.ts';
import type { ChannelPlatform } from './contract.ts';

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
  /** `message`: a person wrote it. `job`: aivi brings a job's outcome back into the conversation. */
  kind: TurnKind;
  /** Set when the conversation adopted a job's session: that session runs this agent in this directory, not the module's. */
  agent: string | null;
  directory: string | null;
  /** Text posted in the conversation before any session existed (a script's output); context for the first turn. */
  seed: string | null;
  /** The conversation's model override (`/model`), applied to the session before each prompt; null means the agent's default. */
  model: ModelRef | null;
  /** Set by `bind` for workers: one turn at a time per project and per issue across the module's conversations. */
  project: string | null;
  issue: string | null;
}
export type TurnState = 'queued' | 'running' | 'replying' | 'sent' | 'blocked' | 'discarded';
export type TurnKind = 'message' | 'job';
/** A catalogue model as OpenCode names it, with an optional variant (`high`, `max`). */
export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}
type Row = Record<string, unknown>;
const modelRef = (value: unknown): ModelRef | null => {
  if (value == null) return null;
  const parsed = JSON.parse(String(value)) as ModelRef;
  return {
    providerID: parsed.providerID,
    modelID: parsed.modelID,
    ...(parsed.variant ? { variant: parsed.variant } : {}),
  };
};
const modelJson = (model: ModelRef) =>
  JSON.stringify({
    providerID: model.providerID,
    modelID: model.modelID,
    ...(model.variant ? { variant: model.variant } : {}),
  });
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
  kind: (r.kind as TurnKind | undefined) ?? 'message',
  agent: r.agent == null ? null : String(r.agent),
  directory: r.directory == null ? null : String(r.directory),
  seed: r.seed == null ? null : String(r.seed),
  model: modelRef(r.model),
  project: r.project == null ? null : String(r.project),
  issue: r.issue == null ? null : String(r.issue),
});

const PENDING = "('queued','running','replying','blocked')";

/** Table names and ids derived from the module id; Discord's predate the contract and are unchanged by it. */
export const namesFor = (id: string) => ({
  binding: `${id}_binding`,
  sessions: `${id}_sessions`,
  turns: `${id}_turns`,
  leaseOwner: id,
  leaseID: (turnId: string) => `${id}:${turnId}`,
  newSession: () => `ses_${id}_${randomUUID().replaceAll('-', '')}`,
});

const migrations = (n: ReturnType<typeof namesFor>, id: string) => [
  `CREATE TABLE ${n.binding}(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
   CREATE TABLE ${n.sessions}(channel TEXT PRIMARY KEY, session TEXT NOT NULL, ready INTEGER NOT NULL);
   CREATE TABLE ${n.turns}(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
     channel TEXT NOT NULL, user TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
     session TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT);
   CREATE INDEX ${id}_pending ON ${n.turns}(state,seq);`,
  `ALTER TABLE ${n.turns} ADD COLUMN kind TEXT NOT NULL DEFAULT 'message' CHECK(kind IN ('message','job'));
   CREATE INDEX ${id}_session_lookup ON ${n.sessions}(session);`,
  `ALTER TABLE ${n.sessions} ADD COLUMN agent TEXT;
   ALTER TABLE ${n.sessions} ADD COLUMN directory TEXT;
   ALTER TABLE ${n.sessions} ADD COLUMN seed TEXT;`,
  `ALTER TABLE ${n.sessions} ADD COLUMN model TEXT;`,
  `ALTER TABLE ${n.sessions} ADD COLUMN project TEXT;
   ALTER TABLE ${n.sessions} ADD COLUMN issue TEXT;`,
];

/**
 * Durable inbox and conversation-to-session bindings of one channel module,
 * stored in the host database under the module's prefix. Capacity is shared
 * with scheduled jobs through host resource leases; a turn's claim and its
 * lease are one transaction.
 */
export class ConversationStore {
  readonly core: Store;
  readonly platform: ChannelPlatform;
  private readonly n: ReturnType<typeof namesFor>;
  private readonly select: string;
  constructor(core: Store, platform: ChannelPlatform, binding: string) {
    this.core = core;
    this.platform = platform;
    const n = namesFor(platform.id);
    this.n = n;
    this.select = `SELECT t.*,s.ready,s.agent,s.directory,s.seed,s.model,s.project,s.issue FROM ${n.turns} t JOIN ${n.sessions} s ON s.channel=t.channel`;
    core.migrate(platform.id, migrations(n, platform.id));
    core.transaction(() => {
      const previous = core.db.prepare(`SELECT value FROM ${n.binding} WHERE id=1`).get();
      if (previous && previous.value !== binding) {
        // A deliberate rebind (new agent or directory) is a /new for every conversation: old sessions
        // stay in OpenCode, the next message in each channel starts fresh. Pending work must be finished first.
        const pending = this.pending();
        if (pending)
          throw new Error(
            `${platform.label} application/agent/directory binding changed while ${pending} turn(s) are pending; resolve or finish them first`,
          );
        for (const row of core.db.prepare(`SELECT channel FROM ${n.sessions}`).all())
          core.db
            .prepare(
              `UPDATE ${n.sessions} SET session=?,ready=0,agent=NULL,directory=NULL,seed=NULL,model=NULL WHERE channel=?`,
            )
            .run(n.newSession(), String(row.channel));
        core.db.prepare(`UPDATE ${n.binding} SET value=? WHERE id=1`).run(binding);
        this.rebound = true;
        return;
      }
      core.db.prepare(`INSERT OR IGNORE INTO ${n.binding} VALUES(1,?)`).run(binding);
    });
  }
  /** True when this start replaced a previous binding and rotated every conversation's session. */
  rebound = false;

  private pending(channel?: string): number {
    const row = channel
      ? this.core.db
          .prepare(`SELECT count(*) AS n FROM ${this.n.turns} WHERE channel=? AND state IN ${PENDING}`)
          .get(channel)
      : this.core.db.prepare(`SELECT count(*) AS n FROM ${this.n.turns} WHERE state IN ${PENDING}`).get();
    return Number(row!.n);
  }

  /**
   * Restart recovery. A chat turn's only external effect is its reply, so an interrupted
   * turn is discarded and its capacity released; the caller tells the person. `running`
   * means no reply was sent; `replying` means it may have been partial. A platform whose
   * turns have effects of their own (`effects: 'work'`) cannot know whether the agent is
   * still at it, so those turns end `blocked` for an operator to inspect and resolve.
   */
  recover(): { id: string; channel: string; state: 'running' | 'replying' }[] {
    return this.core.transaction(() => {
      const interrupted = (
        this.core.db
          .prepare(`SELECT id,channel,state FROM ${this.n.turns} WHERE state IN ('running','replying') ORDER BY seq`)
          .all() as Row[]
      ).map(r => ({ id: String(r.id), channel: String(r.channel), state: r.state as 'running' | 'replying' }));
      for (const turn of interrupted) {
        if (this.platform.effects === 'work') {
          this.core.db
            .prepare(
              `UPDATE ${this.n.turns} SET state='blocked',error='Interrupted by a restart while working; inspect the session, then resolve' WHERE id=?`,
            )
            .run(turn.id);
          this.core.blockLease(this.n.leaseID(turn.id), this.n.leaseOwner, 'Interrupted by a restart while working');
          continue;
        }
        this.core.db
          .prepare(
            `UPDATE ${this.n.turns} SET state='discarded',text='',result=NULL,error='Interrupted by a restart' WHERE id=?`,
          )
          .run(turn.id);
        this.core.releaseLease(this.n.leaseID(turn.id), this.n.leaseOwner);
      }
      return interrupted;
    });
  }

  enqueue(
    input: { id: string; channel: string; user: string; name: string; text: string; kind?: TurnKind },
    maxPending: number,
  ): boolean {
    return this.core.transaction(() => {
      if (this.core.db.prepare(`SELECT id FROM ${this.n.turns} WHERE id=?`).get(input.id)) return false;
      if (this.pending() >= maxPending) throw new Error(`The ${this.platform.label} queue is full. Try again later.`);
      this.core.db
        .prepare(`INSERT OR IGNORE INTO ${this.n.sessions}(channel,session,ready) VALUES(?,?,0)`)
        .run(input.channel, this.n.newSession());
      const session = String(
        this.core.db.prepare(`SELECT session FROM ${this.n.sessions} WHERE channel=?`).get(input.channel)!.session,
      );
      this.core.db
        .prepare(
          `INSERT INTO ${this.n.turns}(id,channel,user,name,text,session,state,kind) VALUES(?,?,?,?,?,?,'queued',?)`,
        )
        .run(input.id, input.channel, input.user, input.name, input.text, session, input.kind ?? 'message');
      return true;
    });
  }

  /** The conversation (thread or channel) bound to a session, if this module owns it. */
  channelOf(session: string): string | null {
    const row = this.core.db.prepare(`SELECT channel FROM ${this.n.sessions} WHERE session=?`).get(session);
    return row ? String(row.channel) : null;
  }

  /** Bring a run's outcome into the conversation bound to `session` as a turn of kind `job`. */
  enqueueJobResult(runId: string, session: string, text: string, maxPending: number): boolean {
    const channel = this.channelOf(session);
    if (!channel) throw new Error(`No ${this.platform.label} conversation is bound to session ${session}`);
    return this.enqueue({ id: `run:${runId}`, channel, user: 'aivi', name: 'aivi', text, kind: 'job' }, maxPending);
  }

  reset(channel: string): void {
    this.core.transaction(() => {
      if (this.pending(channel))
        throw new Error('This conversation still has queued or unresolved work. Finish it before starting fresh.');
      this.core.db
        .prepare(
          `INSERT INTO ${this.n.sessions}(channel,session,ready) VALUES(?,?,0)
           ON CONFLICT(channel) DO UPDATE SET session=excluded.session,ready=0,agent=NULL,directory=NULL,seed=NULL,model=NULL`,
        )
        .run(channel, this.n.newSession());
    });
  }

  /**
   * Pin the model of a conversation's session for its next turns (`/model`); null returns to
   * the agent's default. Works before the first message too. `/new` and a rebind clear it.
   */
  setModel(channel: string, model: ModelRef | null): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(`INSERT OR IGNORE INTO ${this.n.sessions}(channel,session,ready) VALUES(?,?,0)`)
        .run(channel, this.n.newSession());
      this.core.db
        .prepare(`UPDATE ${this.n.sessions} SET model=? WHERE channel=?`)
        .run(model ? modelJson(model) : null, channel);
    });
  }

  /** The turn the agent is working on in this conversation, if any (`running`: no reply yet). */
  running(channel: string): Turn | null {
    const row = this.core.db.prepare(`${this.select} WHERE t.channel=? AND t.state='running'`).get(channel);
    return row ? turn(row as Row) : null;
  }

  /**
   * One turn per channel at a time, and for bound workers one per project and per issue
   * across channels (the project lock; a blocked worker keeps it until resolved). The
   * lease reserves shared model capacity in the same transaction.
   */
  claim(config: Config['scheduler'], resource: string): Turn | null {
    const rows = this.core.db
      .prepare(`${this.select}
      WHERE t.state='queued' AND NOT EXISTS (
        SELECT 1 FROM ${this.n.turns} busy JOIN ${this.n.sessions} bs ON bs.channel=busy.channel
        WHERE busy.state IN ('running','replying','blocked') AND (
          busy.channel=t.channel
          OR (s.project IS NOT NULL AND bs.project=s.project)
          OR (s.issue IS NOT NULL AND bs.issue=s.issue)
        )
      ) ORDER BY t.seq`)
      .all() as Row[];
    for (const row of rows) {
      const acquired = this.core.acquireLease(
        this.n.leaseID(String(row.id)),
        this.n.leaseOwner,
        resource,
        config.maxConcurrent,
        config.resources,
        () => {
          this.core.db.prepare(`UPDATE ${this.n.turns} SET state='running' WHERE id=?`).run(String(row.id));
        },
      );
      if (acquired) return turn({ ...row, state: 'running' });
      // Every turn uses the same pool, so a refusal is a capacity refusal for all of them.
      break;
    }
    return null;
  }

  state(id: string): TurnState | undefined {
    const row = this.core.db.prepare(`SELECT state FROM ${this.n.turns} WHERE id=?`).get(id);
    return row ? (row.state as TurnState) : undefined;
  }
  /** aivi already takes part in this conversation. */
  has(channel: string): boolean {
    return Boolean(this.core.db.prepare(`SELECT 1 FROM ${this.n.sessions} WHERE channel=?`).get(channel));
  }
  /** The native session exists; a seed has been read into its first turn and is no longer needed. */
  ready(channel: string): void {
    this.core.db.prepare(`UPDATE ${this.n.sessions} SET ready=1,seed=NULL WHERE channel=?`).run(channel);
  }

  /**
   * Bind a new conversation to a fresh session that runs `agent` in `directory` (a
   * worker in its worktree), keyed for the locks by `project` and `issue`. Refused when
   * the conversation already exists.
   */
  bind(channel: string, binding: { agent: string; directory: string; project: string; issue: string }): void {
    this.core.transaction(() => {
      if (this.has(channel)) throw new Error(`${this.platform.label} conversation ${channel} already has a session`);
      this.core.db
        .prepare(
          `INSERT INTO ${this.n.sessions}(channel,session,ready,agent,directory,project,issue) VALUES(?,?,0,?,?,?,?)`,
        )
        .run(channel, this.n.newSession(), binding.agent, binding.directory, binding.project, binding.issue);
    });
  }

  /** Move a bound conversation's directory before its session exists (the worktree ended up elsewhere). */
  rebind(channel: string, binding: { directory: string }): void {
    const result = this.core.db
      .prepare(`UPDATE ${this.n.sessions} SET directory=? WHERE channel=? AND ready=0`)
      .run(binding.directory, channel);
    if (!Number(result.changes)) throw new Error(`${this.platform.label} conversation ${channel} cannot be rebound`);
  }

  /**
   * The conversation whose pending turn keeps `channel`'s next turn waiting: the same
   * issue or project busy elsewhere; null when nothing stands in the way.
   */
  waitingOn(channel: string): { channel: string; issue: string | null } | null {
    const row = this.core.db
      .prepare(
        `SELECT bs.channel AS channel, bs.issue AS issue FROM ${this.n.sessions} s
         JOIN ${this.n.sessions} bs ON bs.channel<>s.channel AND (
           (s.project IS NOT NULL AND bs.project=s.project) OR (s.issue IS NOT NULL AND bs.issue=s.issue))
         JOIN ${this.n.turns} busy ON busy.channel=bs.channel AND busy.state IN ('running','replying','blocked')
         WHERE s.channel=? LIMIT 1`,
      )
      .get(channel);
    return row ? { channel: String(row.channel), issue: row.issue == null ? null : String(row.issue) } : null;
  }

  /**
   * A new thread that shows a job's outcome becomes a conversation. An agent job's
   * thread continues the job's own session (the agent remembers what it did); a
   * script job's thread gets a fresh session whose first turn is seeded with the output.
   */
  adopt(channel: string, binding: { session: string; agent: string; directory: string } | { seed: string }): void {
    this.core.transaction(() => {
      if (this.has(channel)) throw new Error(`${this.platform.label} conversation ${channel} already has a session`);
      if ('seed' in binding)
        this.core.db
          .prepare(`INSERT INTO ${this.n.sessions}(channel,session,ready,seed) VALUES(?,?,0,?)`)
          .run(channel, this.n.newSession(), binding.seed);
      else
        this.core.db
          .prepare(`INSERT INTO ${this.n.sessions}(channel,session,ready,agent,directory) VALUES(?,?,1,?,?)`)
          .run(channel, binding.session, binding.agent, binding.directory);
    });
  }
  result(id: string, result: string): void {
    this.core.db.prepare(`UPDATE ${this.n.turns} SET state='replying',result=? WHERE id=?`).run(result, id);
  }

  sent(id: string): void {
    this.core.transaction(() => {
      // The native session keeps the transcript; the inbox only needs the delivery record.
      this.core.db.prepare(`UPDATE ${this.n.turns} SET state='sent',text='',result=NULL WHERE id=?`).run(id);
      this.core.releaseLease(this.n.leaseID(id), this.n.leaseOwner);
    });
  }

  block(id: string): void {
    this.core.transaction(() => {
      // Avoid persisting provider/platform error bodies that may contain credentials or private tool output.
      this.core.db
        .prepare(
          `UPDATE ${this.n.turns} SET state='blocked',error='Turn or delivery interrupted; operator inspection required' WHERE id=?`,
        )
        .run(id);
      this.core.blockLease(this.n.leaseID(id), this.n.leaseOwner, 'Turn or delivery interrupted');
    });
  }

  /** The turn never reached the agent: nothing to inspect, so capacity is released at once. */
  fail(id: string): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          `UPDATE ${this.n.turns} SET state='discarded',text='',error='Not started: agent runtime unreachable or session setup failed' WHERE id=? AND state='running'`,
        )
        .run(id);
      this.core.releaseLease(this.n.leaseID(id), this.n.leaseOwner);
    });
  }

  /**
   * The turn ends without an answer by choice: the host is going down, or the person asked
   * (`/stop`). Like a restart, the turn's only external effect is its reply, so it is
   * discarded and its capacity released; the caller tells the person.
   */
  interrupt(id: string, reason = 'Interrupted by a shutdown'): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          `UPDATE ${this.n.turns} SET state='discarded',text='',result=NULL,error=? WHERE id=? AND state IN ('running','replying')`,
        )
        .run(reason, id);
      this.core.releaseLease(this.n.leaseID(id), this.n.leaseOwner);
    });
  }

  /** Conversations with messages still waiting; they survive a restart and are answered after it. */
  queuedChannels(): string[] {
    return (
      this.core.db.prepare(`SELECT DISTINCT channel FROM ${this.n.turns} WHERE state='queued'`).all() as Row[]
    ).map(r => String(r.channel));
  }

  /** The session a conversation is bound to, with what the binding pinned; null when aivi is not part of it yet. */
  sessionOf(channel: string): {
    session: string;
    ready: boolean;
    agent: string | null;
    directory: string | null;
    model: ModelRef | null;
    project: string | null;
    issue: string | null;
  } | null {
    const row = this.core.db
      .prepare(`SELECT session,ready,agent,directory,model,project,issue FROM ${this.n.sessions} WHERE channel=?`)
      .get(channel);
    if (!row) return null;
    return {
      session: String(row.session),
      ready: Boolean(Number(row.ready)),
      agent: row.agent == null ? null : String(row.agent),
      directory: row.directory == null ? null : String(row.directory),
      model: modelRef(row.model),
      project: row.project == null ? null : String(row.project),
      issue: row.issue == null ? null : String(row.issue),
    };
  }

  resolve(id: string, reason: string): void {
    if (!reason.trim()) throw new Error('A reason is required');
    this.core.transaction(() => {
      const result = this.core.db
        .prepare(`UPDATE ${this.n.turns} SET state='discarded',error=? WHERE id=? AND state='blocked'`)
        .run(reason, id);
      if (!Number(result.changes)) throw new Error('Only a blocked turn can be resolved');
      this.core.releaseLease(this.n.leaseID(id), this.n.leaseOwner);
    });
  }

  list(channel?: string): Turn[] {
    const rows = channel
      ? this.core.db.prepare(`${this.select} WHERE t.channel=? ORDER BY t.seq`).all(channel)
      : this.core.db.prepare(`${this.select} ORDER BY t.seq`).all();
    return (rows as Row[]).map(turn);
  }
}
