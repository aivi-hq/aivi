import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DreamingArgs, KnowledgeService, LoadedConfig, Logger, Run } from '@aivi/core';
import { dreamingArgsSchema, errorMessage, getLogger, MEMORY_SOURCE_ID, runsPruneArgsSchema } from '@aivi/core';
import { dream } from './dreaming.ts';
import type { SessionEvents } from './events.ts';
import type { OpenCodeClient } from './opencode.ts';
import { syncProjects } from './projects.ts';
import type { Execute, ExecutionContext, ExecutionResult } from './scheduler.ts';
import { connectForTurn, PermissionRequired, runTurn, TurnNotStarted, turnIdsFor } from './session.ts';
import type { Store } from './store.ts';
import type { TaskHandler, TaskRegistry } from './tasks.ts';

export interface ExecutorDeps {
  store: Store;
  knowledge?: KnowledgeService | undefined;
  /** Resolved lazily: system checks and indexing never need the model server. */
  opencode: () => Promise<OpenCodeClient>;
  /** The host's OpenCode event stream; turns answer permission prompts from it. */
  events: SessionEvents;
  /** Environment variable names scripts must not inherit, in addition to `SECRET_ENV` (for example the keys of `<home>/.env`). */
  protectedEnv?: Iterable<string> | undefined;
  log?: Logger | undefined;
  /** What `kind: 'invocation'` tasks dispatch to. The host claims its own system operations here, as `host`. */
  tasks: TaskRegistry;
}

/** Secrets aivi reads from its own environment; a shell task never sees them unless its `env` sets them on purpose. */
export const SECRET_ENV = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'OPENCODE_USERNAME',
  'OPENCODE_PASSWORD',
];

/**
 * A script's environment: the host's, minus aivi's secrets, plus the task's
 * own `env`. Scripts keep PATH, HOME and whatever the operator's shell set,
 * so nothing that works from a terminal breaks under aivi.
 */
export function shellEnvironment(
  base: NodeJS.ProcessEnv,
  protectedNames: Iterable<string>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const hidden = new Set([...SECRET_ENV, ...protectedNames]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !hidden.has(name)) env[name] = value;
  return { ...env, ...extra };
}

/** The minimum a claimant's args schema must be; keeps zod out of the host. */
interface ArgSchema<A> {
  parse(value: unknown): A;
}
type TaskHandler2<A> = (run: Run, context: ExecutionContext, args: A) => Promise<ExecutionResult>;

