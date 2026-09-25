import type { Config, Logger } from '@aivi/core';
import { errorMessage, getLogger } from '@aivi/core';
import { TurnNotStarted } from '../session.ts';
import type { ChannelDelivery, EngineNotices } from './contract.ts';
import { type ProgressOptions, ProgressReporter } from './reporter.ts';
import type { ConversationStore, Turn } from './store.ts';

/** Split on code points so surrogate pairs survive; the limit counts UTF-16 units like the platforms do. */
export function splitReply(text: string, limit: number): string[] {
  if (limit < 2) throw new Error('Reply limit must allow surrogate pairs');
  const chunks: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export type Ask = (turn: Turn, signal: AbortSignal, ready: () => void) => Promise<string>;
export type Send = ChannelDelivery['send'];
export interface EngineLimits {
  resource: string;
  maxConcurrent: number;
  turnTimeoutMs: number;
}
export interface EngineOptions {
  log?: Logger;
  /** A turn released shared capacity; the host may have queued jobs waiting for it. */
  onRelease?: () => void;
  /** The store failed underneath a turn; the engine has stopped itself and the host should know. */
  onFailure?: (error: unknown) => void;
  /** Progress placeholder while a turn runs; `silent`, or a delivery without `edit`, means none. */
  progress?: ProgressOptions;
}

/** Claims queued turns within shared capacity, asks the native session, and delivers replies. */
export class ChannelEngine {
  private readonly abort = new AbortController();
  private readonly active = new Map<string, { work: Promise<void>; abort: AbortController }>();
  private failure: unknown;
  private readonly log: Logger;
  private readonly store: ConversationStore;
  private readonly limits: EngineLimits;
  private readonly scheduler: Config['scheduler'];
  private readonly ask: Ask;
  private readonly delivery: ChannelDelivery;
  private readonly progress: ProgressOptions | undefined;
  private readonly onRelease: () => void;
  private readonly onFailure: (error: unknown) => void;
  private readonly notices: EngineNotices;
  constructor(
    store: ConversationStore,
    limits: EngineLimits,
    scheduler: Config['scheduler'],
    ask: Ask,
    delivery: ChannelDelivery,
    options: EngineOptions = {},
  ) {
    this.store = store;
    this.limits = limits;
    this.scheduler = scheduler;
    this.ask = ask;
    this.delivery = delivery;
    this.progress = options.progress;
    this.log = options.log ?? getLogger(['aivi', store.platform.id]);
    this.onRelease = options.onRelease ?? (() => {});
    this.onFailure = options.onFailure ?? (() => {});
    this.notices = { ...CHAT_NOTICES, ...store.platform.notices };
  }

  tick(): void {
    while (!this.abort.signal.aborted && this.active.size < this.limits.maxConcurrent) {
      const turn = this.store.claim(this.scheduler, this.limits.resource);
      if (!turn) break;
      this.launch(turn);
    }
  }

  private reporter(turn: Turn, log: Logger): ProgressReporter | undefined {
    const progress = this.progress;
    const { edit } = this.delivery;
    if (!progress || progress.mode === 'silent' || !edit) return undefined;
    return new ProgressReporter(
      { ...this.delivery, edit },
      turn.channel,
      turn.session,
      { ...progress, mode: progress.mode },
      log,
    );
  }

  private launch(turn: Turn): void {
    const log = this.log.with({ turn: turn.id, channel: turn.channel });
    const startedAt = Date.now();
    log.info('turn.started', { newSession: !turn.ready });
    const reporter = this.reporter(turn, log);
    const notice = this.delivery.notice ?? ((c: string, t: string) => this.delivery.send(c, t).then(() => {}));
    const tell = (text: string) =>
      (reporter ? reporter.fail(text) : notice(turn.channel, text)).catch(error =>
        log.warn('notify.failed', { error }),
      );
    const state = { delivering: false };
    const own = new AbortController();
    const work = Promise.resolve()
      .then(async () => {
        try {
          await this.runTurn(turn, own, state, reporter, log, startedAt);
        } catch (error) {
          await this.settleTurn(turn, error, state, own.signal.aborted, tell, log);
        }
      })
      .catch(error => {
        this.log.error('engine.failed', { error });
        this.failure = error;
        this.stop();
        this.onFailure(error);
      })
      .finally(() => {
        this.active.delete(turn.id);
        this.tick(); // capacity was just released; do not wait for the next poll
        this.onRelease();
      });
    this.active.set(turn.id, { work, abort: own });
  }

  /** Answer the turn and deliver the reply in order; anything thrown here is an early end. */
  private async runTurn(
    turn: Turn,
    own: AbortController,
    state: { delivering: boolean },
    reporter: ProgressReporter | undefined,
    log: Logger,
    startedAt: number,
  ): Promise<void> {
    const signal = AbortSignal.any([this.abort.signal, own.signal, AbortSignal.timeout(this.limits.turnTimeoutMs)]);
    const text = await this.ask(turn, signal, () => this.store.ready(turn.channel));
    const answeredMs = Date.now() - startedAt;
    this.store.result(turn.id, text);
    state.delivering = true;
    const chunks = splitReply(text, this.store.platform.replyLimit);
    if (reporter) await reporter.finish(chunks);
    else for (const chunk of chunks) await this.delivery.send(turn.channel, chunk);
    this.store.sent(turn.id);
    log.info('turn.sent', { answeredMs, totalMs: Date.now() - startedAt, chars: text.length });
  }

  /** Why the turn ended early: every branch records the state and tells the person.
   *  `stoppedByRequest` is read at the catch, before anything here awaits. */
  private async settleTurn(
    turn: Turn,
    error: unknown,
    state: { delivering: boolean },
    stoppedByRequest: boolean,
    tell: (text: string) => Promise<void>,
    log: Logger,
  ): Promise<void> {
    if (stoppedByRequest && !state.delivering) {
      // Someone in the conversation asked (`/stop`): discarded like a shutdown, but said so.
      log.info('turn.stopped');
      this.store.interrupt(turn.id, STOPPED_REASON);
      await tell(this.notices.stopped);
      return;
    }
    if (error instanceof TurnNotStarted) {
      // Nothing reached the agent: release capacity and let the person try again.
      log.warn('turn.not_started', { error });
      this.store.fail(turn.id);
      await tell(this.notices.notStarted);
      return;
    }
    if (this.abort.signal.aborted) {
      // The host is going down. As after a restart, the reply is the turn's only external
      // effect, so the turn is discarded rather than blocked, and the person hears why.
      log.info('turn.interrupted', { delivering: state.delivering });
      this.store.interrupt(turn.id);
      await tell(state.delivering ? this.notices.offlineMidReply : this.notices.offline);
      return;
    }
    // A chat turn's only effect is its reply, so a known end (provider/auth error,
    // timeout, delivery failure) is just a failure: release capacity and say why.
    // Only a worker (`effects: 'work'`) blocks, because its checkout may still be moving.
    const reason = shortReason(error);
    if (this.store.platform.effects === 'work') {
      log.warn('turn.blocked', { error });
      this.store.block(turn.id);
      await tell(this.notices.blocked);
    } else {
      log.warn('turn.failed', { error });
      this.store.fail(turn.id, reason);
      await tell(`${this.notices.failed} (${reason})`);
    }
  }

  /**
   * Abort the turn running in a conversation (`/stop`). Only a turn still waiting for its
   * answer can be stopped; once the reply is on its way it lands. Returns the turn, or null
   * when nothing was running. The caller interrupts the native session afterwards.
   */
  stopTurn(channel: string): Turn | null {
    const turn = this.store.running(channel);
    const entry = turn && this.active.get(turn.id);
    if (!turn || !entry || entry.abort.signal.aborted) return null;
    entry.abort.abort(new Error(STOPPED_REASON));
    return turn;
  }

  stop(): void {
    this.abort.abort();
  }
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
  async drain(): Promise<void> {
    await Promise.all([...this.active.values()].map(a => a.work));
    if (this.failure !== undefined) throw this.failure;
  }
  /**
   * Going down: stop claiming, tell every conversation that is still waiting (its
   * messages survive the restart and are answered after it), then let the running
   * turns finish their own goodbye. Notices are best effort and never delay the stop.
   */
  async shutdown(): Promise<void> {
    this.stop();
    await Promise.all(
      this.store
        .queuedChannels()
        .map(channel =>
          (this.delivery.notice
            ? this.delivery.notice(channel, this.notices.offlineQueued)
            : this.delivery.send(channel, this.notices.offlineQueued)
          ).catch(error => this.log.warn('notify.failed', { channel, error })),
        ),
    );
    await this.drain();
  }
}

export const OFFLINE_QUEUED =
  'I am going offline for a moment (a restart or shutdown). Your message stays queued and I will answer it when I am back.';
export const OFFLINE_MID_REPLY =
  'I am going offline for a moment and was cut off mid-reply, so my last answer may be incomplete. Ask again when I am back if you need it.';
/** What a turn discarded through `/stop` records as its error. */
export const STOPPED_REASON = 'Stopped at the person’s request';
/** What the conversation hears in place of the answer. */
export const STOPPED_NOTICE = 'Stopped at your request.';
/** One short line for a failure notice; never the raw error object (it can carry provider detail or credentials). */
const shortReason = (error: unknown) => errorMessage(error).split('\n')[0]!.slice(0, 140);
/** The chat wording; a platform overrides what it must through `ChannelPlatform.notices`. */
const CHAT_NOTICES: EngineNotices = {
  failed: 'Something went wrong',
  stopped: STOPPED_NOTICE,
  notStarted: 'I could not reach my agent runtime just now. Please send that again in a moment.',
  offline:
    'I am going offline for a moment (a restart or shutdown) and could not finish this. Please send it again when I am back.',
  offlineMidReply: OFFLINE_MID_REPLY,
  offlineQueued: OFFLINE_QUEUED,
  blocked: 'I could not finish that. An operator has been notified; this conversation waits until it is resolved.',
};
