import { setTimeout } from 'node:timers/promises';
import type { Logger } from '@aivi/core';
import { getLogger } from '@aivi/core';
import type { RetryPolicy } from './modules.ts';
import type { OpenCodeClient } from './opencode.ts';

/** The shape every OpenCode event shares; session events carry `data.sessionID`. */
export interface SessionEvent {
  type: string;
  data?: { sessionID?: string } & Record<string, unknown>;
}
export type SessionEventListener = (event: SessionEvent) => void;
export interface SessionEvents {
  /** Receive this session's events until the returned function is called. */
  watch(sessionID: string, listener: SessionEventListener): () => void;
}

export const EVENTS_RETRY: RetryPolicy = { baseMs: 1000, maxMs: 30_000 };

/**
 * One `client.event.subscribe()` per host, fanned out by session id. The stream
 * is live-only (no replay) and does not reconnect on its own, so the loop
 * rediscovers the client and reconnects with backoff whenever it ends or
 * errors, until the host signal aborts. The first `watch` opens it; events for
 * sessions nobody watches are dropped. Connect and disconnect are logged once
 * per transition, never per event.
 */
export class EventStream implements SessionEvents {
  private readonly listeners = new Map<string, Set<SessionEventListener>>();
  private readonly opencode: () => Promise<OpenCodeClient>;
  private readonly signal: AbortSignal;
  private readonly log: Logger;
  private readonly retry: RetryPolicy;
  private running = false;
  private connected = false;
  /** Completed connections; tests use it to observe reconnection. */
  connections = 0;
  constructor(
    opencode: () => Promise<OpenCodeClient>,
    signal: AbortSignal,
    log: Logger = getLogger(['aivi']),
    retry: RetryPolicy = EVENTS_RETRY,
  ) {
    this.opencode = opencode;
    this.signal = signal;
    this.log = log.getChild('events');
    this.retry = retry;
  }

  watch(sessionID: string, listener: SessionEventListener): () => void {
    let set = this.listeners.get(sessionID);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionID, set);
    }
    set.add(listener);
    if (!this.running && !this.signal.aborted) {
      this.running = true;
      void this.run();
    }
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(sessionID);
    };
  }

  private async run(): Promise<void> {
    let delay = this.retry.baseMs;
    while (!this.signal.aborted) {
      let error: unknown;
      try {
        const client = await this.opencode();
        for await (const event of client.event.subscribe({ signal: this.signal })) {
          if (!this.connected) {
            this.connected = true;
            this.connections++;
            delay = this.retry.baseMs;
            this.log.info('events.connected');
          }
          this.dispatch(event as SessionEvent);
        }
      } catch (caught) {
        error = caught;
      }
      if (this.signal.aborted) break;
      if (this.connected) {
        this.connected = false;
        this.log.warn('events.disconnected', { error, retryMs: delay });
      } else {
        this.log.debug('events.connect.failed', { error, retryMs: delay });
      }
      await setTimeout(delay, undefined, { signal: this.signal }).catch(() => {});
      delay = Math.min(delay * 2, this.retry.maxMs);
    }
    this.running = false;
  }

  private dispatch(event: SessionEvent): void {
    const sessionID = event.data?.sessionID;
    if (typeof sessionID !== 'string') return;
    const set = this.listeners.get(sessionID);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn('events.listener.failed', { error });
      }
    }
  }
}
