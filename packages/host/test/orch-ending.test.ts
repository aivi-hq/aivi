import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  call,
  calls,
  delegation,
  fails,
  type GitAnswers,
  lane,
  scriptedGit,
  seeded,
  started,
  world,
} from './orch-fixture.ts';

const success = { outcome: 'success', summary: 'done' };
const twoLanes = () => [lane('Doing', { agent: 'dev' }), lane('Review', { agent: 'dev' })];

test('a run whose tracker is not registered still ends: no platform is told, the walk has no board and no move is made', async () => {
  const w = world({ lanes: twoLanes() });
  const run = seeded(w, { trackerId: 'ghost' });

  assert.deepEqual(await w.orchestrator.planTool(call(run, { steps: [{ content: 'Look', status: 'pending' }] })), {
    recorded: true,
    steps: 1,
  });
  assert.deepEqual(await w.orchestrator.completeTool(call(run, success)), { recorded: true, outcome: 'success' });

  assert.equal(w.ledger.get(run.id)?.state, 'completed');
  assert.deepEqual(
    w.log.said('warn').map(({ event, run, tracker }) => ({ event, run, tracker })),
    ['stage.no-tracker', 'endwork.no-tracker', 'move.no-tracker'].map(event => ({
      event,
      run: run.id,
      tracker: 'ghost',
    })),
  );
  const asked = [w.tracker.plan, w.tracker.endWork, w.tracker.moveTo, w.tracker.tickets];
  assert.deepEqual(
    asked.map(stage => stage.mock.callCount()),
    [0, 0, 0, 0],
    'the registered tracker was not asked about a run that is not its own',
  );
});

test('a render stage that fails is said in the log and the run goes on', async () => {
  const w = world();
  const run = seeded(w);
  const failure = new Error('the platform said no');
  w.tracker.plan.does(fails(failure));

  const plan = { steps: [{ content: 'Look', status: 'pending' }] };
  assert.deepEqual(await w.orchestrator.planTool(call(run, plan)), { recorded: true, steps: 1 });

  assert.deepEqual(await w.log.next('stage.failed'), {
    level: 'warn',
    event: 'stage.failed',
    run: run.id,
    stage: 'plan',
    error: failure,
  });
  assert.equal(w.ledger.get(run.id)?.state, 'working');
});

const moves = [
  {
    name: 'a move that misses once lands on the next attempt, and the debt is paid',
    misses: 1,
    attempts: 2,
    retried: [1],
    errors: [],
    owed: 0,
  },
  {
    name: 'a move that never lands is said after the third miss, and stays owed to the next boot',
    misses: Number.POSITIVE_INFINITY,
    attempts: 3,
    retried: [1, 2],
    errors: ['move.failed'],
    owed: 1,
  },
];

for (const { name, misses, attempts, retried, errors, owed } of moves) {
  test(name, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world({ lanes: twoLanes() });
    const run = seeded(w);
    let missing = misses;
    w.tracker.moveTo.does(async () => {
      if (missing-- > 0) throw new Error('the board is busy');
    });

    const ending = w.orchestrator.completeTool(call(run, success));
    for (const wait of [5_000, 10_000].slice(0, attempts - 1)) {
      await w.log.next('move.retrying');
      t.mock.timers.tick(wait);
    }
    await ending;

    assert.deepEqual(calls(w.tracker.moveTo), Array(attempts).fill(['p', 't-1', 'Review']));
    assert.deepEqual(
      w.log.said('warn').map(line => line.attempt),
      retried,
    );
    assert.deepEqual(
      w.log.said('error').map(line => line.event),
      errors,
    );
    assert.equal(w.ledger.moveOwed('test-tracker').length, owed);
  });
}

test('closing words that cannot be said do not hold the ticket: it still moves and the slot still returns', async () => {
  const w = world({ lanes: twoLanes() });
  const run = await started(w);
  const failure = new Error('the platform said no');
  w.tracker.endWork.does(fails(failure));

  await w.orchestrator.completeTool(call(run, success));

  assert.deepEqual(w.log.said('error'), [
    { level: 'error', event: 'endwork.failed', run: run.id, ticket: 't-1', error: failure },
  ]);
  assert.deepEqual(calls(w.tracker.moveTo), [['p', 't-1', 'Review']]);
  assert.deepEqual(calls(w.dispatcher.release), [[run.leaseId]]);
});

const spent = [
  { name: 'a person moved the ticket somewhere else', lane: async () => 'Backlog', where: 'Backlog' },
  { name: 'the ticket is gone from the board', lane: async () => undefined, where: 'gone from the board' },
];

