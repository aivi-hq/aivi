import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { BrowserService, KnowledgeService, LoadedConfig, Logger } from '@aivi/core';
import { getLogger, systemJobs } from '@aivi/core';
import { describeSession } from './channel/context.ts';
import { Channels } from './channel/router.ts';
import { EventStream, type SessionEvents } from './events.ts';
import { createJobHandler } from './jobs.ts';
import {
  ConfigurationError,
  type HostModule as ModuleContract,
  ModuleSupervisor,
  type RetryPolicy,
} from './modules.ts';
import { connectOpenCode, type OpenCodeClient, restartOpenCode } from './opencode.ts';
import { describeOutcome, reentryPrompt, reportTarget, shouldReport } from './reports.ts';
import { createExecutor } from './runtime.ts';
import { Scheduler } from './scheduler.ts';
import { createHostServer, PublicRoutes } from './server.ts';
import type { Store } from './store.ts';
import type { TaskClaims } from './tasks.ts';
import { TaskRegistry } from './tasks.ts';

/** Consecutive failed runs of a recurring job before its failure report asks for a look. */
const FAILURE_NUDGE_AT = 3;

/**
 * Lets the host loop sleep until the next due instant and be woken early when
 * the queue changes (a tool created a job, the CLI poked `/v1/wake`). A notify
 * that arrives between two waits is not lost: the next wait returns at once.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class Wake {
  private controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  notify(): void {
    this.controller.abort();
    for (const listener of this.listeners) listener();
  }
  /** Also tell channel engines: capacity a job held may be free for their queued turns. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Sleep until `until` (an instant; null = only a wake or the host signal ends the sleep). */
  async wait(until: number | null, signal: AbortSignal): Promise<void> {
    const current = this.controller;
    const combined = AbortSignal.any([signal, current.signal]);
    // Node timers cap at 2^31-1 ms; a due instant further out re-arms when this one expires.
    const ms = until === null ? MAX_TIMER_MS : Math.min(MAX_TIMER_MS, Math.max(0, until - Date.now()));
    await setTimeout(ms, undefined, { signal: combined }).catch(() => {});
    if (current.signal.aborted) this.controller = new AbortController();
  }
}

export interface HostServices {
  loaded: LoadedConfig;
  store: Store;
  knowledge: KnowledgeService;
  browser?: BrowserService;
  /** Discovers the OpenCode service on every call. Call once per unit of work and hold the client for its duration. */
  opencode: () => Promise<OpenCodeClient>;
  /** The host's one OpenCode event stream, fanned out by session id; channel progress watches turns through it. */
  events: SessionEvents;
  signal: AbortSignal;
  log: Logger;
  /** Chat platform modules register here once; that makes them report destinations and session owners. */
  channels: Channels;
  /** Webhook routes a module exposes on the host listener, outside bearer auth; the platform's signature is the auth. */
  routes: PublicRoutes;
  /** What `kind: 'invocation'` tasks dispatch to: the host claims its own operations here, modules claim theirs. */
  tasks: TaskClaims;
  /** Tell the scheduler and every channel engine that the queue or capacity changed; dispatch now. */
  wake(): void;
  /** Be told the same; a channel engine ticks on it instead of polling for capacity released elsewhere. */
  onWake(listener: () => void): () => void;
  /** Abort the whole host. Only for failures the module cannot recover from. */
  fail(error: unknown): void;
}
export interface HostResources {
  knowledge: KnowledgeService;
  browser?: BrowserService;
}
export type { RunningModule } from './modules.ts';
export type HostModule = ModuleContract<HostServices>;

export interface RunHostOptions {
  loaded: LoadedConfig;
  store: Store;
  resources: () => Promise<HostResources>;
  modules?: HostModule[];
  signal: AbortSignal;
  /** Environment variable names shell tasks must not inherit (the keys of `<home>/.env`); aivi's fixed secrets are always hidden. */
  protectedEnv?: Iterable<string>;
  log?: Logger;
  /** Backoff for module starts that fail; the default climbs from 1 s to 10 min. */
  moduleRetry?: RetryPolicy;
  onReady?: (address: unknown) => void;
}

