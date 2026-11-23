import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lane, watched, world } from './orch-fixture.ts';

test('a worktree lane in a project with no forge makes its worktree from the refs the clone already holds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-orch-worktree-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  // No ref is held anywhere and main is the default; every other command succeeds.
  const git = watched(async (_cwd: string, args: string[]) => {
    const key = args.join(' ');
    if (key.startsWith('rev-parse --verify --quiet refs/')) return { ok: false as const, message: 'no such ref' };
    const stdout = key === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD' ? 'origin/main' : '';
    return { ok: true as const, stdout };
  });
  const w = world({ lanes: [lane('Doing', { agent: 'dev', worktree: true })], deps: { git, directory: () => source } });
  w.tracker.tickets.does(async () => [{ id: 't-1', blocked: false }]);
  w.tracker.initWork.does(async () => ({ summary: 'do t-1', branch: 'me/t-1' }));

  await w.orchestrator.wake('p');
  await w.tracker.startWork.next();

  const run = w.ledger.activeByTicket('test-tracker', 't-1')!;
  assert.ok(run.worktree?.startsWith(join(root, 'worktrees')), 'the run records the worktree it works in');
  assert.ok(
    git.mock.calls.some(
      ({ arguments: [cwd, args] }) =>
        cwd === source && args.join(' ') === `worktree add --quiet -b me/t-1 ${run.worktree} origin/main`,
    ),
    'a new branch from the remote default, as the clone holds it',
  );
  assert.deepEqual(
    w.log.said('info').find(line => line.event === 'worktree.ready'),
    { level: 'info', event: 'worktree.ready', branch: 'me/t-1', base: 'origin/main' },
    'no forge crossed to origin',
  );
  assert.deepEqual(w.dispatcher.provide.mock.calls[0]?.arguments[1], { agent: 'dev', directory: run.worktree });
});