export function createExecutor(loaded: LoadedConfig, deps: ExecutorDeps): Execute {
  const log = deps.log ?? getLogger(['aivi']);
  const protectedEnv = [...(deps.protectedEnv ?? [])];
  const home = dirname(loaded.path);

  /** An operation that takes args: wrong args fail the run with a readable reason, they never throw at the scheduler. */
  const operation =
    <A>(name: string, schema: ArgSchema<A>, work: TaskHandler2<A>): TaskHandler =>
    async (run, context) => {
      let args: A;
      try {
        args = schema.parse(run.task.kind === 'invocation' ? (run.task.args ?? {}) : {});
      } catch (error) {
        return { state: 'failed', result: null, reason: `Bad args for ${name}: ${errorMessage(error)}` };
      }
      return work(run, context, args);
    };

  // The host is just another claimant: its own system operations are claimed into the
  // same registry a module's capabilities land in, and dispatched the same way.
  const hostOperations: Record<string, TaskHandler> = {
    'system.check': async () => {
      const sources = await Promise.all(
        loaded.sources.map(async source => {
          const available = await access(source.path).then(
            () => true,
            () => false,
          );
          return { id: source.id, projectId: source.projectId, available };
        }),
      );
      return { state: 'succeeded', result: { sources, checkedAt: new Date().toISOString() } };
    },
    'knowledge.index': async () => {
      if (!deps.knowledge) throw new Error('Knowledge service is not available');
      return { state: 'succeeded', result: await deps.knowledge.index() };
    },
    'projects.sync': async (_run, context) => {
      const projects = await syncProjects(loaded.projects, context.signal);
      const updated = projects.filter(p => p.state === 'updated').map(p => p.id);
      for (const p of projects)
        if (p.state === 'skipped') log.warn('projects.sync.skipped', { project: p.id, reason: p.reason });
      const indexed = updated.length && deps.knowledge ? await deps.knowledge.index() : undefined;
      return { state: 'succeeded', result: { projects, ...(indexed !== undefined ? { indexed } : {}) } };
    },
    'runs.prune': operation('runs.prune', runsPruneArgsSchema, async (_run, _context, args) => {
      const cutoff = Date.now() - args.olderThanDays * 86_400_000;
      return { state: 'succeeded', result: { olderThan: new Date(cutoff).toISOString(), ...deps.store.prune(cutoff) } };
    }),
    dreaming: operation('dreaming', dreamingArgsSchema, async (run, context, args) => {
      const directory = resolve(home, args.directory);
      const memoryDirectory = resolve(home, args.memoryDirectory);
      const inside = loaded.sources.some(
        s => s.scope === 'core' && (memoryDirectory === s.path || memoryDirectory.startsWith(`${s.path}/`)),
      );
      if (!inside)
        return {
          state: 'failed',
          result: null,
          reason: `dreaming: memoryDirectory "${args.memoryDirectory}" must be inside a core knowledge source so memories are searchable`,
        };
      const task: DreamingArgs = { ...args, directory, memoryDirectory };
      const { sessionId } = turnIdsFor(run.id);
      const timeout = AbortSignal.timeout(task.timeoutMs);
      try {
        const client = await connectForTurn(deps.opencode);
        // Persist the intended ID BEFORE any request. A dropped response then has a known reconciliation target.
        context.attachSession(sessionId);
        const outcome = await dream(task, run.id, {
          store: deps.store,
          events: deps.events,
          client,
          stateDirectory: loaded.config.stateDirectory,
          projects: loaded.sources
            .filter(s => s.scope === 'project' && s.id === MEMORY_SOURCE_ID)
            .map(s => ({ id: s.projectId!, memory: s.path })),
          signal: AbortSignal.any([context.signal, timeout]),
          log,
        });
        if (outcome.result.reviewed && deps.knowledge)
          await deps.knowledge.index().catch(error => log.warn('dreaming.index.failed', { error }));
        return outcome;
      } catch (error) {
        // The cursor did not advance, so the next run reviews the same conversations again.
        log.warn('dreaming.failed', { error });
        return ended(error, {
          sessionId,
          work: 'Dreaming',
          host: context.signal,
          timeout,
          timeoutMs: task.timeoutMs,
        });
      }
    }),
  };
  for (const [name, handler] of Object.entries(hostOperations)) deps.tasks.claim('host', name, handler);

  return async (run, context) => {
    switch (run.task.kind) {
      case 'shell': {
        const task = run.task;
        const [file, ...args] = task.command;
        const cwd = task.cwd ?? loaded.config.stateDirectory;
        const { started, ...outcome } = await new Promise<{
          started: boolean;
          exitCode: number | null;
          signal: string | null;
          stdout: string;
          stderr: string;
        }>(resolve => {
          const child = execFile(
            file!,
            args,
            {
              cwd,
              env: shellEnvironment(process.env, protectedEnv, task.env),
              timeout: task.timeoutMs,
              maxBuffer: 1024 * 1024,
              signal: context.signal,
              windowsHide: true,
            },
            (error, stdout, stderr) => {
              // Node reports a non-zero exit as a numeric `code`, a kill (timeout, abort, maxBuffer) with
              // `signal` or a string code, and a spawn failure (ENOENT, EACCES) with a string code and no pid.
              const exec = error as (NodeJS.ErrnoException & { code?: number | string; signal?: string }) | null;
              resolve({
                started: child.pid !== undefined,
                exitCode: typeof exec?.code === 'number' ? exec.code : exec ? null : 0,
                signal: exec?.signal ?? null,
                stdout: tail(stdout),
                stderr: exec && typeof exec.code !== 'number' ? tail(`${stderr}\n${exec.message}`) : tail(stderr),
              });
            },
          );
        });
        if (outcome.exitCode === 0) return { state: 'succeeded', result: outcome };
        if (typeof outcome.exitCode === 'number')
          return { state: 'failed', result: outcome, reason: `Command exited with ${outcome.exitCode}` };
        // Nothing ran: the next occurrence may simply try again.
        if (!started) return { state: 'failed', result: outcome, reason: `Command could not start: ${file}` };
        // Killed by timeout, host shutdown or output limit: the process may still be running, keep it inspectable.
        return {
          state: 'blocked',
          result: outcome,
          reason: context.signal.aborted
            ? 'Host stopped while the command was running'
            : outcome.signal
              ? `Command killed by ${outcome.signal}`
              : 'Command did not exit cleanly',
        };
      }
      case 'prompt': {
        const task = run.task;
        const { sessionId, messageId } = turnIdsFor(run.id);
        const timeout = AbortSignal.timeout(task.timeoutMs);
        const metadata = { aivi: { origin: 'job', run: run.id } };
        try {
          const client = await connectForTurn(deps.opencode);
          // Persist the intended ID BEFORE the request. A dropped response then has a known reconciliation target.
          context.attachSession(sessionId);
          const turn = await runTurn(
            client,
            {
              sessionId,
              agent: task.agent,
              directory: task.directory,
              create: true,
              title: `aivi ${run.id}`,
              sessionMetadata: metadata,
              messageId,
              text: task.prompt,
              messageMetadata: metadata,
            },
            {
              signal: AbortSignal.any([context.signal, timeout]),
              onPermission: task.onPermission,
              events: deps.events,
              log,
            },
          );
          return { state: 'succeeded', result: { sessionId, text: turn.text, rejectedPermissions: turn.rejected } };
        } catch (error) {
          log.warn('turn.failed', { error });
          return ended(error, { sessionId, work: 'Turn', host: context.signal, timeout, timeoutMs: task.timeoutMs });
        }
      }
      case 'invocation': {
        const handler = deps.tasks.get(run.task.name);
        if (!handler)
          return {
            state: 'failed',
            result: null,
            reason: `Nothing claims the operation "${run.task.name}"; start the module that provides it`,
          };
        return handler(run, context);
      }
    }
  };
}

