/**
 * The worker run's **progress stream**: while a run works, its OpenCode
 * session is mirrored into the agent session through the platform's
 * transient progress surface (`Platform.progress`) — Linear shows it as
 * ephemeral `thought` and `action` activities (ruled 2026-10-02: "thoughts
 * and action types, marked as ephemeral to prevent spamming"). The reducer,
 * the renderer and the pace are the host's own channel machinery
 * (`ProgressPacer`), so the worker's line and a chat placeholder say the
 * same thing in the same words.
 *
 * No polling and no interval: besides the throttle's trailing edge, the
 * only timer waits for the next instant the rendered line changes on its
 * own (the long-turn suffix, the idle notice, an elapsed refresh). The
 * follower pauses while a question awaits a person — nothing happens then —
 * and resumes when the answer lands.
 */

import type { Logger } from '@aivi/core';
import { type PacerOptions, type Progress, ProgressPacer } from '@aivi/host';
import type { SessionEvents } from '@aivi/plugin/module';
import type { Platform, TrackerProgressLine } from '@aivi/plugin/tracker';

export interface RunProgressOptions extends PacerOptions {
  /** `status` shows the one line; `tools` lets a running tool speak as an `action`. */
  mode: 'status' | 'tools';
  events: SessionEvents;
  log: Logger;
}

export class RunProgress {
  private readonly platform: Platform;
  private readonly conversation: string;
  private readonly sessionId: string;
  private readonly mode: 'status' | 'tools';
  private readonly events: SessionEvents;
  private readonly log: Logger;
  private readonly pacer: ProgressPacer;
  private inflight: Promise<void> = Promise.resolve();

  constructor(platform: Platform, conversation: string, sessionId: string, options: RunProgressOptions) {
    this.platform = platform;
    this.conversation = conversation;
    this.sessionId = sessionId;
    this.mode = options.mode;
    this.events = options.events;
    this.log = options.log;
    this.pacer = new ProgressPacer(options, (text, state) => this.post(text, state));
  }

  /** Follow the session: watch and arm. Idempotent; a stopped follower
   *  resumes with its history — the elapsed line keeps counting, because
   *  the worker did. */
  start(): void {
    if (!this.platform.progress) return;
    this.pacer.start(this.events, this.sessionId);
  }

  /** Say nothing more: unwatch, disarm, let the in-flight activity land. */
  async stop(): Promise<void> {
    this.pacer.stop();
    await this.inflight;
  }

  /** One activity per visible change. A running tool is offered as a tool;
   *  a `status`-mode follower keeps it inside the line. */
  private post(text: string, state: Progress): void {
    const running = this.mode === 'tools' ? state.tools.findLast(t => t.state === 'running' && !t.pending) : undefined;
    const head = text.split('\n')[0]!;
    const line: TrackerProgressLine = {
      text: head,
      ...(running ? { tool: { name: running.name, ...(running.detail ? { detail: running.detail } : {}) } } : {}),
    };
    this.inflight = this.inflight
      .then(async () => {
        if (this.pacer.running) await this.platform.progress?.(this.conversation, line);
      })
      .catch(error => this.log.warn('progress.activity.failed', { error }));
  }
}
