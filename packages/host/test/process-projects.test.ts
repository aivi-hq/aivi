/** The project sync's edges as a unit: the git it runs when nothing else is
 *  handed in, what it says when git or a forge fails, and a sync that is
 *  stopped. `execFile` is replaced before the sync is loaded, so the default
 *  runner reaches a script, never git. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import { Forges } from '../src/forges.ts';
import type { ProjectGit } from '../src/projects.ts';

const site = { id: 'site', directory: '/work/projects/site/source' };

/** Every `git` the default runner starts, on record, answered from `replies` by the command it runs. */
function gitOnRecord(t: TestContext, replies: Record<string, string> = {}) {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const execFile = Object.assign(
    () => {
      throw new Error('the callback form is not used');
    },
    {
      [promisify.custom]: async (file: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ file, args, options });
        return { stdout: replies[args.slice(2).join(' ')] ?? '', stderr: '' };
      },
    },
  );
  const property = t.mock.property(childProcess, 'execFile', execFile as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    property.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

test('without a runner of its own the sync runs git in the project, trims what it says, and lets the signal stop it', async t => {
  const calls = gitOnRecord(t, { 'status --porcelain': ' M docs/a.md\n' });
  const { syncProjects } = await import('../src/projects.ts');
  const controller = new AbortController();
  assert.deepEqual(await syncProjects([site], new Forges()), [
    { id: 'site', state: 'skipped', reason: 'local changes in source/' },
  ]);
  await syncProjects([site], new Forges(), controller.signal);
  const status = ['-C', site.directory, 'status', '--porcelain'];
  assert.deepEqual(
    calls.map(call => [call.file, call.args]),
    [
      ['git', status],
      ['git', status],
    ],
  );
  assert.deepEqual(calls[0]!.options, { maxBuffer: 4 * 1024 * 1024 }, 'no signal given, none passed on');
  assert.deepEqual(calls[1]!.options, { maxBuffer: 4 * 1024 * 1024, signal: controller.signal });
});

test('a git that fails, or a forge that cannot answer, is a skip with its message, never a failed sync', async () => {
  const { syncProjects } = await import('../src/projects.ts');
  const broken: ProjectGit = async () => {
    throw new Error('fatal: not a git repository');
  };
  assert.deepEqual(await syncProjects([site], new Forges(), undefined, broken), [
    { id: 'site', state: 'skipped', reason: 'fatal: not a git repository' },
  ]);
  const forges = new Forges();
  forges.register({
    async repoFor() {
      throw new Error('the forge is unreachable');
    },
  } as never);
  assert.deepEqual(await syncProjects([site], forges, undefined, broken), [
    { id: 'site', state: 'skipped', reason: 'the forge is unreachable' },
  ]);
});

const owned = (answer: unknown) => {
  const forges = new Forges();
  forges.register({
    async repoFor() {
      return { id: 'acme/site', remote: 'https://github.com/acme/site' };
    },
    async syncSource() {
      return answer;
    },
  } as never);
  return forges;
};
const forgeAnswers: [string, unknown, unknown][] = [
  [
    'held, with its reason',
    { state: 'held', reason: 'diverged' },
    { id: 'site', state: 'skipped', reason: 'diverged' },
  ],
  ['held, without one', { state: 'held' }, { id: 'site', state: 'skipped' }],
  [
    'updated, with where it moved',
    { state: 'updated', from: 'a1', to: 'b2' },
    { id: 'site', state: 'updated', from: 'a1', to: 'b2' },
  ],
  ['updated, without where', { state: 'updated' }, { id: 'site', state: 'updated' }],
  ['current', { state: 'current', from: 'a1', to: 'a1' }, { id: 'site', state: 'current', from: 'a1', to: 'a1' }],
];
for (const [name, answer, expected] of forgeAnswers)
  test(`a forge that answers ${name} is reported as it said, nothing more`, async () => {
    const { syncProjects } = await import('../src/projects.ts');
    assert.deepEqual(await syncProjects([site], owned(answer), undefined, async () => ''), [expected]);
  });

test('a sync that is stopped visits no project and says so', async () => {
  const { syncProjects } = await import('../src/projects.ts');
  const asked: string[] = [];
  const git: ProjectGit = async (directory, args) => {
    asked.push(`${directory} ${args.join(' ')}`);
    return '';
  };
  await assert.rejects(syncProjects([site], new Forges(), AbortSignal.abort(), git), { name: 'AbortError' });
  assert.deepEqual(asked, []);
});
