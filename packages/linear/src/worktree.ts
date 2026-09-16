import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { projectLayout } from '@aivi/core';

const run = promisify(execFile);

export interface WorktreeInput {
  /** The project's clean checkout, `<home>/projects/<id>/source`. */
  source: string;
  /** Where the worktree goes; conventionally `<project>/worktrees/<agent session id>`. */
  path: string;
  /** Linear's branch name for the issue (`Issue.branchName`). */
  branch: string;
  signal?: AbortSignal;
}

/** Where a worker for an agent session works. */
export const worktreePathFor = (sourceDirectory: string, agentSession: string) =>
  join(projectLayout(dirname(sourceDirectory)).worktrees, agentSession.replaceAll(/[^A-Za-z0-9_-]/g, '_'));

/**
 * Make the worktree a worker runs in, on Linear's branch for the issue,
 * starting from the remote tip so a stale `source/` never matters:
 * `origin/<branch>` when the branch already exists upstream (a second worker
 * on the same issue continues it), the local branch when only that exists,
 * else a new branch from the remote default branch. An existing worktree at
 * the path, or one elsewhere that already holds the branch, is reused as it
 * is. Returns the path actually used and the branch's base.
 */
export async function ensureWorktree(input: WorktreeInput): Promise<{ path: string; branch: string; base: string }> {
  const git = async (...args: string[]) =>
    (
      await run('git', ['-C', input.source, ...args], {
        maxBuffer: 4 * 1024 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    ).stdout.trim();
  if (await stat(join(input.path, '.git')).catch(() => null)) {
    return { path: input.path, branch: input.branch, base: 'existing worktree' };
  }
  await mkdir(dirname(input.path), { recursive: true });
  await git('worktree', 'prune');
  // Git checks a branch out in one worktree only. A worktree kept from an earlier session on
  // this issue holds the branch and its uncommitted work: the new session continues there.
  const holder = worktreeHolding(await git('worktree', 'list', '--porcelain'), input.branch);
  if (holder) return { path: holder, branch: input.branch, base: 'existing worktree' };
  await git('fetch', '--quiet', '--prune', 'origin').catch(() => {});
  const exists = (ref: string) =>
    git('rev-parse', '--verify', '--quiet', ref).then(
      () => true,
      () => false,
    );
  if (await exists(`refs/remotes/origin/${input.branch}`)) {
    await git('worktree', 'add', '--quiet', '-B', input.branch, input.path, `origin/${input.branch}`);
    return { path: input.path, branch: input.branch, base: `origin/${input.branch}` };
  }
  if (await exists(`refs/heads/${input.branch}`)) {
    await git('worktree', 'add', '--quiet', input.path, input.branch);
    return { path: input.path, branch: input.branch, base: input.branch };
  }
  const base = await defaultBase(git);
  await git('worktree', 'add', '--quiet', '-b', input.branch, input.path, base);
  return { path: input.path, branch: input.branch, base };
}

/** The worktree path that has `branch` checked out, from `git worktree list --porcelain`. */
export function worktreeHolding(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path;
  }
  return null;
}

/** `origin/HEAD`'s target when known, else the checked-out branch's upstream, else HEAD. */
async function defaultBase(git: (...args: string[]) => Promise<string>): Promise<string> {
  const head = await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').catch(() => '');
  if (head) return head;
  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').catch(() => '');
  return upstream || 'HEAD';
}
