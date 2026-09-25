import { setTimeout } from 'node:timers/promises';
import type { Config, Job, Logger, ModuleHealth } from '@aivi/core';
import { errorMessage } from '@aivi/core';
import type { TaskRegistry } from './tasks.ts';
import type { ToolRegistry } from './tools.ts';

export interface RunningModule {
  stop(): Promise<void>;
}
export interface ModuleContract<Services = unknown> {
  id: string;
  start(services: Services): Promise<RunningModule>;
  /**
   * System jobs to seed beside the host's own while this module is composed.
   * They carry `invocation` tasks for operations the module claims in its
   * `start`; when the module leaves the composition, its jobs are removed
   * with it. Tuning their frequency from the operator's config is the
   * [minimal-schedule-config](../../docs/backlog/minimal-schedule-config.md)
   * slice, not built yet.
   */
  jobs?(config: Config): Job[];
}

/**
 * A module start that no retry can fix: a missing token, an id that does not
 * match. Modules throw this for what the operator must change; everything else
 * (a platform answering 503, a network blip) is retried.
 */
export class ConfigurationError extends Error {}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { baseMs: 1000, maxMs: 600_000 };

/**
 * Starts optional modules without letting one of them take the host down. A
 * module whose start fails is retried forever with exponential backoff
 * (1 s, 2 s, … capped at `maxMs`), reported as `degraded` in status meanwhile;
 * a `ConfigurationError` is fatal for the host. First attempts run in order;
 * readiness waits for them, never for retries.
 */
export class ModuleSupervisor<Services> {
  private readonly entries = new Map<
    string,
    { module: ModuleContract<Services>; health: ModuleHealth; running?: RunningModule }
  >();
  private readonly order: string[] = [];
  private readonly retries: Promise<void>[] = [];
  private readonly services: Services;
  private readonly signal: AbortSignal;
  private readonly log: Logger;
  private readonly fatal: (error: unknown) => void;
  private readonly retry: RetryPolicy;
  private readonly tasks?: TaskRegistry | undefined;
  private readonly tools?: ToolRegistry | undefined;
  constructor(
    services: Services,
    signal: AbortSignal,
    log: Logger,
    fatal: (error: unknown) => void,
    retry: RetryPolicy = DEFAULT_RETRY,
    tasks?: TaskRegistry | undefined,
    tools?: ToolRegistry | undefined,
  ) {
    this.services = services;
    this.signal = signal;
    this.log = log;
    this.fatal = fatal;
    this.retry = retry;
    this.tasks = tasks;
    this.tools = tools;
  }

  /**
   * The door for one module: everything shared, but `tasks` and `tools`
   * scoped so its claims carry the module's own id (the exactly-once rule
   * needs honest owners). The cast rewrites only those fields' shapes.
   */
  private servicesFor(moduleId: string): Services {
    if (!this.tasks && !this.tools) return this.services;
    const scoped = { ...this.services } as Record<string, unknown>;
    if (this.tasks) scoped.tasks = this.tasks.forModule(moduleId);
    if (this.tools) scoped.tools = this.tools.forModule(moduleId);
    return scoped as unknown as Services;
  }

  async start(modules: ModuleContract<Services>[]): Promise<void> {
    for (const module of modules) {
      if (this.entries.has(module.id)) throw new Error(`Module ${module.id} is registered twice`);
      this.entries.set(module.id, {
        module,
        health: { id: module.id, state: 'starting', attempts: 0, lastError: null, nextRetryAt: null },
      });
    }
    for (const module of modules) {
      this.signal.throwIfAborted();
      const ok = await this.attempt(module.id, error => {
        throw error;
      });
      if (!ok && !this.signal.aborted) this.retries.push(this.keepTrying(module.id));
    }
  }

  /** One start attempt; `onFatal` decides how a configuration error surfaces (thrown at startup, `fatal` on a retry). */
  private async attempt(id: string, onFatal: (error: unknown) => void = this.fatal): Promise<boolean> {
    const entry = this.entries.get(id)!;
    entry.health.attempts++;
    try {
      entry.running = await entry.module.start(this.servicesFor(entry.module.id));
      entry.health = { ...entry.health, state: 'running', lastError: null, nextRetryAt: null };
      this.order.push(id);
      this.log.info('module.started', { module: id, attempts: entry.health.attempts });
      return true;
    } catch (error) {
      if (error instanceof ConfigurationError || this.signal.aborted) {
        entry.health = { ...entry.health, state: 'stopped', lastError: errorMessage(error), nextRetryAt: null };
        onFatal(error);
        return false;
      }
      const delay = Math.min(this.retry.baseMs * 2 ** (entry.health.attempts - 1), this.retry.maxMs);
      entry.health = {
        ...entry.health,
        state: 'degraded',
        lastError: errorMessage(error),
        nextRetryAt: new Date(Date.now() + delay).toISOString(),
      };
      this.log.warn('module.start.failed', { module: id, attempt: entry.health.attempts, retryInMs: delay, error });
      return false;
    }
  }

  private async keepTrying(id: string): Promise<void> {
    while (!this.signal.aborted) {
      const entry = this.entries.get(id)!;
      const delay = Math.max(0, Date.parse(entry.health.nextRetryAt!) - Date.now());
      await setTimeout(delay, undefined, { signal: this.signal }).catch(() => {});
      if (this.signal.aborted) return;
      if (await this.attempt(id)) return;
    }
  }

  health(): ModuleHealth[] {
    return [...this.entries.values()].map(e => ({ ...e.health }));
  }

  /** Stop running modules in reverse start order; pending retries end with the host signal. */
  async stop(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const id of [...this.order].reverse()) {
      const entry = this.entries.get(id)!;
      try {
        await entry.running?.stop();
        entry.health = { ...entry.health, state: 'stopped' };
      } catch (error) {
        errors.push(error);
      }
    }
    await Promise.all(this.retries);
    return errors;
  }
}
