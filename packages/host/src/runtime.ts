import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { KnowledgeService, LoadedConfig, Logger } from '@aivi/core';
import { errorMessage, silentLogger } from '@aivi/core';
import { dream } from './dreaming.ts';
import type { OpenCodeClient } from './opencode.ts';
import type { Execute } from './scheduler.ts';
import { PermissionRequired, runTurn } from './session.ts';
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
        const outcome = await new Promise<{
          exitCode: number | null;
          signal: string | null;
          stdout: string;
          stderr: string;
        }>(resolve => {
          execFile(
            file!,
            args,
            { cwd, timeout: task.timeoutMs, maxBuffer: 1024 * 1024, signal: context.signal, windowsHide: true },
            (error, stdout, stderr) => {
              const exec = error as
                | (NodeJS.ErrnoException & { code?: number | string; signal?: string; killed?: boolean })
                | null;
              resolve({
                exitCode: typeof exec?.code === 'number' ? exec.code : exec ? null : 0,
                signal: exec?.signal ?? null,
                stdout: tail(stdout),
                stderr: exec && typeof exec.code !== 'number' ? tail(`${stderr}\n${exec.message}`) : tail(stderr),
              });
            },
          );
        });
        if (outcome.exitCode === 0) return { state: 'succeeded', result: outcome };
        // Aborted by host shutdown or timeout: the process may still be running, keep it inspectable.
        if (outcome.exitCode === null)
          return {
            state: 'blocked',
            result: outcome,
            reason: outcome.signal ? `Command killed by ${outcome.signal}` : 'Command did not exit cleanly',
          };
        return { state: 'failed', result: outcome, reason: `Command exited with ${outcome.exitCode}` };
      }
      case 'dreaming': {
        const sessionId = `ses_aivi_${job.id.replaceAll('-', '')}`;
        try {
          const outcome = await dream(job.task, job.id, {
            store: deps.store,
            opencode: deps.opencode,
            stateDirectory: loaded.config.stateDirectory,
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(job.task.timeoutMs)]),
            log,
          });
          if (outcome.result.reviewed && deps.knowledge)
            await deps.knowledge.index().catch(error => log.warn('dreaming.index.failed', { error }));
          return outcome;
        } catch (error) {
          // The cursor did not advance, so the next run reviews the same conversations again.
          log.warn('dreaming.failed', { error });
          const reason = context.signal.aborted
            ? 'Host stopped during dreaming'
            : error instanceof Error && error.name === 'TimeoutError'
              ? `Dreaming exceeded ${job.task.timeoutMs}ms`
              : errorMessage(error);
          return {
            state: 'blocked',
            result: { sessionId },
            reason: `${reason}. Inspect session ${sessionId} and resolve this job.`,
          };
        }
      }
      case 'opencode.prompt': {
        const client = await deps.opencode();
        const suffix = job.id.replaceAll('-', '');
        const sessionId = `ses_aivi_${suffix}`;
        // Persist the intended ID BEFORE the request. A dropped response then has a known reconciliation target.
        context.attachSession(sessionId);
        const metadata = { aivi: { origin: 'job', job: job.id } };
        try {
          const turn = await runTurn(
            client,
            {
              sessionId,
              agent: job.task.agent,
              directory: job.task.directory,
              create: true,
              title: `aivi ${job.id}`,
              sessionMetadata: metadata,
              messageId: `msg_aivi_${suffix}`,
              text: job.task.prompt,
              messageMetadata: metadata,
            },
            {
              signal: AbortSignal.any([context.signal, AbortSignal.timeout(job.task.timeoutMs)]),
              onPermission: job.task.onPermission,
              log,
            },
          );
          return { state: 'succeeded', result: { sessionId, text: turn.text, rejectedPermissions: turn.rejected } };
        } catch (error) {
          // The session may still be doing things; keep its capacity until an operator has looked.
          log.warn('turn.failed', { error });
          const reason =
            error instanceof PermissionRequired
              ? error.message
              : context.signal.aborted
                ? 'Host stopped while the turn was running'
                : error instanceof Error && error.name === 'TimeoutError'
                  ? `Turn exceeded ${job.task.timeoutMs}ms`
                  : errorMessage(error);
          return {
            state: 'blocked',
            result: { sessionId },
            reason: `${reason}. Inspect session ${sessionId} and resolve this job.`,
          };
        }
      }
    }
  };
}

/** Keep only the end of captured output; the beginning is rarely the interesting part. */
function tail(text: string, limit = 16 * 1024): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}
