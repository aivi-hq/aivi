import { randomUUID } from 'node:crypto';
import type { Config, Logger, Run } from '@aivi/core';
import { errorMessage, silentLogger } from '@aivi/core';
import type { Store } from './store.ts';

export interface ExecutionContext {
  signal: AbortSignal;
  attachSession(id: string): void;
}
export type ExecutionResult = { state: 'succeeded' | 'failed' | 'blocked'; result: unknown; reason?: string };
/** Runs one run; the run carries its task snapshot. */
export type Execute = (run: Run, context: ExecutionContext) => Promise<ExecutionResult>;
/** Observes final states (including blocked-by-exception and missed occurrences). Must not throw; used for reporting. */
export type OnFinished = (
  run: Run,
  state: 'succeeded' | 'failed' | 'blocked' | 'missed',
  result: unknown,
  reason: string,
) => Promise<void>;

/**
 * Materializes due job occurrences, claims runs from the store and executes
 * them. The host drives `tick()` from its own loop; the scheduler owns no
 * timers and never acquires the daemon lock.
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
    const { created, missed } = this.store.materializeDue(now, this.config.misfire.graceSeconds * 1000);
    if (created) this.log.debug('jobs.materialized', { created });
    for (const run of missed) {
      this.log.warn('run.missed', {
        run: run.id,
        job: run.jobId,
        scheduledFor: new Date(run.scheduledFor).toISOString(),
      });
      this.report(run, 'missed', null, run.error ?? 'missed');
    }
    for (const id of this.store.cancelRequested(this.owner)) {
      const entry = this.active.get(id);
      if (entry && !entry.abort.signal.aborted) {
        this.log.info('run.abort', { run: id });
        entry.abort.abort();
      }
    }
    for (const resource of this.store.queuedResources()) {
      if (resource in this.config.resources || this.warned.has(resource)) continue;
      this.warned.add(resource);
      this.log.warn('pool.unknown', {
        resource,
        hint: 'Queued runs wait until this pool is configured or they are cancelled.',
      });
    }
    while (true) {
      const run = this.store.claim(this.owner, this.config.maxConcurrent, this.config.resources, now);
      if (!run) break;
      this.launch(run);
    }
  }

  /** A missed occurrence is reported like a failure; nothing runs, so it is tracked only for `drain`. */
  private report(run: Run, state: 'missed', result: unknown, reason: string): void {
    if (!this.onFinished) return;
    const promise = this.onFinished(run, state, result, reason)
      .catch(error => this.log.warn('run.report.failed', { run: run.id, error }))
      .finally(() => this.active.delete(`report:${run.id}`));
    this.active.set(`report:${run.id}`, { promise, abort: new AbortController() });
  }

  private launch(run: Run): void {
    const log = this.log.child({ run: run.id, job: run.jobId, kind: run.task.kind, resource: run.resource });
    log.info('run.started');
    const own = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, own.signal]);
    const promise = Promise.resolve()
      .then(async () => {
        let outcome: ExecutionResult;
        try {
          outcome = await this.execute(run, {
            signal,
            attachSession: id => this.store.attachSession(run.id, this.owner, id),
          });
          log.info('run.finished', { state: outcome.state, reason: outcome.reason });
        } catch (error) {
          // A rejected Promise does not establish that external effects stopped.
          log.warn('run.blocked', { error });
          outcome = { state: 'blocked', result: null, reason: errorMessage(error) };
        }
        // An operator abort is the agent-first step of cleanup, not proof that the work stopped.
        if (own.signal.aborted && !this.abort.signal.aborted && outcome.state !== 'succeeded')
          outcome = { ...outcome, state: 'blocked', reason: `Aborted by operator. ${outcome.reason ?? ''}`.trim() };
        const reason = outcome.reason ?? 'completed';
        this.store.finish(run.id, this.owner, outcome.state, outcome.result, reason);
        if (this.onFinished)
          await this.onFinished(run, outcome.state, outcome.result, reason).catch(error =>
            log.warn('run.report.failed', { error }),
          );
      })
      .catch(error => {
        // Persistence itself failed: the store is unreliable, stop dispatching.
        this.log.error('scheduler.failed', { error });
        this.failure = error;
        this.stop();
      })
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { promise, abort: own });
  }

  get activeCount(): number {
    return [...this.active.keys()].filter(k => !k.startsWith('report:')).length;
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
