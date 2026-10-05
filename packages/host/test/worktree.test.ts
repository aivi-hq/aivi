/** The worktree machinery as a unit: its decisions are what these tests pin —
 *  which ref a worktree starts from, which holder a second session continues,
 *  what the mark writes, what a stop deletes and what it names when it
 *  cannot. Every git call is on record with the directory it ran in; whether
 *  git really checks files out and prunes directories is git's own unit and
 *  the live gate's subject (`npm run smoke`). A test that spawns git ten
 *  times to learn git behaves like git pays for nothing. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { ensureWorktree, removeWorktree, type WorktreeGit, worktreePathFor } from '../src/orchestrator/worktree.ts';

const BOT = { name: 'aivi-agent[bot]', email: '331678708+aivi-agent[bot]@users.noreply.github.com' };

/** git as the worktree machinery sees it: every call on record — the
 *  directory it ran in and its argv — and every answer the test scripts. A
 *  call nobody scripted fails loudly: the record is the assertion. */
type Reply = string | { fail: string };
const scriptedGit = (answer: (cwd: string, args: string[]) => Reply | undefined) => {
  const calls: { cwd: string; args: string[] }[] = [];
  const git: WorktreeGit = async (cwd, args) => {
    calls.push({ cwd, args });
    const reply = answer(cwd, args);
    if (reply === undefined)
      throw new Error(`the worktree machinery ran git ${args.join(' ')}; the test scripted no answer`);
    if (typeof reply !== 'string') throw new Error(reply.fail);
    return reply;
  };
  return { git, calls };
};

/** The plain answers an empty repository gives: no worktrees, no refs, main
 *  is the default. Tests override what their scenario is about. */
const empty =
  () =>
  (_cwd: string, args: string[]): Reply | undefined => {
    const key = args.join(' ');
    if (key === 'worktree prune') return '';
    if (key === 'worktree list --porcelain') return '';
    if (key.startsWith('rev-parse')) return { fail: 'no such ref' };
    if (key === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') return 'origin/main';
    if (key.startsWith('worktree add')) return '';
    if (key.startsWith('worktree remove')) return '';
    if (key.startsWith('branch -D')) return '';
    if (key.startsWith('config')) return '';
    return undefined;
  };

const scratch = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source: join(root, 'projects/site/source') };
};

test('a worker worktree starts from the remote tip the forge fetched, on the ticket’s branch', async t => {
  const { root, source } = await scratch(t);
  const path = worktreePathFor(source, 'as_1');
  assert.equal(path, join(root, 'projects/site/worktrees/as_1'), 'one run’s worker works under worktrees/');
  const fetched: string[] = [];
  const { git, calls } = scriptedGit(empty());

  const made = await ensureWorktree({
    source,
    path,
    branch: 'me/eng-1-fix',
    identity: BOT,
    fetchBranch: async (branch: string) => void fetched.push(branch),
    git,
  });
  assert.deepEqual(made, { path, branch: 'me/eng-1-fix', base: 'origin/main' });
  assert.deepEqual(fetched, ['me/eng-1-fix'], 'the remote tip arrives by crossing the forge, never origin itself');
  assert.ok(
    !calls.some(call => call.args[0] === 'fetch'),
    'a stale source/ never matters where a forge owns the remote: this code never reaches origin',
  );
  assert.ok(
    calls.some(call => call.args.join(' ') === `worktree add --quiet -b me/eng-1-fix ${path} origin/main`),
    'a branch nowhere yet starts from the remote default',
  );
});

test('a branch that exists upstream is continued from the fetched tip, not from stale source/', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_1');
  const { git, calls } = scriptedGit((cwd, args) => {
    const base = empty()(cwd, args);
    if (args.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/me/eng-1-fix') return 'the-tip';
    return base;
  });
  const made = await ensureWorktree({
    source,
    path,
    branch: 'me/eng-1-fix',
    identity: BOT,
    fetchBranch: async () => {},
    git,
  });
  assert.equal(made.base, 'origin/me/eng-1-fix', 'a second worker on the same issue continues it');
  assert.ok(
    calls.some(call => call.args.join(' ') === `worktree add --quiet -B me/eng-1-fix ${path} origin/me/eng-1-fix`),
    '-B over the fetched ref: the worktree lands on the remote’s truth',
  );
});

test('without the forge fetch the worktree starts from refs the clone already holds — a broken origin never matters', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_1');
  const { git, calls } = scriptedGit(empty());
  // No fetchBranch injected: this is the local-git case, and the only proof
  // that matters is that nothing reaches the remote (ruled 2026-10-02).
  const made = await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT, git });
  assert.equal(made.base, 'origin/main', 'the ref the clone holds decides the base; stale is honest');
  assert.ok(!calls.some(call => call.args[0] === 'fetch'), 'no bytes cross: this code reads refs, never remotes');
});

