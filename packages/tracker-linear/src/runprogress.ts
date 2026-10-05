/**
 * The worker run's **progress stream**: while a run works, its OpenCode
 * session is mirrored into the agent session through the platform's
 * transient progress surface (`Platform.progress`) — Linear shows it as
 * ephemeral `thought` and `action` activities (ruled 2026-10-02: "thoughts
 * and action types, marked as ephemeral to prevent spamming"). The reducer
 * and the renderer are the host's own channel machinery, so the worker's
 * line and a chat placeholder say the same thing in the same words.
 *
 * No polling and no interval: besides the throttle's trailing edge, the
 * only timer waits for the next instant the rendered line changes on its
 * own (the long-turn suffix, the idle notice, an elapsed refresh). The
 * follower pauses while a question awaits a person — nothing happens then —
 * and resumes when the answer lands.
 */

import type { Logger } from '@aivi/core';
import {
  DEFAULT_CLOCK,
  nextRenderChange,
  type Progress,
  type ProgressClock,
  reduceProgress,
  renderProgress,
  startProgress,
} from '@aivi/host';
import type { SessionEvents } from '@aivi/plugin/module';
import type { Platform, TrackerProgressLine } from '@aivi/plugin/tracker';

export interface RunProgressOptions {
  /** `status` shows the one line; `tools` lets a running tool speak as an `action`. */
  mode: 'status' | 'tools';
  events: SessionEvents;
  log: Logger;
  /** At most one activity per window: the first at once, later ones coalesced. */
  throttleMs?: number;
  clock?: Partial<ProgressClock>;
}

export class RunProgress {
  private readonly platform: Platform;
  private readonly conversation: string;
  private readonly sessionId: string;
  private readonly mode: 'status' | 'tools';
  private readonly events: SessionEvents;
  private readonly log: Logger;
  private readonly throttleMs: number;
  private readonly clock: ProgressClock;
  private state: Progress;
  private shown: string;
  private lastPostAt: number;
  private unwatch: (() => void) | undefined;
  private trailing: NodeJS.Timeout | undefined;
  private change: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private following = false;

  constructor(platform: Platform, conversation: string, sessionId: string, options: RunProgressOptions) {
    this.platform = platform;
    this.conversation = conversation;
    this.sessionId = sessionId;
    this.mode = options.mode;
    this.events = options.events;
    this.log = options.log;
    this.throttleMs = options.throttleMs ?? 2_000;
    this.clock = { ...DEFAULT_CLOCK, ...options.clock };
    const now = Date.now();
    this.state = startProgress(now);
    this.shown = renderProgress(this.state, this.mode, now, this.clock);
    this.lastPostAt = 0;
  }

  /** Follow the session: watch and arm. Idempotent; a stopped follower
   *  resumes with its history — the elapsed line keeps counting, because
   *  the worker did. */
  start(): void {
    if (this.following || !this.platform.progress) return;
    this.following = true;
    this.unwatch = this.events.watch(this.sessionId, event => {
      this.state = reduceProgress(this.state, event, Date.now());
      this.schedule();
    });
    this.arm();
  }

  /** Say nothing more: unwatch, disarm, let the in-flight activity land. */
  async stop(): Promise<void> {
    this.following = false;
    this.unwatch?.();
    this.unwatch = undefined;
    clearTimeout(this.trailing);
    this.trailing = undefined;
    clearTimeout(this.change);
    this.change = undefined;
    await this.inflight;
  }

  /** Wait for the next instant the line changes by itself. */
  private arm(): void {
    clearTimeout(this.change);
    if (!this.following) return;
    const now = Date.now();
    const at = nextRenderChange(this.state, now, this.clock);
    this.change = setTimeout(() => this.schedule(), Math.max(0, at - now)).unref();
  }

  private schedule(): void {
    if (!this.following || this.trailing) return;
    const wait = this.lastPostAt + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.trailing = setTimeout(() => {
      this.trailing = undefined;
      this.flush();
    }, wait).unref();
  }

  /** One activity per visible change — and only when the text actually
   *  changed, so the stream says each moment once. A running tool is
   *  offered as a tool; a `status`-mode follower keeps it inside the line. */
  private flush(): void {
    if (!this.following) return;
    this.arm();
    const now = Date.now();
    const text = renderProgress(this.state, this.mode, now, this.clock);
    if (text === this.shown) return;
    this.shown = text;
    this.lastPostAt = now;
    const running =
      this.mode === 'tools' ? this.state.tools.findLast(t => t.state === 'running' && !t.pending) : undefined;
    const head = text.split('\n')[0]!;
    const line: TrackerProgressLine = {
      text: head,
      ...(running ? { tool: { name: running.name, ...(running.detail ? { detail: running.detail } : {}) } } : {}),
    };
    this.inflight = this.inflight
      .then(async () => {
        if (this.following) await this.platform.progress?.(this.conversation, line);
      })
      .catch(error => this.log.warn('progress.activity.failed', { error }));
  }
}
