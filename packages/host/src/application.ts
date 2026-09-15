import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { silentLogger } from '@aivi/core';
import type { KnowledgeService, LoadedConfig, BrowserService, Logger } from '@aivi/core';
import { Store } from './store.ts';
import { Scheduler } from './scheduler.ts';
import { createExecutor } from './runtime.ts';
import { connectOpenCode, type OpenCodeClient } from './opencode.ts';
import { createHostServer, type HostAuth } from './server.ts';
import { Destinations, describeOutcome, shouldReport } from './destinations.ts';

export interface HostServices {
  loaded: LoadedConfig;
  store: Store;
  knowledge: KnowledgeService;
  browser?: BrowserService;
  /** Resolved once per host; discovers the OpenCode service on first use. */
  opencode: () => Promise<OpenCodeClient>;
  signal: AbortSignal;
  log: Logger;
  /** Register a place job outcomes can be reported to (`report.to`). */
  destinations: Destinations;
  /** Abort the whole host. Only for failures the module cannot recover from. */
  fail(error: unknown): void;
}
export interface HostResources { knowledge: KnowledgeService; browser?: BrowserService }
export interface RunningModule { stop(): Promise<void> }
export interface HostModule { id: string; start(services: HostServices): Promise<RunningModule> }

export interface RunHostOptions {
  loaded: LoadedConfig;
  store: Store;
  resources: () => Promise<HostResources>;
  modules?: HostModule[];
  signal: AbortSignal;
  auth: HostAuth;
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

  // One OpenCode client per host, resolved lazily so pure maintenance never needs the model server.
  let opencodeClient: Promise<OpenCodeClient> | undefined;
  const opencode = () => (opencodeClient ??= connectOpenCode(loaded.config.opencode).catch(error => {
    opencodeClient = undefined; // allow a retry after the service comes up
    throw error;
  }));

  try {
    store.acquireDaemon(owner);
    acquired = true;
    ({ knowledge, browser } = await options.resources());
    const destinations = new Destinations();
    scheduler = new Scheduler(store, loaded.config.scheduler, createExecutor(loaded, { store, knowledge, opencode, log }), log, async (job, state, result, reason) => {
      if (!shouldReport(job.report, state)) return;
      try {
        await destinations.deliver(job.report, describeOutcome(job, state, result, reason));
        store.note(job.id, 'reported', `${job.report.to}:${job.report.channel}`);
      } catch (error) {
        store.note(job.id, 'report-failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
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
      return;
    }

    const http = createHostServer({ store, loaded, auth, knowledge, browser, log });
    server = http;
    const { bind, port } = loaded.config.host;
    await new Promise<void>((yes, no) => { http.once('error', no); http.listen(port, bind, yes); });
    http.on('error', fail);
    log.info('api.listening', { bind, port, auth: auth.mode });
    if (auth.mode === 'none' && !isLoopback(bind)) log.warn('api.unauthenticated', { bind, hint: 'Anyone who can reach this address can search knowledge and use the browser.' });

    const services: HostServices = { loaded, store, knowledge, ...(browser ? { browser } : {}), opencode, signal: abort.signal, log, destinations, fail };
    for (const module of modules) {
      abort.signal.throwIfAborted();
      started.push(await module.start(services));
      log.info('module.started', { module: module.id });
    }
    options.onReady?.(http.address());

    while (!abort.signal.aborted) {
      scheduler.tick();
      if (scheduler.stopped) throw new Error('Scheduler stopped unexpectedly');
      try { await setTimeout(loaded.config.scheduler.pollMs, undefined, { signal: abort.signal }); }
      catch (error) { if (!abort.signal.aborted) throw error; }
    }
    if (failure !== undefined) throw failure;
  } finally {
    stop();
    scheduler?.stop();
    const errors: unknown[] = [];
    for (const module of started.reverse()) {
      try { await module.stop(); } catch (error) { errors.push(error); }
    }
    try { await scheduler?.drain(); } catch (error) { errors.push(error); }
    if (server?.listening) { const http = server; await new Promise<void>(yes => http.close(() => yes())); }
    // Knowledge closes after modules and in-flight HTTP calls have drained.
    try { await browser?.close(); } catch (error) { errors.push(error); }
    try { await knowledge?.close(); } catch (error) { errors.push(error); }
    if (acquired) store.releaseDaemon(owner);
    signal.removeEventListener('abort', stop);
    log.info('host.stopped', { errors: errors.length });
    if (errors.length) throw new AggregateError(errors, 'Application shutdown failed');
  }
}

function isLoopback(address: string): boolean {
  return ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(address);
}
