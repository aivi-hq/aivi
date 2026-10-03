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
  /** The branch the worker works on: what the tracker names the issue's
   *  branch (Linear's `Issue.branchName`). */
  branch: string;
  /** Who aivi is when it commits here: written into the worktree, see `markWorktree`. */
  identity: GitIdentity;
  /** The boundary crossing, when the project has a forge: the caller injects
   *  that forge's `fetchBranch` for this project's remote (ruled 2026-10-02:
   *  every external boundary is crossed by using the forge). Without it the
   *  worktree starts from refs the clone already holds — this code never
   *  reaches `origin` itself. */
  fetchBranch?: (branch: string) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Say in the worktree itself that aivi launched it, so every commit in it is the
 * bot's and carries no co-author trailer — and that aivi's worker has **no
 * credential to spend**, so boundary git that slips past the tools simply
 * fails at `origin` (ruled 2026-10-02: "Our code failing means the push fails.
 * Because there are no credentials."). Git refuses per-worktree settings
 * until the repository enables the `worktreeConfig` extension, so that goes on
 * once per checkout first; the five settings then live in this worktree only:
 * the author is the bot (author *and* committer, whatever the shell says),
 * `agent.autonomous` is the marker the commit plugin reads as "nobody was
 * sitting here, add no trailer", and the last two starve any crossing: an
 * empty `credential.helper` value removes every helper the machine configured
 * (no keychain), and `core.sshCommand=false` sends ssh transports to the
 * `false` binary. The forge is immune by construction: it names its HTTPS URL
 * on the command line and passes its token through `GIT_CONFIG_*` env, which
 * outranks worktree config. Written on every use, so a worktree kept from an
 * earlier session is marked too. Failures throw: an unmarked worker would
 * commit as whoever owns the machine — and push as them too.
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
  await gitIn(path, ['config', '--worktree', 'credential.helper', ''], signal);
  await gitIn(path, ['config', '--worktree', 'core.sshCommand', 'false'], signal);
}

/** Where one run's worker works: `<project>/worktrees/<name>`. The
 *  orchestrator names it for the run; a worktree an earlier run kept is
 *  found by the branch it holds, not by this path. */
export const worktreePathFor = (sourceDirectory: string, name: string) =>
  join(projectLayout(dirname(sourceDirectory)).worktrees, name.replaceAll(/[^A-Za-z0-9_-]/g, '_'));

/**
 * Make the worktree a worker runs in, on the ticket's branch, starting from
 * the remote tip — which arrives only through the injected forge fetch, so a
 * stale `source/` never matters where a forge owns the remote:
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
  // The worktree starts from the remote tip so a stale `source/` never
  // matters — and when a forge owns the remote, that fetch is the forge's:
  // the caller injects it here, because every external boundary is crossed
  // by using the forge (ruled 2026-10-02; the raw fetch that used to sit on
  // this line was the orchestrator reaching `origin` itself, and it is
  // gone). With no forge injected this stays local git: the refs the clone
  // already holds decide, and a fetch failure is the forge's to say, not a
  // truth this code swallows.
  if (input.fetchBranch) await input.fetchBranch(input.branch);
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
function worktreeHolding(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path;
  }
  return null;
}

/**
 * Tear down the worktree a **stopped** run worked in (ruled 2026-10-03): a
 * stop cleans up after itself — the uncommitted work goes with the worktree
 * and the local branch goes with it, so the stopped attempt's commits go too
 * and the next worker starts from the remote's truth, not from a
 * half-finished state. What was already **pushed** stays pushed: a stop ends
 * this machine's attempt, it does not rewrite the remote. A detached HEAD
 * loses its directory and holds no branch to delete. Returns the branch name
 * when the worktree went but the branch would not (checked out elsewhere —
 * the caller says so, never silence); removal itself throws on failure and
 * the caller names the path that stayed. A run that **failed** keeps its
 * worktree: that one a person may still want to inspect — and a worktree
 * left by a stop that crashed before cleaning is found by the next run's
 * `ensureWorktree`, which reuses the holder of the branch as it always has.
 */
export async function removeWorktree(source: string, path: string, signal?: AbortSignal): Promise<string | undefined> {
  const git = (...args: string[]) => gitIn(source, args, signal);
  if (!(await stat(join(path, '.git')).catch(() => null))) {
    // Not a live worktree: let git forget its registration if it still holds one.
    await git('worktree', 'prune');
    return undefined;
  }
  const branch = await gitIn(path, ['rev-parse', '--abbrev-ref', '--quiet', 'HEAD'], signal).catch(() => '');
  await git('worktree', 'remove', '--force', path);
  if (branch && branch !== 'HEAD') {
    try {
      await git('branch', '-D', branch);
    } catch {
      return branch;
    }
  }
  return undefined;
}

/** `origin/HEAD`'s target when known, else the checked-out branch's upstream, else HEAD. */
async function defaultBase(git: (...args: string[]) => Promise<string>): Promise<string> {
  const head = await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').catch(() => '');
  if (head) return head;
  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').catch(() => '');
  return upstream || 'HEAD';
}
