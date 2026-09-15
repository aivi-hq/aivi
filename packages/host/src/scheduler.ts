import { randomUUID } from 'node:crypto';
import type { Config, Job, Logger } from '@aivi/core';
import { errorMessage, silentLogger } from '@aivi/core';
import type { Store } from './store.ts';

export interface ExecutionContext {
  signal: AbortSignal;
  attachSession(id: string): void;
}
export type ExecutionResult = { state: 'succeeded' | 'failed' | 'blocked'; result: unknown; reason?: string };
export type Execute = (job: Job, context: ExecutionContext) => Promise<ExecutionResult>;
/** Observes final states (including blocked-by-exception). Must not throw; used for reporting. */
export type OnFinished = (
  job: Job,
  state: 'succeeded' | 'failed' | 'blocked',
  result: unknown,
  reason: string,
) => Promise<void>;

/**
 * Claims due jobs from the store and runs them. The host drives `tick()` from
 * its own loop; the scheduler owns no timers and never acquires the daemon lock.
 */
export class Scheduler {
  readonly owner = randomUUID();
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private failure: unknown;
  private readonly store: Store;
  private readonly config: Config['scheduler'];
  private readonly execute: Execute;
  private readonly log: Logger;
  private readonly onFinished: OnFinished | undefined;

  constructor(
    store: Store,
    config: Config['scheduler'],
    execute: Execute,
    log: Logger = silentLogger,
    onFinished?: OnFinished,
  ) {
    this.store = store;
    this.config = config;
    this.execute = execute;
    this.log = log.child({ component: 'scheduler' });
    this.onFinished = onFinished;
  }

  tick(now = Date.now()): void {
    if (this.abort.signal.aborted) return;
    const created = this.store.materializeDue(now);
    if (created) this.log.debug('schedules.materialized', { created });
    while (true) {
      const job = this.store.claim(this.owner, this.config.maxConcurrent, this.config.resources, now);
      if (!job) break;
      this.launch(job);
    }
  }

  private launch(job: Job): void {
    const log = this.log.child({ job: job.id, kind: job.task.kind, resource: job.resource });
    log.info('job.started');
    const promise = Promise.resolve()
      .then(async () => {
        let outcome: ExecutionResult;
        try {
          outcome = await this.execute(job, {
            signal: this.abort.signal,
            attachSession: id => this.store.attachSession(job.id, this.owner, id),
          });
          log.info('job.finished', { state: outcome.state, reason: outcome.reason });
        } catch (error) {
          // A rejected Promise does not establish that external effects stopped.
          log.warn('job.blocked', { error });
          outcome = { state: 'blocked', result: null, reason: errorMessage(error) };
        }
        const reason = outcome.reason ?? 'completed';
        this.store.finish(job.id, this.owner, outcome.state, outcome.result, reason);
        if (this.onFinished)
          await this.onFinished(job, outcome.state, outcome.result, reason).catch(error =>
            log.warn('job.report.failed', { error }),
          );
      })
      .catch(error => {
        // Persistence itself failed: the store is unreliable, stop dispatching.
        this.log.error('scheduler.failed', { error });
        this.failure = error;
        this.stop();
      })
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, promise);
  }

  get activeCount(): number {
    return this.active.size;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active.values()]);
    if (this.failure !== undefined) throw this.failure;
  }

  stop(): void {
    this.abort.abort();
  }
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
}
