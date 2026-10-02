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
/** A commit as whoever runs it: no `-c` overrides, so the worktree's own settings decide. */
const bare = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);
const BOT = { name: 'aivi-agent[bot]', email: '331678708+aivi-agent[bot]@users.noreply.github.com' };
/** A checkout with an upstream, both with one commit. */
async function checkout(root: string) {
  const upstream = join(root, 'upstream');
  await mkdir(upstream);
  await writeFile(join(upstream, 'README.md'), 'one');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'one');
  const source = join(root, 'projects/site/source');
  await mkdir(join(root, 'projects/site'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  return { upstream, source };
}
/** The effective value of a config key, or `''` when it is unset. */
const config = async (cwd: string, key: string) =>
  (await bare(cwd, 'config', '--get', key).catch(() => null))?.stdout.trim() ?? '';

test('a worker worktree starts from the remote tip on Linear’s branch, continues an upstream branch, and is reused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { upstream, source } = await checkout(root);
  // source/ goes stale: upstream moves on.
  await writeFile(join(upstream, 'README.md'), 'two');
  await git(upstream, 'commit', '-q', '-am', 'two');

  const path = worktreePathFor(source, 'as_1');
  assert.equal(path, join(root, 'projects/site/worktrees/as_1'));
  const made = await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT });
  assert.deepEqual(made, { path, branch: 'me/eng-1-fix', base: 'origin/main' });
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'two',
    'from the fetched remote tip, not stale source/',
  );
  assert.equal((await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'me/eng-1-fix');
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), 'one', 'source/ itself is untouched');

  assert.equal(
    (await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT })).base,
    'existing worktree',
  );

  // The worker pushed; a later worker on the same issue continues from upstream's branch.
  await writeFile(join(path, 'work.md'), 'progress');
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', 'progress');
  await git(path, 'push', '-q', '-u', 'origin', 'me/eng-1-fix');
  // While the first worktree still holds the branch, a new session continues in it (git allows one checkout per branch).
  const again = await ensureWorktree({
    source,
    path: worktreePathFor(source, 'as_2'),
    branch: 'me/eng-1-fix',
    identity: BOT,
  });
  assert.equal(await realpath(again.path), await realpath(path), 'git reports the holder by its real path');
  assert.equal(again.base, 'existing worktree');
  // Once that worktree is gone (pruned), the branch is picked up from upstream.
  await git(source, 'worktree', 'remove', '--force', path);
  const second = await ensureWorktree({
    source,
    path: worktreePathFor(source, 'as_2'),
    branch: 'me/eng-1-fix',
    identity: BOT,
  });
  assert.equal(second.base, 'origin/me/eng-1-fix');
  assert.equal(await readFile(join(second.path, 'work.md'), 'utf8'), 'progress');
});

test('a worker worktree says aivi launched it: the bot authors its commits and no co-author trailer follows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-worktree-mark-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source } = await checkout(root);
  const path = worktreePathFor(source, 'as_1');
  await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT });

  // The extension is a repository setting; git refuses per-worktree ones without it.
  assert.equal(await config(source, 'extensions.worktreeConfig'), 'true');
  // The three settings are this worktree's, and they are what the commit tool reads.
  assert.equal(await config(path, 'user.name'), BOT.name);
  assert.equal(await config(path, 'user.email'), BOT.email);
  assert.equal(await config(path, 'agent.autonomous'), 'true');
  assert.match(
    await readFile(join(await realpath(source), '.git', 'worktrees', 'as_1', 'config.worktree'), 'utf8'),
    /autonomous = true/,
    'they live in the worktree’s own config file, not the repository’s',
  );
  // The checkout stays as it was: a `worktree: false` lane keeps the attended behavior.
  const local = async (key: string) =>
    (await bare(source, 'config', '--local', '--get', key).catch(() => null))?.stdout.trim() ?? '';
  assert.equal(await local('agent.autonomous'), '', 'the checkout is not marked autonomous');
  assert.equal(await local('user.email'), '', 'and the checkout still commits as whoever runs it');

  // A commit made the ordinary way, by whoever owns the shell, is the bot's alone.
  await writeFile(join(path, 'fix.md'), 'fixed');
  await git(path, 'add', '.');
  await bare(path, 'commit', '-q', '-m', 'fixed');
  const author = (await git(path, 'log', '-1', '--format=%an <%ae>')).stdout.trim();
  assert.equal(author, `${BOT.name} <${BOT.email}>`);
  assert.equal(
    (await git(path, 'log', '-1', '--format=%cn <%ce>')).stdout.trim(),
    `${BOT.name} <${BOT.email}>`,
    'the bot is committer as well as author',
  );
});

test('a worktree kept from an earlier session is marked when a worker continues in it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-worktree-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source } = await checkout(root);
  const path = worktreePathFor(source, 'as_1');
  // Made by hand, as a worktree kept from before this change was: unmarked.
  await git(source, 'worktree', 'add', '-q', '-b', 'me/eng-1-fix', path);
  assert.equal(await config(path, 'agent.autonomous'), '');

  assert.equal(
    (await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT })).base,
    'existing worktree',
  );
  assert.equal(await config(path, 'agent.autonomous'), 'true');
  assert.equal(await config(path, 'user.email'), BOT.email);
});
