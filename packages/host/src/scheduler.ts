import { randomUUID } from 'node:crypto';
import type { Config, ExecutionContext, ExecutionResult, Logger, Run, Task } from '@aivi/core';
import { errorMessage, getLogger, taskLabel } from '@aivi/core';
import type { Dispatcher } from './dispatcher/dispatcher.ts';
import type { DispatcherLease } from './dispatcher/leases.ts';
import type { Store } from './store.ts';

/** Runs one run; the run carries its task snapshot. */
export type Execute = (run: Run, context: ExecutionContext) => Promise<ExecutionResult>;
/** Observes final states (including blocked-by-exception and missed occurrences). Must not throw; used for reporting. */
export type OnFinished = (
  run: Run,
  state: 'succeeded' | 'failed' | 'blocked' | 'missed',
  result: unknown,
  reason: string,
) => Promise<void>;
/** Whether one run's task speaks to a model: work that does asks the dispatcher for a slot first. */
export type NeedsCapacity = (task: Task) => boolean;

/** The dispatcher's callback namespace for job work. */
const SERVICE = 'jobs';

/**
 * Materializes due job occurrences, claims runs from the store and executes
 * them. The host drives `tick()` from its own loop; the scheduler owns no
 * timers and never acquires the daemon lock.
 *
 * Capacity is the dispatcher's to decide: work that calls a model asks for a
 * lease (pool = the run's resource) and waits on the dispatcher's queue when
 * the pool is full — one queue place per pool, so a tick asks each full pool
 * at most once and the grant callback brings the next run. Scripts and
 * system checks call no model and run straight from the queue. A tick is
 * never re-entered: a callback that lands mid-tick sets "wanted again" and
 * one more pass follows it, so the maps below are only ever walked by one
 * pass at a time.
 */
export class Scheduler {
  readonly owner = randomUUID();
  private readonly active = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private readonly warned = new Set<string>();
  private readonly abort = new AbortController();
  private failure: unknown;
  private readonly store: Store;
  private readonly config: Config['scheduler'];
  private readonly dispatcher: Dispatcher;
  private readonly needsCapacity: NeedsCapacity;
  private readonly execute: Execute;
  private readonly log: Logger;
  private readonly onFinished: OnFinished | undefined;
  /** Requests the dispatcher took: request id → the run waiting behind it. */
  private readonly requested = new Map<string, { runId: string; pool: string }>();
  /** Runs waiting behind a request, so the claim pass never asks twice. */
  private readonly waitingRuns = new Set<string>();
  /** Grants the callback delivered but no claim pass has collected yet. */
  private readonly grants = new Map<string, DispatcherLease>();
  /** Pools whose queue place the jobs service holds this pass. */
  private readonly poolsWaiting = new Set<string>();
  private ticking = false;
  private wantedAgain = false;

  constructor(
    store: Store,
    config: Config['scheduler'],
    dispatcher: Dispatcher,
    needsCapacity: NeedsCapacity,
    execute: Execute,
    log: Logger = getLogger(['aivi']),
    onFinished?: OnFinished,
  ) {
    this.store = store;
    this.config = config;
    this.dispatcher = dispatcher;
    this.needsCapacity = needsCapacity;
    this.execute = execute;
    this.log = log.getChild('scheduler');
    this.onFinished = onFinished;
    dispatcher.registerCallback(SERVICE, (requestId, lease) => {
      this.grants.set(requestId, lease);
      this.tick();
    });
  }

  tick(now = Date.now()): void {
    if (this.ticking) {
      this.wantedAgain = true;
      return;
    }
    this.ticking = true;
    try {
      this.due(now);
      this.collectGrants(now);
      this.dispatchQueued(now);
    } finally {
      this.ticking = false;
    }
    if (this.wantedAgain) {
      this.wantedAgain = false;
      this.tick(now);
    }
  }

  /** Occurrences that came due, missed ones reported, and operator aborts delivered. */
  private due(now: number): void {
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
  }

  /** Runs whose lease landed while the queue was elsewhere: claim and launch. */
  private collectGrants(now: number): void {
    for (const [requestId, lease] of [...this.grants]) {
      this.grants.delete(requestId);
      const waiting = this.requested.get(requestId);
      this.requested.delete(requestId);
      if (waiting) {
        this.waitingRuns.delete(waiting.runId);
        this.poolsWaiting.delete(waiting.pool);
      }
      if (this.abort.signal.aborted) {
        void this.release(lease.id); // stopped: nobody left to hand the slot to
        continue;
      }
      const run = waiting ? this.store.claimRun(waiting.runId, this.owner, now) : null;
      if (!run) {
        void this.release(lease.id); // the run was cancelled or claimed elsewhere: pay the slot back
        continue;
      }
      this.launch(run, lease);
    }
  }

