/** The orchestrator's own crossing to git: what it runs when no test answers for it. `execFile` is replaced while
 *  the unit loads, because the unit promisifies it once, at import, and put back after. Nothing here starts a process. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

interface Spawned {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

/** What the replaced `execFile` was asked, and what it answers: the stdout git would print, or git's failure. */
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
const replaced = mock.property(childProcess, 'execFile', execFile as unknown as typeof childProcess.execFile);
syncBuiltinESMExports();

const { call, fakeForge, seeded, world } = await import('./orch-fixture.ts');

replaced.mock.restore();
syncBuiltinESMExports();

/** Git answers by its arguments, after `-C <directory>`; a command that is not named prints nothing. */
const gitSays = (answers: Record<string, string>) => {
  machine.spawned.length = 0;
  machine.answer = ({ args }) => {
    const key = args.slice(2).join(' ');
    if (answers[key] === undefined) return '';
    if (answers[key] === 'fails') throw new Error(`Command failed: git ${key}`);
    return answers[key];
  };
};

const remote = 'refs/remotes/origin/me/t-1';
const diverged = {
  'symbolic-ref --quiet --short HEAD': 'me/t-1\n',
  'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main\n',
  [`rev-parse --verify --quiet ${remote}`]: 'the-tip\n',
  [`rev-list --count ${remote}..HEAD`]: '2',
  [`rev-list --count HEAD..${remote}`]: '1',
  [`cherry HEAD ${remote}`]: '+ abc111',
};

test('with no git handed in, the tools read git through `git -C <directory>` and trim what it prints', async () => {
  const w = world();
  w.forges.register(fakeForge());
  const run = seeded(w);
  gitSays({
    'symbolic-ref --quiet --short HEAD': 'me/t-1\n',
    [`rev-parse --verify --quiet ${remote}`]: 'fails',
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main\n',
    'rev-list --count HEAD..refs/remotes/origin/main': '3\n',
  });

  assert.deepEqual(await w.orchestrator.syncTool(call(run)), {
    synced: true,
    branch: 'me/t-1',
    remoteBranch: 'absent',
    defaultBranch: 'main',
    defaultBehind: '3',
  });

  assert.deepEqual(
    machine.spawned.map(({ file, args }) => [file, args[0], args[1], args.slice(2).join(' ')]),
    [
      ['git', '-C', '/checkout', 'symbolic-ref --quiet --short HEAD'],
      ['git', '-C', '/checkout', `rev-parse --verify --quiet ${remote}`],
      ['git', '-C', '/checkout', 'symbolic-ref --quiet --short refs/remotes/origin/HEAD'],
      ['git', '-C', '/checkout', 'rev-list --count HEAD..refs/remotes/origin/main'],
    ],
  );
  assert.ok(
    machine.spawned.every(({ options }) => JSON.stringify(options) === JSON.stringify({ maxBuffer: 1024 * 1024 })),
    'a read may print up to 1 MiB, and carries no signal',
  );
});

test('a git that fails is no answer: the tool sees a detached HEAD, not an error', async () => {
  const w = world();
  w.forges.register(fakeForge());
  const run = seeded(w);
  gitSays({ 'symbolic-ref --quiet --short HEAD': 'fails' });

  assert.deepEqual(await w.orchestrator.syncTool(call(run)), {
    synced: true,
    note: 'detached HEAD: refs are fresh, no branch to count against',
  });
});

test('the push merges a person’s work in through the same git, and pushes through the forge', async () => {
  const w = world();
  const forge = fakeForge();
  w.forges.register(forge);
  const run = seeded(w);
  gitSays({ ...diverged, [`merge --no-edit --quiet ${remote}`]: '' });

  assert.deepEqual(await w.orchestrator.pushTool(call(run)), { pushed: true, branch: 'me/t-1' });

  assert.ok(machine.spawned.some(({ args }) => args.slice(2).join(' ') === `merge --no-edit --quiet ${remote}`));
  assert.equal(forge.push.mock.callCount(), 1);
});

test('a merge git refuses reaches the worker in git’s own words', async () => {
  const w = world();
  w.forges.register(fakeForge());
  const run = seeded(w);
  gitSays({ ...diverged, [`merge --no-edit --quiet ${remote}`]: 'fails' });

  await assert.rejects(() => w.orchestrator.pushTool(call(run)), {
    status: 409,
    message: `Could not merge origin/me/t-1: Command failed: git merge --no-edit --quiet ${remote}`,
  });
});

test('a stop cleans the worktree through the same git, which dies with the host', async () => {
  const signal = new AbortController().signal;
  const w = world({ deps: { signal } });
  const run = seeded(w, { directory: join(tmpdir(), 'aivi-orch-no-such-worktree') });
  gitSays({});

  await w.orchestrator.stop(run.id, 'done with it');

  assert.deepEqual(machine.spawned, [
    { file: 'git', args: ['-C', '/checkout', 'worktree', 'prune'], options: { maxBuffer: 1024 * 1024, signal } },
  ]);
});
