import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { KnowledgeService, LoadedConfig, Logger } from '@aivi/core';
import { getLogger, parseDuration, systemJobs } from '@aivi/core';
import type { AiviModule, AiviServices } from '@aivi/plugin/module';
import { createApp, serveApp } from './api/app.ts';
import { attachExec } from './api/exec.ts';
import { PublicRoutes } from './api/public.ts';
import { describeSession } from './channel/context.ts';
import { Channels } from './channel/router.ts';
import { Dispatcher, type DispatcherLease } from './dispatcher/dispatcher.ts';
import { LeaseStore } from './dispatcher/leases.ts';
import { EventStream } from './events.ts';
import { Forges } from './forges.ts';
import { createJobHandler } from './jobs.ts';
import { ConfigurationError, ModuleSupervisor, type RetryPolicy } from './modules.ts';
import { connectOpenCode, restartOpenCode } from './opencode.ts';
import { RunLedger } from './orchestrator/ledger.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { describeOutcome, reentryPrompt, reportTarget, shouldReport } from './reports.ts';
import { createExecutor } from './runtime.ts';
import { Scheduler } from './scheduler.ts';
import type { Store } from './store.ts';
import { TaskRegistry } from './tasks.ts';
import { ToolRegistry } from './tools.ts';

/** Consecutive failed runs of a recurring job before its failure report asks for a look. */
const FAILURE_NUDGE_AT = 3;

/**
 * Lets the host loop sleep until the next due instant and be woken early when
 * the queue changes (a tool created a job, the CLI poked `/wake`). A notify
 * that arrives between two waits is not lost: the next wait returns at once.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

class Wake {
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

export interface HostResources {
  knowledge: KnowledgeService;
}

export interface RunHostOptions {
  loaded: LoadedConfig;
  store: Store;
  resources: () => Promise<HostResources>;
  modules?: AiviModule[];
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
  let scheduler: Scheduler | undefined;
  let server: ReturnType<typeof serveApp> | undefined;
  let supervisor: ModuleSupervisor<AiviServices> | undefined;
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
  const tools = new ToolRegistry();
  // The forge registry: modules register their forges at start; the projects-sync
  // task asks who owns a remote before fetching it, and `aivi_pr` asks the
  // same question before pushing; the review gather will ask it too.
  const forges = new Forges();
  // One OpenCode event stream for the host: opened by the first turn that watches a session, kept for
  // the host's lifetime. Turns take permission prompts and channels take progress from it.
  const events = new EventStream(opencode, abort.signal, log);

  // The run ledger is the durable ticket↔run↔session link; the orchestrator is the one
  // authority that turns a ticket into a run. Its two worker tools are host tools: the
  // OpenCode plugin registers them as `aivi_work_complete`/`aivi_ask`, and every call
  // arrives with the trusted session id — which is how a tool call finds its run.
  const ledger = new RunLedger(store);
  // The dispatcher is the only part that knows how much capacity is left;
  // the orchestrator's claims are leases here, and when the dispatcher ends
  // one on its own the mirrored claim must clear. The link between them is
  // set in the same synchronous breath that builds both — anything firing
  // earlier says so, rather than silently losing an ended lease.
  let clearClaim: (lease: DispatcherLease, reason: string) => void = () => {
    throw new Error('a lease ended before the orchestrator was wired to the dispatcher');
  };
  const dispatcher = new Dispatcher({
    leases: new LeaseStore(store),
    dispatcher: loaded.config.dispatcher,
    opencode,
    signal: abort.signal,
    log,
    onEnded: (lease, reason) => clearClaim(lease, reason),
  });
  const orchestrator = new Orchestrator({
    ledger,
    opencode,
    events,
    log,
    signal: abort.signal,
    // Moves come from core's lane order, read straight off the loaded config.
    lanes: id => loaded.config.projects[id]?.lanes ?? [],
    directory: id => {
      const project = loaded.projects.find(p => p.id === id);
      if (!project) throw new Error(`no project ${id} in the loaded config`);
      return project.directory;
    },
    dispatcher,
    forges,
    // The orchestrator's own dial: how long an open elicitation holds a slot.
    keepAliveMs: parseDuration(loaded.config.orchestrator.elicitationKeepAlive),
  });
  clearClaim = (lease, reason) => void orchestrator.leaseEnded(lease, reason);
  for (const tool of orchestrator.tools()) tools.claim('host', tool.descriptor, tool.handler);

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
    const http = serveApp(
      createApp({
        store,
        loaded,
        knowledge,
        routes,
        jobs: createJobHandler({ store, loaded, channels, opencode, wake: () => wake.notify() }),
        wake: () => wake.notify(),
        health: () => supervisor?.health() ?? [],
        linkable: () => channels.linkable(),
        tools,
        context: async (sessionID, signal) => describeSession(await opencode(), sessionID, loaded, signal),
        log,
      }),
    );
    server = http;
    // The exec door rides the same listener: an upgrade on `/exec`, gated by
    // hand (hono never sees upgrades), and audited into the same diary.
    attachExec(http, { store, loaded, log, signal: abort.signal });
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

    const services: AiviServices = {
      loaded,
      store,
      knowledge,
      opencode,
      events,
      signal: abort.signal,
      log,
      channels,
      routes,
      // The supervisor replaces this with each module's own scope before start; nothing else reads it.
      tasks: tasks.forModule('host'),
      tools: tools.forModule('host'),
      forges,
      orchestrator,
      wake: () => wake.notify(),
      onWake: listener => wake.subscribe(listener),
      fail,
    };
    // An optional module never takes the host down: a failed start is retried in the background
    // and shows as degraded in status; only a ConfigurationError is fatal.
    supervisor = new ModuleSupervisor(services, abort.signal, log, fail, options.moduleRetry, tasks, tools);
    await supervisor.start(modules);
    // Leases stand or fall against OpenCode's reality before anything is
    // re-armed: a claim whose session died at the restart clears first, so
    // the watch below never re-attaches to a run that is already over.
    await dispatcher.reconcile();
    // Boot recovery after the modules: a tracker must be registered before its owed
    // ceremonies are re-driven. Live OpenCode turns were resumed by OpenCode itself;
    // this pass re-attaches the watch and fetches the state of anything owed.
    await orchestrator.recover();
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
    ({ knowledge } = await options.resources());
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
      createExecutor(loaded, {
        store,
        knowledge,
        opencode,
        events,
        protectedEnv: options.protectedEnv,
        log,
        tasks,
        forges,
      }),
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
    if (loaded.config.search !== false && loaded.config.search.indexOnStart) {
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
