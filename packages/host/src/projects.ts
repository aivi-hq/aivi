import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@aivi/core';
import { errorMessage } from '@aivi/core';
import type { Forges } from '@aivi/plugin/forge';

const run = promisify(execFile);

/** One git execution: the plain path's crossing to disk. Tests answer this
 *  instead of spawning git — the decision whether to fast-forward, skip or
 *  report is the unit; whether git really moves files is git's own unit and
 *  the live gate's subject. */
export type ProjectGit = (directory: string, args: string[], signal?: AbortSignal) => Promise<string>;

const realGit: ProjectGit = async (directory, args, signal) =>
  (
    await run('git', ['-C', directory, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    })
  ).stdout.trim();

export interface ProjectSyncOutcome {
  id: string;
  /** `updated` when the checkout moved, `current` when it already matched upstream, `skipped` with a reason otherwise. */
  state: 'updated' | 'current' | 'skipped';
  from?: string;
  to?: string;
  reason?: string;
}

/**
 * Bring one project's `source/` up to date with its upstream: ask the forge
 * registry **who owns this project's remote**, and an owned checkout syncs
 * **through the forge** — a fetch authenticates, and credentials belong to
 * the system that holds them, not to aivi's machinery. Everything else
 * stays plain git naming no plugin (the configurable path, not the spine):
 * no forge registered, a remote no forge recognises, no checkout at all.
 * Both ways the rule is the same — fast-forward only; anything that would
 * need a decision (local changes, a detached head, no upstream, diverged
 * history) is skipped with the reason, never resolved by force, because
 * `source/` is the clean checkout that gets indexed, not a working
 * directory.
 */
async function syncProject(
  project: Project,
  forges: Forges,
  signal: AbortSignal | undefined,
  runner: ProjectGit,
): Promise<ProjectSyncOutcome> {
  const { id, directory } = project;
  const git = (...args: string[]) => runner(directory, args, signal);
  if (!(await stat(join(directory, '.git')).catch(() => null)))
    return { id, state: 'skipped', reason: 'not a git checkout' };
  try {
    const owned = await forges.owner({ id, directory });
    if (owned) {
      const sync = await owned.forge.syncSource(owned.repo, directory);
      return sync.state === 'held'
        ? { id, state: 'skipped', ...(sync.reason ? { reason: sync.reason } : {}) }
        : { id, state: sync.state, ...(sync.from ? { from: sync.from } : {}), ...(sync.to ? { to: sync.to } : {}) };
    }
    return await plainSync(id, git);
  } catch (error) {
    return { id, state: 'skipped', reason: errorMessage(error) };
  }
}

/** The plain path's decision — the whole rule in one read: fast-forward
 *  when the checkout can move forward as it stands; skip with the reason
 *  when anything would need a decision. */
async function plainSync(id: string, git: (...args: string[]) => Promise<string>): Promise<ProjectSyncOutcome> {
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
}

/** Sync every checked-out project in turn; removed projects have nothing to sync. */
export async function syncProjects(
  projects: Project[],
  forges: Forges,
  signal?: AbortSignal,
  git?: ProjectGit,
): Promise<ProjectSyncOutcome[]> {
  const outcomes: ProjectSyncOutcome[] = [];
  for (const project of projects) {
    if (project.removed) continue;
    signal?.throwIfAborted();
    outcomes.push(await syncProject(project, forges, signal, git ?? realGit));
  }
  return outcomes;
}
