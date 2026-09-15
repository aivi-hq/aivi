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
  private readonly active = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private readonly warned = new Set<string>();
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
    for (const id of this.store.cancelRequested(this.owner)) {
      const entry = this.active.get(id);
      if (entry && !entry.abort.signal.aborted) {
        this.log.info('job.abort', { job: id });
        entry.abort.abort();
      }
    }
    for (const resource of this.store.queuedResources()) {
      if (resource in this.config.resources || this.warned.has(resource)) continue;
      this.warned.add(resource);
      this.log.warn('pool.unknown', {
        resource,
        hint: 'Queued jobs wait until this pool is configured or they are cancelled.',
      });
    }
    while (true) {
      const job = this.store.claim(this.owner, this.config.maxConcurrent, this.config.resources, now);
      if (!job) break;
      this.launch(job);
    }
  }

  private launch(job: Job): void {
    const log = this.log.child({ job: job.id, kind: job.task.kind, resource: job.resource });
    log.info('job.started');
    const own = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, own.signal]);
    const promise = Promise.resolve()
      .then(async () => {
        let outcome: ExecutionResult;
        try {
          outcome = await this.execute(job, {
            signal,
            attachSession: id => this.store.attachSession(job.id, this.owner, id),
          });
          log.info('job.finished', { state: outcome.state, reason: outcome.reason });
        } catch (error) {
          // A rejected Promise does not establish that external effects stopped.
          log.warn('job.blocked', { error });
          outcome = { state: 'blocked', result: null, reason: errorMessage(error) };
        }
        // An operator abort is the agent-first step of cleanup, not proof that the work stopped.
        if (own.signal.aborted && !this.abort.signal.aborted && outcome.state !== 'succeeded')
          outcome = { ...outcome, state: 'blocked', reason: `Aborted by operator. ${outcome.reason ?? ''}`.trim() };
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
    this.active.set(job.id, { promise, abort: own });
  }

  get activeCount(): number {
    return this.active.size;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active.values()].map(a => a.promise));
    if (this.failure !== undefined) throw this.failure;
  }

  stop(): void {
    this.abort.abort();
  }
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
}
