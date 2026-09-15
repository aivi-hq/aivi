import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { BrowserService, KnowledgeService, LoadedConfig, Logger } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import { Destinations, describeOutcome, reentryPrompt, shouldReport } from './destinations.ts';
import { connectOpenCode, type OpenCodeClient } from './opencode.ts';
import { createExecutor } from './runtime.ts';
import { Scheduler } from './scheduler.ts';
import { createScheduleHandler } from './schedules.ts';
import { createHostServer, type HostAuth } from './server.ts';
import type { Store } from './store.ts';

/** Consecutive failed runs of a recurring job before its failure report asks for a look. */
const FAILURE_NUDGE_AT = 3;

export interface HostServices {
  loaded: LoadedConfig;
  store: Store;
  knowledge: KnowledgeService;
  browser?: BrowserService;
  /** Discovers the OpenCode service on every call. Call once per unit of work and hold the client for its duration. */
  opencode: () => Promise<OpenCodeClient>;
  signal: AbortSignal;
  log: Logger;
  /** Register a place job outcomes can be reported to (`report.to`). */
  destinations: Destinations;
  /** Abort the whole host. Only for failures the module cannot recover from. */
  fail(error: unknown): void;
}
export interface HostResources {
  knowledge: KnowledgeService;
  browser?: BrowserService;
}
export interface RunningModule {
  stop(): Promise<void>;
}
export interface HostModule {
  id: string;
  start(services: HostServices): Promise<RunningModule>;
}

export interface RunHostOptions {
  loaded: LoadedConfig;
  store: Store;
  resources: () => Promise<HostResources>;
  modules?: HostModule[];
  signal: AbortSignal;
  auth: HostAuth;
  /** Environment variable names shell tasks must not inherit (the keys of `<home>/.env`); aivi's fixed secrets are always hidden. */
  protectedEnv?: Iterable<string>;
  log?: Logger;
  /** Materialize schedules, dispatch what is due, wait, and return. No API, no modules. */
  once?: boolean;
  onReady?: (address: unknown) => void;
}

/** Composition and ownership only: no service locator, decorators, or plugin registry. */
export async function runHost(options: RunHostOptions): Promise<void> {
  const { loaded, store, signal, auth } = options;
  const modules = options.modules ?? [];
  const log = (options.log ?? silentLogger).child({ component: 'host' });
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
  const started: RunningModule[] = [];
  const owner = randomUUID();
  let acquired = false;

  // Discovery is one file read, so it runs per unit of work: a restarted `opencode service`
  // (new port and password) is picked up by the next turn without restarting aivi.
  const opencode = () => connectOpenCode(loaded.config.opencode);

  const serve = async (scheduler: Scheduler, destinations: Destinations, knowledge: KnowledgeService) => {
    const http = createHostServer({
      store,
      loaded,
      auth,
      knowledge,
      browser,
      schedule: createScheduleHandler({ store, loaded, destinations, opencode }),
      log,
    });
    server = http;
    const { bind, port } = loaded.config.host;
    await new Promise<void>((yes, no) => {
      http.once('error', no);
      http.listen(port, bind, yes);
    });
    http.on('error', fail);
    log.info('api.listening', { bind, port, auth: auth.mode });
    if (auth.mode === 'none' && !isLoopback(bind))
      log.warn('api.unauthenticated', {
        bind,
        hint: 'Anyone who can reach this address can search knowledge and use the browser.',
      });

    const services: HostServices = {
      loaded,
      store,
      knowledge,
      ...(browser ? { browser } : {}),
      opencode,
      signal: abort.signal,
      log,
      destinations,
      fail,
    };
    for (const module of modules) {
      abort.signal.throwIfAborted();
      started.push(await module.start(services));
      log.info('module.started', { module: module.id });
    }
    options.onReady?.(http.address());

    while (!abort.signal.aborted) {
      scheduler.tick();
      if (scheduler.stopped) throw new Error('Scheduler stopped unexpectedly');
      try {
        await setTimeout(loaded.config.scheduler.pollMs, undefined, { signal: abort.signal });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
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
    const destinations = new Destinations(async (sessionId, text, context) => {
      const client = await opencode();
      await client.session.get({ sessionID: sessionId }, { signal: abort.signal });
      await client.session.prompt(
        {
          sessionID: sessionId,
          text: reentryPrompt(text),
          delivery: 'queue',
          metadata: { aivi: { origin: 'job-result', job: context.job.id } },
        },
        { signal: abort.signal },
      );
    });
    scheduler = new Scheduler(
      store,
      loaded.config.scheduler,
      createExecutor(loaded, { store, knowledge, opencode, protectedEnv: options.protectedEnv, log }),
      log,
      async (job, state, result, reason) => {
        if (!shouldReport(job.report, state)) return;
        let text = describeOutcome(job, state, result, reason);
        if (state !== 'succeeded' && job.scheduleId) {
          const streak = store.failureStreak(job.scheduleId);
          if (streak >= FAILURE_NUDGE_AT)
            text += `\nThis schedule has failed ${streak} times in a row. Fix it, pause it, or remove it.`;
        }
        try {
          await destinations.deliver(job.report, text, { job, state });
          store.note(job.id, 'reported', `${job.report.to}:${job.report.channel}`);
        } catch (error) {
          store.note(job.id, 'report-failed', error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    );
    store.syncSchedules(loaded.config.schedules);
    if (loaded.config.search?.indexOnStart) {
      const startedAt = Date.now();
      await knowledge.index();
      log.info('knowledge.indexed', { ms: Date.now() - startedAt });
    }
    abort.signal.throwIfAborted();

    if (options.once) {
      scheduler.tick();
      await scheduler.drain();
    } else {
      await serve(scheduler, destinations, knowledge);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    stop();
    scheduler?.stop();
    for (const module of started.reverse()) {
      try {
        await module.stop();
      } catch (error) {
        errors.push(error);
      }
    }
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