  /** The claim pass: lease-free work runs at once; model work asks the dispatcher per pool. */
  private dispatchQueued(now: number): void {
    if (this.abort.signal.aborted) return;
    for (const candidate of this.store.queuedRuns(now)) {
      if (this.waitingRuns.has(candidate.id)) continue; // a grant may already be on its way
      if (!this.needsCapacity(candidate.task)) {
        const run = this.store.claimRun(candidate.id, this.owner, now);
        if (run) this.launch(run);
        continue;
      }
      if (this.poolsWaiting.has(candidate.resource)) continue; // one queue place per pool; the callback wakes the rest
      let grant: ReturnType<Dispatcher['request']>;
      try {
        grant = this.dispatcher.request({ service: SERVICE, pool: candidate.resource });
      } catch (error) {
        if (!this.warned.has(candidate.resource)) {
          this.warned.add(candidate.resource);
          this.log.warn('pool.unknown', {
            resource: candidate.resource,
            hint: 'Queued runs wait until this pool is configured or they are cancelled.',
            error: errorMessage(error),
          });
        }
        continue;
      }
      if ('lease' in grant) {
        const run = this.store.claimRun(candidate.id, this.owner, now);
        if (!run) {
          void this.release(grant.lease.id);
          continue;
        }
        this.launch(run, grant.lease);
      } else if ('queued' in grant) {
        this.requested.set(grant.queued, { runId: candidate.id, pool: candidate.resource });
        this.waitingRuns.add(candidate.id);
        this.poolsWaiting.add(candidate.resource);
      } else if (grant.refused === 'pool-gone') {
        if (!this.warned.has(grant.pool)) {
          this.warned.add(grant.pool);
          this.log.warn('pool.gone', {
            resource: grant.pool,
            hint: 'Queued runs wait until this pool is configured again or they are cancelled.',
          });
        }
      } else {
        // `waiting` means the place is held and a grant is coming; `full` means no
        // callback — registering in the constructor is what makes a pool waitable.
        this.poolsWaiting.add(grant.pool);
      }
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

  private launch(run: Run, lease?: DispatcherLease): void {
    const log = this.log.with({ run: run.id, job: run.jobId, kind: taskLabel(run.task), resource: run.resource });
    log.info('run.started', lease ? { lease: lease.id, pool: lease.pool } : {});
    const own = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, own.signal]);
    const promise = Promise.resolve()
      .then(async () => {
        let outcome: ExecutionResult;
        try {
          const context: ExecutionContext = {
            signal,
            attachSession: id => this.store.attachSession(run.id, this.owner, id),
            ...(lease
              ? {
                  lease: {
                    id: lease.id,
                    provide: (work: {
                      agent: string;
                      directory: string;
                      sessionId?: string;
                      create?: boolean;
                      title?: string;
                      metadata?: Record<string, unknown>;
                    }) => this.dispatcher.provide(lease.id, work),
                  },
                }
              : {}),
          };
          outcome = await this.execute(run, context);
          log.info('run.finished', { state: outcome.state, reason: outcome.reason ?? 'completed' });
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
        if (lease && outcome.state !== 'blocked') await this.release(lease.id);
        else if (lease)
          log.warn('lease.held', {
            lease: lease.id,
            hint: 'A blocked run keeps its slot; the dispatcher monitor reclaims it when the session proves silent.',
          });
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

  /** Pay a slot back; an unconfirmed kill keeps it held — the monitor is still watching. */
  private async release(leaseId: string): Promise<void> {
    try {
      const outcome = await this.dispatcher.release(leaseId);
      if ('pending' in outcome)
        this.log.warn('lease.expire.pending', { lease: leaseId, hint: 'the dispatcher keeps trying to confirm' });
    } catch (error) {
      this.log.warn('lease.release.failed', { lease: leaseId, error });
    }
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
    // Queue places are the dispatcher's memory; give ours back so a restarting
    // host's fresh requests are not refused by ghosts of this one.
    for (const requestId of this.requested.keys()) this.dispatcher.cancel(requestId);
  }
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
}
