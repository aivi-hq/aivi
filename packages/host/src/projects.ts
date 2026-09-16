import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@aivi/core';
import { errorMessage } from '@aivi/core';

const run = promisify(execFile);

export interface ProjectSyncOutcome {
  id: string;
  /** `updated` when the checkout moved, `current` when it already matched upstream, `skipped` with a reason otherwise. */
  state: 'updated' | 'current' | 'skipped';
  from?: string;
  to?: string;
  reason?: string;
}

/**
 * Bring one project's `source/` up to date with its upstream: fetch, then
 * fast-forward the checked-out branch. Anything that would need a decision
 * (local changes, a detached head, no upstream, diverged history) is skipped
 * with the reason, never resolved by force; `source/` is the clean checkout
 * that gets indexed, not a working directory.
 */
export async function syncProject(project: Project, signal?: AbortSignal): Promise<ProjectSyncOutcome> {
  const { id, directory } = project;
  const git = async (...args: string[]) =>
    (
      await run('git', ['-C', directory, ...args], { maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) })
    ).stdout.trim();
  if (!(await stat(join(directory, '.git')).catch(() => null)))
    return { id, state: 'skipped', reason: 'not a git checkout' };
  try {
    if (await git('status', '--porcelain')) return { id, state: 'skipped', reason: 'local changes in source/' };
    const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
    if (!branch) return { id, state: 'skipped', reason: 'detached HEAD' };
    await git('fetch', '--quiet', '--prune');
    const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').catch(() => '');
    if (!upstream) return { id, state: 'skipped', reason: `branch ${branch} has no upstream` };
    const from = await git('rev-parse', 'HEAD');
    const to = await git('rev-parse', upstream);
    if (from === to) return { id, state: 'current', from, to };
    if (
      (await git('merge-base', '--is-ancestor', 'HEAD', upstream).then(
        () => true,
        () => false,
      )) === false
    )
      return { id, state: 'skipped', reason: `${branch} and ${upstream} have diverged` };
    await git('merge', '--ff-only', '--quiet', upstream);
    return { id, state: 'updated', from, to };
  } catch (error) {
    return { id, state: 'skipped', reason: errorMessage(error) };
  }
}

/** Sync every checked-out project in turn; removed projects have nothing to sync. */
export async function syncProjects(projects: Project[], signal?: AbortSignal): Promise<ProjectSyncOutcome[]> {
  const outcomes: ProjectSyncOutcome[] = [];
  for (const project of projects) {
    if (project.removed) continue;
    signal?.throwIfAborted();
    outcomes.push(await syncProject(project, signal));
  }
  return outcomes;
}