for (const { name, lane: currently, where } of spent) {
  test(`an ending move is spent, not undone, when ${name}`, async () => {
    const w = world({ lanes: twoLanes() });
    const run = seeded(w);
    w.tracker.ticketLane.does(currently);

    await w.orchestrator.completeTool(call(run, success));

    assert.equal(w.tracker.moveTo.mock.callCount(), 0, 'their move wins');
    assert.deepEqual(
      w.log.said('info').filter(line => line.event === 'move.canceled'),
      [{ level: 'info', event: 'move.canceled', run: run.id, ticket: 't-1', to: 'Review', where }],
    );
    assert.equal(w.ledger.moveOwed('test-tracker').length, 0, 'the debt is paid');
  });
}

test('boot recovery fails a run that was still preparing, saying it could not be resumed', async () => {
  const w = world();
  const { run } = w.ledger.request({
    projectId: 'p',
    trackerId: 'test-tracker',
    ticketId: 't-1',
    lane: 'Doing',
    agent: 'dev',
  });

  await w.orchestrator.recover();

  const ended = w.ledger.get(run.id);
  assert.equal(ended?.state, 'failed');
  assert.deepEqual(ended?.outcome, {
    kind: 'failure',
    reason: 'The run was preparing when aivi stopped and could not be resumed.',
  });
  assert.equal(w.tracker.endWork.mock.callCount(), 1);
});

test('boot recovery watches a run with a session again: its events keep the lease alive and a failed execution ends it', async () => {
  const w = world();
  const run = seeded(w);
  w.ledger.setLease(run.id, 'lease_9');
  await w.orchestrator.recover();

  w.events.emit(run.sessionId!, 'session.execution.failed', { error: { message: 'the provider died' } });
  await w.tracker.endWork.next();

  assert.deepEqual(calls(w.dispatcher.activity), [['lease_9']]);
  assert.deepEqual(w.ledger.get(run.id)?.outcome, {
    kind: 'failure',
    reason: "The worker's execution failed: the provider died",
  });
});

test('boot recovery re-arms the keep-alive of a parked run: the slot goes back after the wait, not before', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world({ deps: { keepAliveMs: 1_000 } });
  const run = seeded(w);
  const lease = w.dispatcher.grant({});
  w.ledger.setLease(run.id, lease.id);
  w.ledger.awaiting(run.id);
  await w.orchestrator.recover();
  assert.equal(w.dispatcher.release.mock.callCount(), 0);

  t.mock.timers.tick(1_000);
  await w.log.next('elicitation.waiting');

  assert.deepEqual(calls(w.dispatcher.release), [[lease.id]]);
  const parked = w.ledger.get(run.id);
  assert.equal(parked?.state, 'awaiting_input', 'the wait goes on without the slot');
  assert.equal(parked?.leaseId, undefined);
});

test('boot recovery drives again the moves that were still owed when aivi died', async () => {
  const w = world({ lanes: twoLanes() });
  const run = seeded(w);
  w.ledger.finish(run.id, { kind: 'success', summary: 'done' }, 'Review');

  await w.orchestrator.recover();

  assert.deepEqual(await w.tracker.moveTo.next(), ['p', 't-1', 'Review']);
});

test('a lease the dispatcher ends after its run already ended clears nothing', async () => {
  const w = world();

  await w.orchestrator.leaseEnded(w.dispatcher.grant({}), 'its session said nothing for longer than the idle timeout');

  assert.equal(w.tracker.endWork.mock.callCount(), 0);
  assert.deepEqual(w.log.said('warn'), []);
});

test('a lease the dispatcher gave up on fails its run with the reason and the code, and releases nothing twice', async () => {
  const w = world();
  const run = seeded(w);
  const lease = w.dispatcher.grant({});
  w.ledger.setLease(run.id, lease.id);
  w.dispatcher.held.delete(lease.id); // the dispatcher ended it itself

  await w.orchestrator.leaseEnded(lease, 'the session did not stop after 3 kill attempts', 'kill-unconfirmed');

  const outcome = {
    kind: 'failure',
    reason: 'The dispatcher ended the lease: the session did not stop after 3 kill attempts',
    code: 'kill-unconfirmed',
  };
  assert.equal(w.ledger.get(run.id)?.state, 'failed');
  assert.deepEqual(w.ledger.get(run.id)?.outcome, outcome);
  assert.deepEqual(w.tracker.endWork.mock.calls[0]?.arguments[0].outcome, outcome, 'the tracker hears the code');
  assert.equal(w.dispatcher.release.mock.callCount(), 0);
});

test('a stop for a run that is not live does nothing', async () => {
  const w = world();
  const run = seeded(w);
  await w.orchestrator.completeTool(call(run, { outcome: 'failure', summary: 'stuck' }));

  await w.orchestrator.stop('run_unknown', 'no reason');
  await w.orchestrator.stop(run.id, 'a late stop');

  assert.equal(w.opencode.session.interrupt.mock.callCount(), 0);
  assert.equal(w.ledger.get(run.id)?.state, 'failed', 'the ended run stays what it ended as');
  assert.equal(w.tracker.endWork.mock.callCount(), 1, 'only the completion said its closing words');
});

