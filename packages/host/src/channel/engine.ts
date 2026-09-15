import type { Config, Logger } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import { TurnNotStarted } from '../session.ts';
import type { ChannelDelivery } from './contract.ts';
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
  private readonly active = new Map<string, Promise<void>>();
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
    this.log = (options.log ?? silentLogger).child({ component: store.platform.id });
    this.onRelease = options.onRelease ?? (() => {});
    this.onFailure = options.onFailure ?? (() => {});
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
    const log = this.log.child({ turn: turn.id, channel: turn.channel });
    const startedAt = Date.now();
    log.info('turn.started', { newSession: !turn.ready });
    const reporter = this.reporter(turn, log);
    const tell = (text: string) =>
      (reporter ? reporter.fail(text) : this.delivery.send(turn.channel, text)).catch(error =>
        log.warn('notify.failed', { error }),
      );
    const work = Promise.resolve()
      .then(async () => {
        try {
          const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.limits.turnTimeoutMs)]);
          const text = await this.ask(turn, signal, () => this.store.ready(turn.channel));
          const answeredMs = Date.now() - startedAt;
          this.store.result(turn.id, text);
          const chunks = splitReply(text, this.store.platform.replyLimit);
          if (reporter) await reporter.finish(chunks);
          else for (const chunk of chunks) await this.delivery.send(turn.channel, chunk);
          this.store.sent(turn.id);
          log.info('turn.sent', { answeredMs, totalMs: Date.now() - startedAt, chars: text.length });
        } catch (error) {
          if (error instanceof TurnNotStarted) {
            // Nothing reached the agent: release capacity and let the person try again.
            log.warn('turn.not_started', { error });
            this.store.fail(turn.id);
            await tell('I could not reach my agent runtime just now. Please send that again in a moment.');
            return;
          }
          // No automatic resend: delivery may already have succeeded before a response was lost.
          log.warn('turn.blocked', { error });
          this.store.block(turn.id);
          await tell(
            'I could not finish that. An operator has been notified; this conversation waits until it is resolved.',
          );
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
    this.active.set(turn.id, work);
  }

  stop(): void {
    this.abort.abort();
  }
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
  async drain(): Promise<void> {
    await Promise.all([...this.active.values()]);
    if (this.failure !== undefined) throw this.failure;
  }
}
