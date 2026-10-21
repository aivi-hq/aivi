/** One room's OpenCode session: normal in every sense, holding a real slot
 *  in a dispatcher pool while it works — the same capacity ticket work draws
 *  (`services.dispatcher`). A pool is an endpoint (capacity + optional
 *  model), so voice pools are pools like any other: name one in `pool`,
 *  and a room's session is born on that endpoint and stays there — the
 *  dispatcher pins a resume to the pool its session was created in.
 *
 *  Two shapes of speech reach it:
 *  - call rooms: every closed line prompts; while a turn runs the next line
 *    steers it (the interjection), no second slot needed for the same turn.
 *  - meeting rooms: only addressed lines arrive, serialized — one answered
 *    at a time, in order.
 *
 *  A full pool is not a lost prompt: the dispatcher takes the queue place
 *  (`queued`) and the module's callback hands the lease over when capacity
 *  frees. A `waiting` refusal (another voice room holds the pool's one
 *  place) waits for the module's fan-out after any voice release. No timers
 *  of ours.
 */

import type { Logger } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin';
import type { Dispatcher, DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import type { SessionEvents } from '@aivi/plugin/module';

export interface TurnPrompt {
  text: string;
  /** Who said these words, named or not: platform names, voiceprint-bound
   *  people, or empty when nothing could name them (ruled 2026-10-14 —
   *  plural because a flushed batch can hold several voices, and an empty
   *  list beats a guessed one). */
  speakers: string[];
  /** The wake phrase that activated this prompt, kept in metadata. */
  wake?: string;
}

/** One piece of the answer's text as it is written: a text block opening
 *  (`start`, with the assistant message id — the model began a message, or a
 *  tool ended one and the model resumed) and its streaming `delta`s. The room
 *  cuts sentences from these and speaks them as they land. */
export type AnswerText = { kind: 'start'; messageID: string } | { kind: 'delta'; messageID: string; delta: string };

export interface TurnsConfig {
  /** Dispatcher pool this room draws from (absent: the dispatcher's default). */
  pool?: string | undefined;
  agent: string;
  directory: string;
  /** Pin room prompts to their own model; absent means the pool's or the agent's. */
  model?: { providerID: string; modelID: string; variant?: string | undefined } | undefined;
  /** True for call rooms: a line that lands mid-turn steers the running turn. */
  steerWhenBusy: boolean;
  origin: string;
  /** The transcript group this room's lines belong to — meetings only.
   *  A call room has no record: its messages carry no transcript pointer. */
  transcript?: number | undefined;
}

export interface TurnsDeps {
  dispatcher: Dispatcher;
  opencode: () => Promise<OpenCodeClient>;
  /** Injected so tests can run turns without OpenCode. */
  runTurn: (
    client: OpenCodeClient,
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<{ text: string }>;
  /** The room's session id, kept across restarts (dispatcher-minted). */
  session(): string | undefined;
  rememberSession(id: string): void;
  /** The persisted session turned out dead (a previous serve's id): forget
   *  it so the retry mints a fresh one. */
  clearSession(): void;
  /** The grant→persist window is the only orphan a crash can hide; stated. */
  rememberLease(leaseId: string | null): void;
  /** Module routing: where a queue place belongs, and the fan-out that
   *  retries every room after any voice lease released. */
  requestSeat(requestId: string, turns: VoiceTurns): void;
  releaseSeat(requestId: string): void;
  capacityMoved(): void;
  servicesSignal: AbortSignal;
  events: SessionEvents;
  log: Logger;
}

const SERVICE = 'voice';

/** The one turn runner for one room's session. */
export class VoiceTurns {
  private queue: TurnPrompt[] = [];
  private running: { messageId: string; done: Promise<void> } | null = null;
  private queuedId: string | null = null;
  private sessionId: string | undefined;
  private staleSaid = false;
  private seq = 0;
  private stopped = false;
  /** The cut for the turn running NOW: `stop()` fires it so leaving a room
   *  does not wait on an answer nobody is left to hear. */
  private turnCut: AbortController | undefined;

  private readonly cfg: TurnsConfig;
  private readonly deps: TurnsDeps;

  constructor(cfg: TurnsConfig, deps: TurnsDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.sessionId = deps.session();
  }

  /** Restart recovery: leases voice held across the restart are unverified.
   *  Their sessions died with the process, and unlike channel turns a voice
   *  turn has no ticket to block — the slot goes straight back. The caller
   *  hands the persisted ids; the grant→persist window is the only orphan a
   *  crash can hide, stated in the README. */
  static async recover(
    leases: Array<{ label: string; leaseId: string }>,
    release: (leaseId: string) => Promise<unknown>,
    log: Logger,
  ): Promise<void> {
    for (const { label, leaseId } of leases) {
      try {
        await release(leaseId);
        log.info('turns.recovered', { room: label, lease: leaseId });
      } catch {
        // The lease already ended (a clean shutdown raced here): nothing to return.
      }
    }
  }

  /** A line arrived: steer the running turn (call rooms), or take a queue
   *  seat for a new turn. */
  prompt(p: TurnPrompt): void {
    if (this.stopped) return;
    if (this.running && this.cfg.steerWhenBusy && this.sessionId) {
      void this.steer(p);
      return;
    }
    this.queue.push(p);
    this.dispatch();
  }

  /** The module's callback routed here: our queue place became a lease. */
  fulfill(lease: DispatcherLeaseRef): void {
    this.forgetSeat();
    if (this.stopped || this.running || !this.queue.length) {
      // Nobody left to hear it: the slot goes straight back.
      void this.deps.dispatcher.release(lease.id).then(r => this.onReleased(r, lease.id));
      return;
    }
    const p = this.queue.shift()!;
    this.running = { messageId: this.messageId(), done: this.run(p, lease) };
  }

  /** Fan-out entry: capacity moved somewhere, `waiting` refusals try again. */
  retry(): void {
    this.dispatch();
  }

  private async steer(p: TurnPrompt): Promise<void> {
    const running = this.running;
    const sessionId = this.sessionId;
    if (!running || !sessionId) return;
    try {
      const client = await this.deps.opencode();
      await client.session.prompt({
        sessionID: sessionId,
        id: this.messageId(),
        text: p.text,
        delivery: 'steer',
        metadata: {
          aivi: {
            origin: this.cfg.origin,
            mode: 'call',
            ...(this.cfg.transcript !== undefined ? { transcript: this.cfg.transcript } : {}),
            ...(p.speakers.length ? { speakers: p.speakers } : {}),
            steer: running.messageId,
          },
        },
      });
    } catch (error) {
      this.deps.log.warn('turns.steer.failed', { error: String(error) });
    }
  }

  private dispatch(): void {
    if (this.stopped || this.running || !this.queue.length || this.queuedId) return;
    let grant: ReturnType<Dispatcher['request']>;
    try {
      grant = this.deps.dispatcher.request({
        service: SERVICE,
        ...(this.cfg.pool ? { pool: this.cfg.pool } : {}),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      });
    } catch (error) {
      // A pool name the dispatcher does not know: loud, and the prompt stays
      // where it was — the config fix is the only retry that helps.
      this.deps.log.warn('turns.pool.missing', { error: String(error), hint: `voice.pool: ${this.cfg.pool}` });
      return;
    }
    if ('queued' in grant) {
      this.queuedId = grant.queued;
      this.deps.requestSeat(grant.queued, this);
      // said, not silent: a prompt that waits for capacity must say it is
      // waiting, or the room looks deaf when it is only patient
      this.deps.log.info('turns.queued', { hint: 'the voice pool is full; the seat holds our place' });
      return;
    }
    if ('refused' in grant) {
      this.deps.log.info('turns.refused', {
        refused: grant.refused,
        pool: grant.pool,
        hint: 'another voice room holds the queue place; a released lease brings this back',
      });
      return;
    }
    const p = this.queue.shift()!;
    this.running = { messageId: this.messageId(), done: this.run(p, grant.lease) };
  }

  private async run(p: TurnPrompt, lease: DispatcherLeaseRef): Promise<void> {
    let leaseId = lease.id;
    try {
      if (lease.state === 'preparing') {
        // The pool decides the model at session create (the dispatcher's
        // rule); a room that pins its own model says so per prompt below.
        const attached = await this.deps.dispatcher.provide(leaseId, {
          agent: this.cfg.agent,
          directory: this.cfg.directory,
        });
        this.sessionId = attached.sessionId;
        if (attached.sessionId) this.deps.rememberSession(attached.sessionId);
        leaseId = attached.id;
      }
      this.deps.rememberLease(leaseId);
      // The turn is on: say so, with the session. A room that says nothing
      // here looks like it is only transcribing while the model is already
      // at work (the operator checked for a session during a two-minute
      // generation and found none — it was there, silent).
      this.deps.log.info('turns.started', {
        ...(this.sessionId === undefined ? {} : { session: this.sessionId }),
        chars: p.text.length,
      });
      // Our own cut cord, tied beside the host's: leaving a room does not
      // stand and wait for an answer nobody is left to hear.
      const cut = new AbortController();
      this.turnCut = cut;
      const client = await this.deps.opencode();
      const input: Record<string, unknown> = {
        sessionId: this.sessionId,
        agent: this.cfg.agent,
        directory: this.cfg.directory,
        create: false, // the lease's provide created it; a room keeps its conversation
        messageId: this.running?.messageId ?? this.messageId(),
        text: p.text,
        messageMetadata: {
          aivi: {
            origin: this.cfg.origin,
            ...(this.cfg.transcript !== undefined ? { transcript: this.cfg.transcript } : {}),
            ...(p.speakers.length ? { speakers: p.speakers } : {}),
            ...(p.wake ? { wake: p.wake } : {}),
          },
        },
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
      };
      const options = {
        signal: AbortSignal.any([this.deps.servicesSignal, cut.signal]),
        events: this.deps.events,
        log: this.deps.log,
        onPermission: 'reject' as const,
      };
      const offText = this.watchAnswerText();
      this.onTurnState?.('thinking');
      let result: { text: string };
      try {
        result = await this.deps.runTurn(client, input, options);
      } finally {
        offText();
      }
      // The room's mouth (if any) hears the answer; a missing mouth is fine.
      this.onAnswered?.(result.text);
      this.staleSaid = false;
    } catch (error) {
      if (this.stopped) {
        // Expected, not a failure: the room left and `stop()` cut the wait.
        // (OpenCode may still be finishing the answer server-side; the
        // release below says `pending-kill` if the slot is still busy,
        // and the dispatcher keeps watching — nothing is invented here.)
        this.deps.log.info('turns.cut', { hint: 'the room left while the model was still answering' });
      } else if (!this.staleSaid && this.sessionId && /Session not found/i.test(String(error))) {
        // A persisted session id outliving OpenCode's storage (a restart,
        // retention) is not a permanent dead room: forget it once, put the
        // line back, the next dispatch mints a fresh session. One strike —
        // a room that cannot start twice says so and waits for the next line.
        this.staleSaid = true;
        this.deps.log.info('turns.session.stale', {
          room: this.cfg.origin,
          session: this.sessionId,
          hint: 'the persisted session is gone; this room starts a fresh one',
        });
        this.sessionId = undefined;
        this.deps.clearSession();
        this.queue.unshift(p);
      } else {
        this.deps.log.warn('turns.failed', { error: String(error) });
      }
    } finally {
      this.running = null;
      this.turnCut = undefined;
      this.onTurnState?.('idle');
      this.deps.rememberLease(null);
      try {
        this.onReleased(await this.deps.dispatcher.release(leaseId), leaseId);
      } catch (error) {
        this.deps.log.warn('turns.lease.lost', { error: String(error) });
      }
      this.dispatch();
    }
  }

  /** Release answered: `pending` means the slot stays held until a kill is
   *  confirmed — the dispatcher keeps watching; we say so once. */
  private onReleased(result: { ended: DispatcherLeaseRef } | { pending: DispatcherLeaseRef }, leaseId: string): void {
    if ('pending' in result)
      this.deps.log.warn('turns.lease.pending-kill', { lease: leaseId, pool: result.pending.pool });
    this.deps.capacityMoved(); // every voice room retries; the scheduler too
  }

  /** Hook for the room: called with each finished answer (for TTS). */
  onAnswered: ((text: string) => void) | null = null;
  /** Hook for the room: the turn's lifecycle for the face to wear —
   *  `thinking` while the model works, `tool` while a tool runs, `idle`
   *  when the turn is over (a face that never changes while aivi thinks
   *  reads as a room that heard nothing). */
  onTurnState: ((state: 'thinking' | 'tool' | 'idle') => void) | null = null;
  /** Hook for the room: the answer's text AS IT IS WRITTEN. One call per
   *  `session.text.started` (a new text block — the model, or a tool, just
   *  began a message) and one per `session.text.delta`, each carrying the
   *  assistant message id so the room can cut sentences and speak them the
   *  moment they land instead of waiting for the whole answer. Watching the
   *  event stream is the same mechanism the channels' progress uses; voice
   *  is a streaming consumer like any other. */
  onText: ((ev: AnswerText) => void) | null = null;

  /** Watch this turn's session for answer text and tool calls; returns the
   *  unwatch. A miss (no session id, no onText) is a silent no-op — the
   *  whole answer still arrives through onAnswered. */
  private watchAnswerText(): () => void {
    const onText = this.onText;
    const onState = this.onTurnState;
    if ((!onText && !onState) || !this.sessionId) return () => {};
    return this.deps.events.watch(this.sessionId, event => {
      if (onState !== null) {
        // the face wears the turn: a running tool reads as busy even to a
        // room with no caption to show (event names are the channels'
        // progress watcher's own — one OpenCode stream, both consumers)
        if (event.type === 'session.tool.called') onState('tool');
        else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') onState('thinking');
      }
      if (!onText) return;
      const id = event.data?.assistantMessageID;
      if (typeof id !== 'string') return;
      if (event.type === 'session.text.started') onText({ kind: 'start', messageID: id });
      else if (event.type === 'session.text.delta') {
        const delta = event.data?.delta;
        if (typeof delta === 'string' && delta) onText({ kind: 'delta', messageID: id, delta });
      }
    });
  }

  private forgetSeat(): void {
    if (!this.queuedId) return;
    this.deps.releaseSeat(this.queuedId);
    this.queuedId = null;
  }

  private messageId(): string {
    return `msg_voice_${Date.now().toString(36)}_${(this.seq++ + 1000).toString(36)}`;
  }

  /** Stop: queued prompts are dropped (the transcript survives), the queue
   *  place is given up, and a running turn is CUT — told to stop spending
   *  (`session.interrupt`, the same call the channels' `/stop` uses) and
   *  its wait released. Leaving a room is not an audience: a two-minute
   *  answer with nobody left to hear it held `meet.leave` for its whole
   *  length (2026-10-14). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    if (this.queuedId) {
      this.deps.dispatcher.cancel(this.queuedId);
      this.forgetSeat();
    }
    const running = this.running;
    if (running) {
      const session = this.sessionId;
      if (session) {
        await this.deps
          .opencode()
          .then(client => client.session.interrupt({ sessionID: session }, { signal: AbortSignal.timeout(5_000) }))
          .catch(error => this.deps.log.warn('turns.interrupt.failed', { error: String(error) }));
      }
      this.turnCut?.abort();
      await running.done.catch(() => {});
    }
  }

  /** What a supervisor would ask: whether capacity is held right now. */
  get busy(): boolean {
    return this.running !== null;
  }
}