test('a stop reaches a parked run, even mid-question, and takes back its slot', async () => {
  const w = world();
  const run = await started(w);
  await w.orchestrator.askTool(call(run, { question: 'Which shade?' }));

  await w.orchestrator.stop(run.id, 'not needed any more');

  const ended = w.ledger.get(run.id);
  assert.equal(ended?.state, 'cancelled');
  assert.deepEqual(ended?.outcome, { kind: 'failure', reason: 'not needed any more' });
  assert.deepEqual(calls(w.opencode.session.interrupt), [[{ sessionID: run.sessionId }]]);
  assert.deepEqual(calls(w.dispatcher.release), [[run.leaseId]]);
});

test('a stop OpenCode would not answer ends the run carrying stop-unconfirmed, and says so', async () => {
  const w = world();
  const run = seeded(w);
  const failure = new Error('OpenCode is down');
  w.opencode.session.interrupt.does(fails(failure));

  await w.orchestrator.stop(run.id, 'changed my mind');

  assert.deepEqual(w.ledger.get(run.id)?.outcome, {
    kind: 'failure',
    reason: 'changed my mind',
    code: 'stop-unconfirmed',
  });
  assert.deepEqual(w.log.said('warn'), [{ level: 'warn', event: 'run.interrupt.failed', run: run.id, error: failure }]);
});

test('a failed start that lands after the run was stopped changes nothing: the stop is what the run ended as', async () => {
  const w = world();
  const prompting = Promise.withResolvers<void>();
  w.opencode.session.prompt.does(() => prompting.promise);
  const { runId } = await w.orchestrator.requestWork(delegation('t-1'));
  await w.opencode.session.prompt.next();
  await w.orchestrator.stop(runId, 'changed my mind');

  prompting.reject(new Error('OpenCode went away'));
  await w.log.next('run.prepare.failed');

  assert.equal(w.ledger.get(runId)?.state, 'cancelled', 'the stop is what the run ended as');
  assert.deepEqual(w.ledger.get(runId)?.outcome, { kind: 'failure', reason: 'changed my mind' });
  assert.equal(w.tracker.endWork.mock.callCount(), 1);
});

test('a run whose lane the config dropped ends without a move: unconfigured is silent', async () => {
  const w = world();
  const run = seeded(w);
  w.lanes.length = 0;

  await w.orchestrator.completeTool(call(run, success));

  assert.equal(w.ledger.get(run.id)?.state, 'completed');
  assert.equal(w.ledger.get(run.id)?.targetLane, undefined);
  assert.equal(w.tracker.moveTo.mock.callCount(), 0);
});

const cleanups = [
  {
    name: 'removes the worktree it worked in and says so',
    marked: false,
    git: (): GitAnswers => ({ 'worktree prune': '' }),
    said: (run: string, path: string) => ({ level: 'info', event: 'worktree.cleaned', run, path }),
  },
  {
    name: 'names the branch that would not go with its worktree',
    marked: true,
    git: (path: string): GitAnswers => ({
      'rev-parse --abbrev-ref --quiet HEAD': 'me/t-1',
      [`worktree remove --force ${path}`]: '',
      'branch -D me/t-1': { fail: 'checked out elsewhere' },
    }),
    said: (run: string, path: string) => ({
      level: 'warn',
      event: 'worktree.branch.left',
      run,
      branch: 'me/t-1',
      path,
    }),
  },
  {
    name: 'names the path that stayed when git refuses',
    marked: false,
    git: (): GitAnswers => ({ 'worktree prune': { fail: 'fatal: not a git repository' } }),
    said: (run: string, path: string) => ({
      level: 'error',
      event: 'worktree.cleanup.failed',
      run,
      path,
      error: new Error('fatal: not a git repository'),
    }),
  },
];

for (const { name, marked, git, said } of cleanups) {
  test(`a stopped run ${name}`, async t => {
    const path = await mkdtemp(join(tmpdir(), 'aivi-orch-worktree-'));
    t.after(() => rm(path, { recursive: true, force: true }));
    if (marked) await writeFile(join(path, '.git'), 'gitdir: elsewhere');
    const w = world({ deps: { git: scriptedGit(git(path)) } });
    const run = seeded(w, { directory: path });

    await w.orchestrator.stop(run.id, 'done with it');

    const line = said(run.id, path);
    assert.deepEqual(
      w.log.said(line.level).filter(({ event }) => event === line.event),
      [line],
    );
  });
}

test('a stopped run in the checkout leaves the checkout alone: no stop may touch it', async () => {
  const git = scriptedGit({});
  const w = world({ deps: { git } });
  const run = seeded(w);

  await w.orchestrator.stop(run.id, 'done with it');

  assert.equal(git.mock.callCount(), 0);
});