/** Composition and ownership only: no service locator, decorators, or plugin registry. */
export async function runHost(options: RunHostOptions): Promise<void> {
  const { loaded, store, signal } = options;
  const modules = options.modules ?? [];
  const log = (options.log ?? getLogger(['aivi'])).getChild('host');
  const abort = new AbortController();
  let failure: unknown;
  const fail = (error: unknown) => {
    if (failure === undefined) log.error('host.failed', { error });
    failure ??= error;
    abort.abort();
  };
  const stop = () => abort.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();

  let knowledge: KnowledgeService | undefined;
  let browser: BrowserService | undefined;
  let scheduler: Scheduler | undefined;
  let server: ReturnType<typeof createHostServer> | undefined;
  let supervisor: ModuleSupervisor<HostServices> | undefined;
  const owner = randomUUID();
  let acquired = false;

  // Discovery is one file read, so it runs per unit of work: a restarted `opencode service`
  // (new port and password) is picked up by the next turn without restarting aivi.
  const opencode = () =>
    connectOpenCode(
      loaded.config.opencode,
      process.env,
      {
        onStart: reason => log.info('opencode.started', { reason }),
      },
      log,
    );
  const wake = new Wake();
  const tasks = new TaskRegistry();
  // One OpenCode event stream for the host: opened by the first turn that watches a session, kept for
  // the host's lifetime. Turns take permission prompts and channels take progress from it.
  const events = new EventStream(opencode, abort.signal, log);

  const serve = async (scheduler: Scheduler, channels: Channels, knowledge: KnowledgeService) => {
    // With lifecycle "own", a running service is replaced now, before any module or job needs it:
    // the fresh one has the current plugin build and aivi's token. Failure to do so is not fatal;
    // the next turn simply discovers whatever is running.
    try {
      if (await restartOpenCode(loaded.config.opencode)) log.info('opencode.restarted');
    } catch (error) {
      log.warn('opencode.restart.failed', { error });
    }
    const routes = new PublicRoutes();
    const http = createHostServer({
      store,
      loaded,
      knowledge,
      browser,
      routes,
      jobs: createJobHandler({ store, loaded, channels, opencode, wake: () => wake.notify() }),
      wake: () => wake.notify(),
      health: () => supervisor?.health() ?? [],
      linkable: () => channels.linkable(),
      context: async (sessionID, signal) => describeSession(await opencode(), sessionID, loaded, signal),
      log,
    });
    server = http;
    const { bind, port } = loaded.config.host;
    await new Promise<void>((yes, no) => {
      http.once('error', no);
      http.listen(port, bind, yes);
    });
    http.on('error', fail);
    log.info('api.listening', { bind, port });
    if (!isLoopback(bind))
      log.warn('api.open', {
        bind,
        hint: 'Anyone who can reach this address can search knowledge, use the browser and run jobs.',
      });

    const services: HostServices = {
      loaded,
      store,
      knowledge,
      ...(browser ? { browser } : {}),
      opencode,
      events,
      signal: abort.signal,
      log,
      channels,
      routes,
      // The supervisor replaces this with each module's own scope before start; nothing else reads it.
      tasks: tasks.forModule('host'),
      wake: () => wake.notify(),
      onWake: listener => wake.subscribe(listener),
      fail,
    };
    // An optional module never takes the host down: a failed start is retried in the background
    // and shows as degraded in status; only a ConfigurationError is fatal.
    supervisor = new ModuleSupervisor(services, abort.signal, log, fail, options.moduleRetry, tasks);
    await supervisor.start(modules);
    abort.signal.throwIfAborted();
    options.onReady?.(http.address());

    // Sleep until the next due instant or a wake, whichever comes first; nothing periodic. No in-memory
    // timer holds state: the queue in SQLite is the only truth, and a crash costs nothing.
    while (!abort.signal.aborted) {
      scheduler.tick();
      if (scheduler.stopped) throw new Error('Scheduler stopped unexpectedly');
      await wake.wait(store.nextDue(), abort.signal);
    }
    if (failure !== undefined) throw failure;
  };

  const errors: unknown[] = [];
  try {
    abort.signal.throwIfAborted();
    store.acquireDaemon(owner);
    acquired = true;
    ({ knowledge, browser } = await options.resources());
    // A result for a session no module owns goes straight into that native session's inbox;
    // OpenCode orders it behind whatever the person is doing. Nobody waits for the answer here.
    const channels = new Channels(async (sessionId, text, context) => {
      const client = await opencode();
      await client.session.get({ sessionID: sessionId }, { signal: abort.signal });
      await client.session.prompt(
        {
          sessionID: sessionId,
          text: reentryPrompt(text),
          delivery: 'queue',
          metadata: { aivi: { origin: 'job-result', run: context.run.id } },
        },
        { signal: abort.signal },
      );
    });
    scheduler = new Scheduler(
      store,
      loaded.config.scheduler,
      createExecutor(loaded, { store, knowledge, opencode, events, protectedEnv: options.protectedEnv, log, tasks }),
      log,
      async (run, state, result, reason) => {
        // Capacity was released: queued work may be claimable now.
        wake.notify();
        if (!shouldReport(run.report, state)) return;
        let text = describeOutcome(run, state, result, reason);
        if (state === 'failed' || state === 'blocked') {
          const streak = store.failureStreak(run.jobId);
          if (streak >= FAILURE_NUDGE_AT)
            text += `\nThis job has failed ${streak} times in a row. Fix it, pause it, or remove it.`;
        }
        try {
          await channels.deliver(run.report, text, { run, state });
          store.note(run.id, 'reported', reportTarget(run.report));
        } catch (error) {
          store.note(run.id, 'report-failed', error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    );
    // Retention and projects-sync are the host's own definitions; composed modules seed theirs beside
    // them. All are listed and run like any other job; a module that left the composition loses its
    // jobs, and two definitions sharing an id is a configuration error, not a silent overwrite.
    const system = [...systemJobs(loaded.config), ...modules.flatMap(m => m.jobs?.(loaded.config) ?? [])];
    const systemIds = new Set<string>();
    for (const job of system) {
      if (systemIds.has(job.id)) throw new ConfigurationError(`Two system job definitions claim job id ${job.id}`);
      systemIds.add(job.id);
    }
    store.syncJobs(loaded.config.jobs, system);
    if (loaded.config.search?.indexOnStart) {
      const startedAt = Date.now();
      await knowledge.index();
      log.info('knowledge.indexed', { ms: Date.now() - startedAt });
    }
    abort.signal.throwIfAborted();

    await serve(scheduler, channels, knowledge);
  } catch (error) {
    errors.push(error);
  } finally {
    stop();
    scheduler?.stop();
    if (supervisor) errors.push(...(await supervisor.stop()));
    try {
      await scheduler?.drain();
    } catch (error) {
      errors.push(error);
    }
    if (server?.listening) {
      const http = server;
      await new Promise<void>(yes => http.close(() => yes()));
    }
    // Knowledge closes after modules and in-flight HTTP calls have drained.
    try {
      await browser?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await knowledge?.close();
    } catch (error) {
      errors.push(error);
    }
    if (acquired) store.releaseDaemon(owner);
    signal.removeEventListener('abort', stop);
    log.info('host.stopped', { errors: errors.length });
  }
  // The first entry is the failure that ended the host; cleanup failures follow it, never replace it.
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Application shutdown failed');
}

function isLoopback(address: string): boolean {
  return ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(address);
}
