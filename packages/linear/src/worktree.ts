import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { GitIdentity, ReadGitConfig } from '@aivi/core';
import { projectLayout } from '@aivi/core';

const run = promisify(execFile);

/** Run git in one directory; answers its trimmed stdout, rejects with its stderr. */
const gitIn = async (cwd: string, args: string[], signal: AbortSignal | undefined): Promise<string> =>
  (
    await run('git', ['-C', cwd, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    })
  ).stdout.trim();

/**
 * The machine's own git config, which is where the second source of the commit
 * identity lives. Unset, unreadable or no git answers `""` — the caller falls
 * through to the aivi app.
 */
export const globalGitConfig: ReadGitConfig = async key =>
  (await run('git', ['config', '--global', '--get', key], { maxBuffer: 64 * 1024 }).catch(() => null))?.stdout.trim() ??
  '';

export interface WorktreeInput {
  /** The project's clean checkout, `<home>/projects/<id>/source`. */
  source: string;
  /** Where the worktree goes; conventionally `<project>/worktrees/<agent session id>`. */
  path: string;
  /** Linear's branch name for the issue (`Issue.branchName`). */
  branch: string;
  /** Who aivi is when it commits here: written into the worktree, see `markWorktree`. */
  identity: GitIdentity;
  signal?: AbortSignal;
}

/**
 * Say in the worktree itself that aivi launched it, so every commit in it is the
 * bot's and carries no co-author trailer. Git refuses per-worktree settings
 * until the repository enables the `worktreeConfig` extension, so that goes on
 * once per checkout first; the three settings then live in this worktree only:
 * the author is the bot (author *and* committer, whatever the shell says) and
 * `agent.autonomous` is the marker the commit plugin reads as "nobody was
 * sitting here, add no trailer". Written on every use, so a worktree kept from
 * an earlier session is marked too. Failures throw: an unmarked worker would
 * commit as whoever owns the machine.
 */
async function markWorktree(
  source: string,
  path: string,
  identity: GitIdentity,
  signal: AbortSignal | undefined,
): Promise<void> {
  await gitIn(source, ['config', 'extensions.worktreeConfig', 'true'], signal);
  await gitIn(path, ['config', '--worktree', 'user.name', identity.name], signal);
  await gitIn(path, ['config', '--worktree', 'user.email', identity.email], signal);
  await gitIn(path, ['config', '--worktree', 'agent.autonomous', 'true'], signal);
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
 * is. Every worktree it hands back is marked as aivi's own work
 * (`markWorktree`). Returns the path actually used and the branch's base.
 */
export async function ensureWorktree(input: WorktreeInput): Promise<{ path: string; branch: string; base: string }> {
  const git = (...args: string[]) => gitIn(input.source, args, input.signal);
  /** A worktree a worker may commit in is marked with who launched it. */
  const ready = async (path: string): Promise<string> => {
    await markWorktree(input.source, path, input.identity, input.signal);
    return path;
  };
  if (await stat(join(input.path, '.git')).catch(() => null)) {
    return { path: await ready(input.path), branch: input.branch, base: 'existing worktree' };
  }
  await mkdir(dirname(input.path), { recursive: true });
  await git('worktree', 'prune');
  // Git checks a branch out in one worktree only. A worktree kept from an earlier session on
  // this issue holds the branch and its uncommitted work: the new session continues there.
  const holder = worktreeHolding(await git('worktree', 'list', '--porcelain'), input.branch);
  if (holder) return { path: await ready(holder), branch: input.branch, base: 'existing worktree' };
  await git('fetch', '--quiet', '--prune', 'origin').catch(() => {});
  const exists = (ref: string) =>
    git('rev-parse', '--verify', '--quiet', ref).then(
      () => true,
      () => false,
    );
  if (await exists(`refs/remotes/origin/${input.branch}`)) {
    await git('worktree', 'add', '--quiet', '-B', input.branch, input.path, `origin/${input.branch}`);
    return { path: await ready(input.path), branch: input.branch, base: `origin/${input.branch}` };
  }
  if (await exists(`refs/heads/${input.branch}`)) {
    await git('worktree', 'add', '--quiet', input.path, input.branch);
    return { path: await ready(input.path), branch: input.branch, base: input.branch };
  }
  const base = await defaultBase(git);
  await git('worktree', 'add', '--quiet', '-b', input.branch, input.path, base);
  return { path: await ready(input.path), branch: input.branch, base };
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
