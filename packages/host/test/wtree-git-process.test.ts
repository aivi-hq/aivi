/** The worktree machinery's own crossing to git: what it runs when no test answers for it. `execFile` is a
 *  module mock, registered before the unit loads: the unit promisifies it once, at import. Nothing here
 *  starts a process. */
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { promisify } from 'node:util';

interface Spawned {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

/** What the mocked `execFile` was asked, and what it answers (the stdout git would print, or git's failure). */
const machine = {
  spawned: [] as Spawned[],
  answer: (_spawned: Spawned): string => '',
};

const execFile = Object.assign(
  () => {
    throw new Error('the unit promisifies execFile: the callback form is never used');
  },
  {
    [promisify.custom]: async (file: string, args: string[], options: Record<string, unknown>) => {
      const spawned = { file, args, options };
      machine.spawned.push(spawned);
      return { stdout: machine.answer(spawned), stderr: '' };
    },
  },
);
mock.module('node:child_process', { exports: { ...childProcess, execFile } });

const { ensureWorktree, globalGitConfig, removeWorktree } = await import('../src/orchestrator/worktree.ts');

const BOT = { name: 'aivi-agent[bot]', email: '331678708+aivi-agent[bot]@users.noreply.github.com' };

const gitSays = (answer: (spawned: Spawned) => string) => {
  machine.spawned.length = 0;
  machine.answer = answer;
};
const gitFails = (message: string) => () => {
  throw Object.assign(new Error(`Command failed: git\n${message}`), { stderr: message });
};
const scratch = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-worktree-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('with no git handed in, the worktree is made by `git -C <directory>`, on the host’s signal, from git’s trimmed answers', async t => {
  const root = await scratch(t);
  const source = join(root, 'projects/site/source');
  const path = join(root, 'projects/site/worktrees/as_1');
  const signal = new AbortController().signal;
  gitSays(({ args }) => {
    const key = args.slice(2).join(' ');
    if (key.startsWith('rev-parse --verify')) throw new Error('no such ref');
    return key === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD' ? 'origin/main\n' : '';
  });

  const made = await ensureWorktree({ source, path, branch: 'me/eng-1-fix', identity: BOT, signal });

  assert.deepEqual(made, { path, branch: 'me/eng-1-fix', base: 'origin/main' });
  assert.deepEqual(
    machine.spawned.map(({ file, args }) => [file, args[0], args[1], args.slice(2).join(' ')]),
    [
      ['git', '-C', source, 'worktree prune'],
      ['git', '-C', source, 'worktree list --porcelain'],
      ['git', '-C', source, 'rev-parse --verify --quiet refs/remotes/origin/me/eng-1-fix'],
      ['git', '-C', source, 'rev-parse --verify --quiet refs/heads/me/eng-1-fix'],
      ['git', '-C', source, 'symbolic-ref --quiet --short refs/remotes/origin/HEAD'],
      ['git', '-C', source, `worktree add --quiet -b me/eng-1-fix ${path} origin/main`],
      ['git', '-C', source, 'config extensions.worktreeConfig true'],
      ['git', '-C', path, 'config --worktree user.name aivi-agent[bot]'],
      ['git', '-C', path, 'config --worktree user.email 331678708+aivi-agent[bot]@users.noreply.github.com'],
      ['git', '-C', path, 'config --worktree agent.autonomous true'],
      ['git', '-C', path, 'config --worktree credential.helper '],
      ['git', '-C', path, 'config --worktree core.sshCommand false'],
    ],
  );
  assert.ok(
    machine.spawned.every(
      spawned => spawned.options.signal === signal && spawned.options.maxBuffer === 4 * 1024 * 1024,
    ),
    'every git call dies with the host and may print up to 4 MiB',
  );
});

test('a git that fails rejects with its own error, and a call made with no signal carries none', async t => {
  const root = await scratch(t);
  gitSays(gitFails('fatal: not a git repository'));

  await assert.rejects(
    removeWorktree(join(root, 'source'), join(root, 'worktrees/as_1')),
    /fatal: not a git repository/,
  );
  assert.deepEqual(
    machine.spawned.map(({ file, args, options }) => [file, args.slice(2).join(' '), options]),
    [['git', 'worktree prune', { maxBuffer: 4 * 1024 * 1024 }]],
  );
});

test('the machine’s git config answers a key trimmed, and answers nothing when git has no value or cannot run', async () => {
  gitSays(() => ' Ada Lovelace \n');
  assert.equal(await globalGitConfig('user.name'), 'Ada Lovelace');
  assert.deepEqual(machine.spawned, [
    { file: 'git', args: ['config', '--global', '--get', 'user.name'], options: { maxBuffer: 64 * 1024 } },
  ]);

  gitSays(gitFails('exit status 1: the key is not set'));
  assert.equal(await globalGitConfig('user.email'), '');
});
