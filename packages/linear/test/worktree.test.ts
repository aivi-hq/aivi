import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ensureWorktree, worktreePathFor } from '../src/worktree.ts';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);

test('a worker worktree starts from the remote tip on Linear’s branch, continues an upstream branch, and is reused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(upstream);
  await writeFile(join(upstream, 'README.md'), 'one');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'one');
  const source = join(root, 'projects/site/source');
  await mkdir(join(root, 'projects/site'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  // source/ goes stale: upstream moves on.
  await writeFile(join(upstream, 'README.md'), 'two');
  await git(upstream, 'commit', '-q', '-am', 'two');

  const path = worktreePathFor(source, 'as_1');
  assert.equal(path, join(root, 'projects/site/worktrees/as_1'));
  const made = await ensureWorktree({ source, path, branch: 'me/eng-1-fix' });
  assert.deepEqual(made, { path, branch: 'me/eng-1-fix', base: 'origin/main' });
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'two',
    'from the fetched remote tip, not stale source/',
  );
  assert.equal((await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'me/eng-1-fix');
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), 'one', 'source/ itself is untouched');

  assert.equal((await ensureWorktree({ source, path, branch: 'me/eng-1-fix' })).base, 'existing worktree');

  // The worker pushed; a later worker on the same issue continues from upstream's branch.
  await writeFile(join(path, 'work.md'), 'progress');
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', 'progress');
  await git(path, 'push', '-q', '-u', 'origin', 'me/eng-1-fix');
  // While the first worktree still holds the branch, a new session continues in it (git allows one checkout per branch).
  const again = await ensureWorktree({ source, path: worktreePathFor(source, 'as_2'), branch: 'me/eng-1-fix' });
  assert.equal(await realpath(again.path), await realpath(path), 'git reports the holder by its real path');
  assert.equal(again.base, 'existing worktree');
  // Once that worktree is gone (pruned), the branch is picked up from upstream.
  await git(source, 'worktree', 'remove', '--force', path);
  const second = await ensureWorktree({ source, path: worktreePathFor(source, 'as_2'), branch: 'me/eng-1-fix' });
  assert.equal(second.base, 'origin/me/eng-1-fix');
  assert.equal(await readFile(join(second.path, 'work.md'), 'utf8'), 'progress');
});