/**
 * How a turn that produced no verified answer ends. Before the prompt was
 * accepted nothing ran, so the run fails and the next occurrence retries.
 * After it, the session may still be doing things: the run blocks and keeps
 * its capacity until an operator has looked. The SDK wraps an aborted request
 * as a transport error, so the cause is read from the signals, not the error.
 */
function ended(
  error: unknown,
  turn: { sessionId: string; work: 'Turn' | 'Dreaming'; host: AbortSignal; timeout: AbortSignal; timeoutMs: number },
): ExecutionResult {
  if (error instanceof TurnNotStarted)
    return { state: 'failed', result: null, reason: `${turn.work} not started: ${error.message}` };
  const reason =
    error instanceof PermissionRequired
      ? error.message
      : turn.host.aborted
        ? `Host stopped during ${turn.work.toLowerCase()}`
        : turn.timeout.aborted
          ? `${turn.work} exceeded ${turn.timeoutMs}ms`
          : errorMessage(error);
  return {
    state: 'blocked',
    result: { sessionId: turn.sessionId },
    reason: `${reason}. Inspect session ${turn.sessionId} and resolve this run.`,
  };
}

/** Keep only the end of captured output; the beginning is rarely the interesting part. */
function tail(text: string, limit = 16 * 1024): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}
