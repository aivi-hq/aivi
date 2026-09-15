import type { Config, Logger } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import { TurnNotStarted } from '@aivi/host';
import type { DiscordConfig } from './config.ts';
import type { DiscordStore, Turn } from './store.ts';

/** Split on code points so surrogate pairs survive; the limit counts UTF-16 units like Discord does. */
export function splitReply(text: string, limit = 1900): string[] {
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
export type Send = (channel: string, text: string) => Promise<void>;

/** Claims queued turns within shared capacity, asks the native session, and delivers replies. */
export class DiscordEngine {
  private readonly abort = new AbortController();
  private readonly active = new Map<string, Promise<void>>();
  private failure: unknown;
  private readonly log: Logger;
  private readonly store: DiscordStore;
  private readonly config: DiscordConfig;
  private readonly scheduler: Config['scheduler'];
  private readonly ask: Ask;
  private readonly send: Send;
  constructor(
    store: DiscordStore,
    config: DiscordConfig,
    scheduler: Config['scheduler'],
    ask: Ask,
    send: Send,
    log: Logger = silentLogger,
  ) {
    this.store = store;
    this.config = config;
    this.scheduler = scheduler;
    this.ask = ask;
    this.send = send;
    this.log = log.child({ component: 'discord' });
  }

  tick(): void {
    while (!this.abort.signal.aborted && this.active.size < this.config.maxConcurrent) {
      const turn = this.store.claim(this.scheduler, this.config.resource);
      if (!turn) break;
      this.launch(turn);
    }
  }

  private launch(turn: Turn): void {
    const log = this.log.child({ turn: turn.id, channel: turn.channel });
    const startedAt = Date.now();
    log.info('turn.started', { newSession: !turn.ready });
    const tell = (text: string) => this.send(turn.channel, text).catch(error => log.warn('notify.failed', { error }));
    const work = Promise.resolve()
      .then(async () => {
        try {
          const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.config.turnTimeoutMs)]);
          const text = await this.ask(turn, signal, () => this.store.ready(turn.channel));
          const answeredMs = Date.now() - startedAt;
          this.store.result(turn.id, text);
          for (const chunk of splitReply(text)) await this.send(turn.channel, chunk);
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
      })
      .finally(() => {
        this.active.delete(turn.id);
        this.tick(); // capacity was just released; do not wait for the next poll
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
