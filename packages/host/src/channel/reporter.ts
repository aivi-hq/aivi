import type { Logger } from '@aivi/core';
import type { ChannelDelivery } from '@aivi/plugin/channel';
import type { SessionEvents } from '@aivi/plugin/module';
import { ProgressPacer } from './pacer.ts';
import type { ProgressClock, ProgressMode } from './progress.ts';

export interface ProgressOptions {
  mode: ProgressMode;
  events: SessionEvents;
  /** At most one edit per window per placeholder: the first at once, the last after the quiet period. */
  throttleMs?: number;
  /** When the text changes without events (long-turn suffix, idle notice, elapsed refresh). */
  clock?: Partial<ProgressClock>;
}
export type Editable = ChannelDelivery & Required<Pick<ChannelDelivery, 'edit'>>;

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
  private readonly log: Logger;
  private readonly placeholder: Promise<string | undefined>;
  private readonly pacer: ProgressPacer;
  private inflight: Promise<void> = Promise.resolve();
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
    this.log = log;
    // The placeholder counts as an edit: the first change waits out the window.
    this.pacer = new ProgressPacer(options, text => this.edit(text), Date.now());
    this.placeholder = (delivery.placeholder ?? delivery.send)(conversation, this.pacer.text).catch(error => {
      log.warn('progress.placeholder.failed', { error });
      return undefined;
    });
    this.pacer.start(options.events, sessionId);
  }

  private edit(text: string): void {
    this.inflight = this.inflight
      .then(async () => {
        const id = await this.placeholder;
        if (id && !this.stopped) await this.delivery.edit(this.conversation, id, text);
      })
      .catch(error => this.log.warn('progress.edit.failed', { error }));
  }

  private async stop(): Promise<string | undefined> {
    this.stopped = true;
    this.pacer.stop();
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

  /** The turn ended without an answer: the placeholder becomes the notice, or the platform's notice replaces it. */
  async fail(text: string): Promise<void> {
    const id = await this.stop();
    if (this.delivery.notice) {
      await this.delivery.notice(this.conversation, text);
      return;
    }
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
