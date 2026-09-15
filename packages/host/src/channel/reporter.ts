import type { Logger } from '@aivi/core';
import type { SessionEvents } from '../events.ts';
import type { ChannelDelivery } from './contract.ts';
import {
  DEFAULT_CLOCK,
  nextRenderChange,
  type Progress,
  type ProgressClock,
  type ProgressMode,
  reduceProgress,
  renderProgress,
  startProgress,
} from './progress.ts';

export interface ProgressOptions {
  mode: ProgressMode;
  events: SessionEvents;
  /** At most one edit per window per placeholder: the first at once, the last after the quiet period. */
  throttleMs?: number;
  /** When the text changes without events (long-turn suffix, idle notice, elapsed refresh). */
  clock?: Partial<ProgressClock>;
}
type Editable = ChannelDelivery & Required<Pick<ChannelDelivery, 'edit'>>;

/**
 * One placeholder message per turn: posted when work starts, edited in place as
 * events arrive (coalesced), and replaced by the reply or turned into the
 * failure notice. The conversation ends with the answer only, never a flood.
 * No polling: besides the throttle's trailing edge, the only timer waits for
 * the next instant the text would change on its own.
 */
export class ProgressReporter {
  private readonly delivery: Editable;
  private readonly conversation: string;
  private readonly mode: 'status' | 'tools';
  private readonly log: Logger;
  private readonly throttleMs: number;
  private readonly clock: ProgressClock;
  private readonly placeholder: Promise<string | undefined>;
  private readonly unwatch: () => void;
  private trailing: NodeJS.Timeout | undefined;
  private change: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private state: Progress;
  private shown: string;
  private lastEditAt: number;
  private stopped = false;

  constructor(
    delivery: Editable,
    conversation: string,
    sessionId: string,
    options: ProgressOptions & { mode: 'status' | 'tools' },
    log: Logger,
  ) {
    this.delivery = delivery;
    this.conversation = conversation;
    this.mode = options.mode;
    this.log = log;
    this.throttleMs = options.throttleMs ?? 2000;
    this.clock = { ...DEFAULT_CLOCK, ...options.clock };
    const now = Date.now();
    this.state = startProgress(now);
    this.shown = renderProgress(this.state, this.mode, now, this.clock);
    this.lastEditAt = now;
    this.placeholder = delivery.send(conversation, this.shown).catch(error => {
      log.warn('progress.placeholder.failed', { error });
      return undefined;
    });
    this.unwatch = options.events.watch(sessionId, event => {
      this.state = reduceProgress(this.state, event, Date.now());
      this.schedule();
    });
    this.arm();
  }

  /** Wait for the next instant the text changes by itself (the suffix, the idle notice, an elapsed refresh). */
  private arm(): void {
    clearTimeout(this.change);
    if (this.stopped) return;
    const now = Date.now();
    const at = nextRenderChange(this.state, now, this.clock);
    this.change = setTimeout(() => this.schedule(), Math.max(0, at - now)).unref();
  }

  private schedule(): void {
    if (this.stopped || this.trailing) return;
    const wait = this.lastEditAt + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.trailing = setTimeout(() => {
      this.trailing = undefined;
      this.flush();
    }, wait).unref();
  }

  private flush(): void {
    if (this.stopped) return;
    this.arm();
    const text = renderProgress(this.state, this.mode, Date.now(), this.clock);
    if (text === this.shown) return;
    this.shown = text;
    this.lastEditAt = Date.now();
    this.inflight = this.inflight
      .then(async () => {
        const id = await this.placeholder;
        if (id && !this.stopped) await this.delivery.edit(this.conversation, id, text);
      })
      .catch(error => this.log.warn('progress.edit.failed', { error }));
  }

  private async stop(): Promise<string | undefined> {
    this.stopped = true;
    this.unwatch();
    clearTimeout(this.trailing);
    clearTimeout(this.change);
    await this.inflight;
    return this.placeholder;
  }

  /** The answer is ready: post it and drop the placeholder, or edit the placeholder into its first chunk. */
  async finish(chunks: string[]): Promise<void> {
    const id = await this.stop();
    if (id && !this.delivery.delete) {
      const [first, ...rest] = chunks;
      await this.delivery.edit(this.conversation, id, first!);
      for (const chunk of rest) await this.delivery.send(this.conversation, chunk);
      return;
    }
    for (const chunk of chunks) await this.delivery.send(this.conversation, chunk);
    if (id)
      await this.delivery.delete!(this.conversation, id).catch(error =>
        this.log.warn('progress.delete.failed', { error }),
      );
  }

  /** The turn ended without an answer: the placeholder becomes the notice. */
  async fail(text: string): Promise<void> {
    const id = await this.stop();
    if (id) {
      try {
        await this.delivery.edit(this.conversation, id, text);
        return;
      } catch (error) {
        this.log.warn('progress.edit.failed', { error });
      }
    }
    await this.delivery.send(this.conversation, text);
  }
}
