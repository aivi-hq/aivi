import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { KnowledgeService, LoadedConfig, Logger } from '@aivi/core';
import { errorMessage, silentLogger } from '@aivi/core';
import { dream } from './dreaming.ts';
import type { OpenCodeClient } from './opencode.ts';
import type { Execute, ExecutionResult } from './scheduler.ts';
import { PermissionRequired, runTurn, turnIdsFor } from './session.ts';
import type { Store } from './store.ts';

export interface ExecutorDeps {
  store: Store;
  knowledge?: KnowledgeService | undefined;
  /** Resolved lazily: system checks and indexing never need the model server. */
  opencode: () => Promise<OpenCodeClient>;
  log?: Logger | undefined;
}

export function createExecutor(loaded: LoadedConfig, deps: ExecutorDeps): Execute {
  const log = deps.log ?? silentLogger;
  return async (job, context) => {
    switch (job.task.kind) {
      case 'knowledge.index': {
        if (!deps.knowledge) throw new Error('Knowledge service is not available');
        return { state: 'succeeded', result: await deps.knowledge.index() };
      }
      case 'system.check': {
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
      }
      case 'shell': {
        const task = job.task;
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
            { cwd, timeout: task.timeoutMs, maxBuffer: 1024 * 1024, signal: context.signal, windowsHide: true },
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
      case 'dreaming': {
        const task = job.task;
        const client = await connect(deps.opencode);
        if (!client.ok) return client.outcome;
        const { sessionId } = turnIdsFor(job.id);
        const timeout = AbortSignal.timeout(task.timeoutMs);
        // Persist the intended ID BEFORE any request. A dropped response then has a known reconciliation target.
        context.attachSession(sessionId);
        try {
          const outcome = await dream(task, job.id, {
            store: deps.store,
            client: client.value,
            stateDirectory: loaded.config.stateDirectory,
            signal: AbortSignal.any([context.signal, timeout]),
            log,
          });
          if (outcome.result.reviewed && deps.knowledge)
            await deps.knowledge.index().catch(error => log.warn('dreaming.index.failed', { error }));
          return outcome;
        } catch (error) {
          // The cursor did not advance, so the next run reviews the same conversations again.
          log.warn('dreaming.failed', { error });
          return blocked(error, {
            sessionId,
            work: 'Dreaming',
            host: context.signal,
            timeout,
            timeoutMs: task.timeoutMs,
          });
        }
      }
      case 'opencode.prompt': {
        const task = job.task;
        const client = await connect(deps.opencode);
        if (!client.ok) return client.outcome;
        const { sessionId, messageId } = turnIdsFor(job.id);
        const timeout = AbortSignal.timeout(task.timeoutMs);
        // Persist the intended ID BEFORE the request. A dropped response then has a known reconciliation target.
        context.attachSession(sessionId);
        const metadata = { aivi: { origin: 'job', job: job.id } };
        try {
          const turn = await runTurn(
            client.value,
            {
              sessionId,
              agent: task.agent,
              directory: task.directory,
              create: true,
              title: `aivi ${job.id}`,
              sessionMetadata: metadata,
              messageId,
              text: task.prompt,
              messageMetadata: metadata,
            },
            { signal: AbortSignal.any([context.signal, timeout]), onPermission: task.onPermission, log },
          );
          return { state: 'succeeded', result: { sessionId, text: turn.text, rejectedPermissions: turn.rejected } };
        } catch (error) {
          // The session may still be doing things; keep its capacity until an operator has looked.
          log.warn('turn.failed', { error });
          return blocked(error, { sessionId, work: 'Turn', host: context.signal, timeout, timeoutMs: task.timeoutMs });
        }
      }
    }
  };
}

/** Discovery failure has no external effect: fail the job so the next occurrence simply tries again. */
async function connect(
  opencode: () => Promise<OpenCodeClient>,
): Promise<{ ok: true; value: OpenCodeClient } | { ok: false; outcome: ExecutionResult }> {
  try {
    return { ok: true, value: await opencode() };
  } catch (error) {
    return {
      ok: false,
      outcome: { state: 'failed', result: null, reason: `OpenCode unreachable: ${errorMessage(error)}` },
    };
  }
}

/**
 * A turn that ended without a verified answer blocks its job. The SDK wraps an
 * aborted request as a transport error, so the cause is read from the signals,
 * not from the error.
 */
function blocked(
  error: unknown,
  turn: { sessionId: string; work: 'Turn' | 'Dreaming'; host: AbortSignal; timeout: AbortSignal; timeoutMs: number },
): ExecutionResult {
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
    reason: `${reason}. Inspect session ${turn.sessionId} and resolve this job.`,
  };
}

/** Keep only the end of captured output; the beginning is rarely the interesting part. */
function tail(text: string, limit = 16 * 1024): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}
