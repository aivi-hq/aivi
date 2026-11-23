import type { SessionEvents } from '@aivi/plugin/module';
import {
  DEFAULT_CLOCK,
  nextRenderChange,
  type Progress,
  type ProgressClock,
  reduceProgress,
  renderProgress,
  startProgress,
} from './progress.ts';

export interface PacerOptions {
  mode: 'status' | 'tools';
  /** At most one delivery per window: the first at once, later ones coalesced after the quiet period. */
  throttleMs?: number;
  /** When the text changes without events (long-turn suffix, idle notice, elapsed refresh). */
  clock?: Partial<ProgressClock>;
}

/**
 * The pace of one session's visible progress, shared by every follower that
 * shows it — a chat placeholder, a ticket's status line. It owns the reducer's
 * state, the renderer's text, the throttle with its trailing edge, and the one
 * timer that waits for the next instant the text changes by itself: no
 * polling. What a change *is* — an edit, an activity — is the follower's: it
 * hears each new text once, with the state the text was rendered from. A
 * stopped pacer keeps its history, and `start` resumes with it — the elapsed
 * line keeps counting, because the worker did.
 */
export class ProgressPacer {
  private readonly mode: 'status' | 'tools';
  private readonly throttleMs: number;
  private readonly clock: ProgressClock;
  private readonly deliver: (text: string, state: Progress) => void;
  private state: Progress;
  private shown: string;
  private lastDeliveredAt: number;
  private unwatch: (() => void) | undefined;
  private trailing: NodeJS.Timeout | undefined;
  private change: NodeJS.Timeout | undefined;
  private active = false;

  /** `lastDeliveredAt` is when the follower last showed something: a follower that already showed the text at
   *  `shown` (a placeholder just posted) makes the first change wait out the window; the default shows it at once. */
  constructor(options: PacerOptions, deliver: (text: string, state: Progress) => void, lastDeliveredAt = 0) {
    this.mode = options.mode;
    this.throttleMs = options.throttleMs ?? 2_000;
    this.clock = { ...DEFAULT_CLOCK, ...options.clock };
    this.deliver = deliver;
    const now = Date.now();
    this.state = startProgress(now);
    this.shown = renderProgress(this.state, this.mode, now, this.clock);
    this.lastDeliveredAt = lastDeliveredAt;
  }

  /** The text as last rendered: what a follower shows first. */
  get text(): string {
    return this.shown;
  }

  /** Whether the session is being watched now. */
  get running(): boolean {
    return this.active;
  }

  /** Follow the session: watch and arm. Idempotent. */
  start(events: SessionEvents, sessionId: string): void {
    if (this.active) return;
    this.active = true;
    this.unwatch = events.watch(sessionId, event => {
      this.state = reduceProgress(this.state, event, Date.now());
      this.schedule();
    });
    this.arm();
  }

  /** Say nothing more: unwatch and disarm. */
  stop(): void {
    this.active = false;
    this.unwatch?.();
    this.unwatch = undefined;
    clearTimeout(this.trailing);
    this.trailing = undefined;
    clearTimeout(this.change);
    this.change = undefined;
  }

  /** Wait for the next instant the text changes by itself. */
  private arm(): void {
    clearTimeout(this.change);
    const now = Date.now();
    const at = nextRenderChange(this.state, now, this.clock);
    this.change = setTimeout(() => this.schedule(), Math.max(0, at - now)).unref();
  }

  private schedule(): void {
    if (!this.active || this.trailing) return;
    const wait = this.lastDeliveredAt + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.trailing = setTimeout(() => {
      this.trailing = undefined;
      this.flush();
    }, wait).unref();
  }

  /** One delivery per visible change — and only when the text actually changed, so each moment is said once. */
  private flush(): void {
    this.arm();
    const now = Date.now();
    const text = renderProgress(this.state, this.mode, now, this.clock);
    if (text === this.shown) return;
    this.shown = text;
    this.lastDeliveredAt = now;
    this.deliver(text, this.state);
  }
}