test('an existing worktree at the path is reused as it is, and re-marked', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_1');
  await mkdir(join(path, '.git'), { recursive: true }); // a worktree kept from an earlier session
  const { git, calls } = scriptedGit(empty());
  const made = await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT, git });
  assert.equal(made.base, 'existing worktree');
  assert.ok(!calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'add'), 'nothing is checked out again');
  assert.ok(
    calls.some(call => call.args.join(' ') === 'config --worktree agent.autonomous true'),
    'a worktree kept from an earlier session is marked too: written on every use',
  );
});

test('a worktree elsewhere that holds the branch continues it — git allows one checkout per branch', async t => {
  const { source } = await scratch(t);
  const holder = worktreePathFor(source, 'as_0');
  const { git } = scriptedGit((cwd, args) => {
    if (args.join(' ') === 'worktree list --porcelain') return `worktree ${holder}\nbranch refs/heads/me/eng-1-fix`;
    return empty()(cwd, args);
  });
  const again = await ensureWorktree({
    source,
    path: worktreePathFor(source, 'as_2'),
    branch: 'me/eng-1-fix',
    identity: BOT,
    git,
  });
  assert.equal(again.path, holder, 'the new session continues in the holder, with its uncommitted work');
  assert.equal(again.base, 'existing worktree');
});

test('a worker worktree says aivi launched it: the mark rides in the worktree’s own config', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_1');
  const { git, calls } = scriptedGit(empty());
  await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT, git });

  const marks = calls.filter(call => call.args[0] === 'config');
  assert.deepEqual(
    marks.map(call => [call.cwd, call.args.join(' ')]),
    [
      [source, 'config extensions.worktreeConfig true'],
      [path, 'config --worktree user.name aivi-agent[bot]'],
      [path, 'config --worktree user.email 331678708+aivi-agent[bot]@users.noreply.github.com'],
      [path, 'config --worktree agent.autonomous true'],
      [path, 'config --worktree credential.helper '],
      [path, 'config --worktree core.sshCommand false'],
    ],
    'the extension first — git refuses per-worktree settings without it — then the five settings the commit tool ' +
      'reads: the bot authors and commits, no co-author trailer follows, and a boundary git that slips past the ' +
      "tools has no credential to spend: an empty helper removes the machine's chain, ssh goes to the false binary",
  );
  assert.ok(
    marks.slice(1).every(call => call.cwd === path),
    'the five settings are the worktree’s, never the repository’s',
  );
});

test('removeWorktree takes a stopped attempt down: the directory goes, the local branch goes with it', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_stop');
  await mkdir(join(path, '.git'), { recursive: true });
  const { git, calls } = scriptedGit((cwd, args) => {
    if (cwd === path && args.join(' ') === 'rev-parse --abbrev-ref --quiet HEAD') return 'me/eng-9';
    return empty()(cwd, args);
  });
  assert.equal(await removeWorktree(source, path, undefined, git), undefined, 'the branch went with the worktree');
  assert.deepEqual(
    calls.map(call => call.args.join(' ')),
    ['rev-parse --abbrev-ref --quiet HEAD', `worktree remove --force ${path}`, 'branch -D me/eng-9'],
    'directory first, then the local branch: what was pushed stays pushed, this machine’s attempt ends',
  );

  // Removing what is already gone is quiet, and lets git forget the
  // registration: the next ensureWorktree starts from the clone's truth.
  await rm(path, { recursive: true, force: true });
  const gone = scriptedGit(empty());
  assert.equal(
    await removeWorktree(source, path, undefined, gone.git),
    undefined,
    'a worktree already gone is no error',
  );
  assert.deepEqual(
    gone.calls.map(call => call.args.join(' ')),
    ['worktree prune'],
  );
});

test('a detached worktree loses its directory and holds no branch to delete', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_det');
  await mkdir(join(path, '.git'), { recursive: true });
  const { git, calls } = scriptedGit((cwd, args) => {
    if (cwd === path && args.join(' ') === 'rev-parse --abbrev-ref --quiet HEAD') return 'HEAD';
    return empty()(cwd, args);
  });
  assert.equal(await removeWorktree(source, path, undefined, git), undefined);
  assert.ok(
    !calls.some(call => call.args[0] === 'branch'),
    'detached, the worktree owns no branch: the teardown deletes nobody else’s name',
  );
});

test('a branch held by another worktree is named by the teardown, never swallowed', async t => {
  const { source } = await scratch(t);
  const path = worktreePathFor(source, 'as_held');
  await mkdir(join(path, '.git'), { recursive: true });
  const { git } = scriptedGit((cwd, args) => {
    const key = args.join(' ');
    if (cwd === path && key === 'rev-parse --abbrev-ref --quiet HEAD') return 'me/eng-11';
    if (key === 'branch -D me/eng-11') return { fail: 'error: cannot delete branch: checked out at another worktree' };
    return empty()(cwd, args);
  });
  assert.equal(
    await removeWorktree(source, path, undefined, git),
    'me/eng-11',
    'the leftover branch is answered, and the caller says so',
  );
});
