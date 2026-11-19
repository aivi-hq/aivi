import assert from 'node:assert/strict';
import { test } from 'node:test';
import { view } from '../src/orchestrator/ledger.ts';
import { calls, delegation, fails, fakeForge, lane, pull, repo, started, type World, world } from './orch-fixture.ts';

test('a delegation for a ticket that already has a live run starts nothing and takes no slot', async () => {
  const w = world();
  const run = await started(w);

  assert.deepEqual(await w.orchestrator.requestWork(delegation('t-1')), { runId: run.id, created: false });
  assert.equal(w.dispatcher.request.mock.callCount(), 1, 'only the first delegation asked the dispatcher');
});

test('a delegation naming a tracker nobody registered fails the run, says why and gives the slot back', async () => {
  const w = world();

  const { runId, created } = await w.orchestrator.requestWork(delegation('t-1', { trackerId: 'ghost' }));
  await w.log.next('endwork.no-tracker');

  assert.equal(created, true);
  const ended = w.ledger.get(runId)!;
  assert.equal(ended.state, 'failed');
  assert.deepEqual(ended.outcome, { kind: 'failure', reason: 'No tracker is registered for this work.' });
  assert.deepEqual(calls(w.dispatcher.release), [[ended.leaseId]], 'the slot went back once');
  assert.deepEqual(w.log.said('warn'), [{ level: 'warn', event: 'endwork.no-tracker', run: runId, tracker: 'ghost' }]);
});

test('a delegation that waited for a slot keeps its branch: the forge is asked about it when the run starts', async () => {
  const w = world();
  const forge = fakeForge();
  forge.prForBranch.does(async () => pull({ state: 'merged' }));
  w.forges.register(forge);
  w.dispatcher.script.push({ queued: 'req_1' });

  const waiting = await w.orchestrator.requestWork(delegation('t-1', { branch: 'me/t-1' }));
  assert.deepEqual(waiting, { runId: '', created: false, queued: 'req_1' });
  w.dispatcher.fulfil('req_1');
  await w.tracker.startWork.next();

  assert.deepEqual(calls(forge.prForBranch), [[repo, 'me/t-1']]);
  const [first] = w.opencode.session.prompt.mock.calls[0]!.arguments;
  assert.doesNotMatch(first.text, /returning work/, 'a merged pull request owes the new run nothing');
});

interface Waiting {
  name: string;
  /** What the request was for when it queued: a walk over the board, a delegation, or nothing the orchestrator knows. */
  queued: 'walk' | 'delegation' | 'unknown';
  /** What happened to the work while the request waited. */
  meanwhile: (w: World) => void;
  /** What the orchestrator says about it, if it says anything. */
  warned?: Record<string, unknown>;
}

const claimed = (w: World) =>
  w.ledger.request({ projectId: 'p', trackerId: 'test-tracker', ticketId: 't-1', lane: 'Doing', agent: 'dev' });
const workless = (w: World) => void w.lanes.splice(0, 1, lane('Doing'));
const dropped = (w: World) => void w.lanes.splice(0, 1);
const said = { request: 'req_1', ticket: 't-1', lane: 'Doing' };

const waitings: Waiting[] = [
  {
    name: 'a walk request whose lane lost its worker',
    queued: 'walk',
    meanwhile: workless,
    warned: { level: 'warn', event: 'claim.lane-workless', ticket: 't-1', lane: 'Doing' },
  },
  {
    name: 'a walk request whose lane left the config',
    queued: 'walk',
    meanwhile: dropped,
    warned: { level: 'warn', event: 'fulfill.lane-gone', ...said },
  },
  { name: 'a walk request whose ticket took a run in the meantime', queued: 'walk', meanwhile: claimed },
  {
    name: 'a delegation whose lane lost its worker',
    queued: 'delegation',
    meanwhile: workless,
    warned: { level: 'warn', event: 'fulfill.lane-workless', ...said },
  },
  {
    name: 'a delegation whose lane left the config',
    queued: 'delegation',
    meanwhile: dropped,
    warned: { level: 'warn', event: 'fulfill.lane-gone', ...said },
  },
  { name: 'a delegation whose ticket took a run in the meantime', queued: 'delegation', meanwhile: claimed },
  { name: 'a request nobody remembers asking', queued: 'unknown', meanwhile: () => {} },
];

for (const { name, queued, meanwhile, warned } of waitings) {
  test(`${name} gives the slot back unheard when the dispatcher grants it`, async () => {
    const w = world();
    w.dispatcher.script.push({ queued: 'req_1' });
    w.tracker.tickets.does(async () => [{ id: 't-1', blocked: false }]);
    if (queued === 'walk') await w.orchestrator.wake('p');
    if (queued === 'delegation') await w.orchestrator.requestWork(delegation('t-1'));
    meanwhile(w);

    const lease = w.dispatcher.fulfil(queued === 'unknown' ? 'req_unknown' : 'req_1');
    await (warned ? w.log.next(String(warned.event)) : w.dispatcher.release.next());

    assert.deepEqual(calls(w.dispatcher.release), [[lease.id]]);
    assert.equal(w.dispatcher.provide.mock.callCount(), 0, 'no worker was started');
    assert.deepEqual(w.log.said('warn'), warned ? [warned] : []);
  });
}

test('a person’s move cancels the queue place of that ticket only, and a granted place that was cancelled goes back', async () => {
  const w = world({ lanes: [lane('Doing', { agent: 'dev', pool: 'a' }), lane('Later', { agent: 'dev', pool: 'b' })] });
  w.tracker.tickets.does(async (_project, state) => [{ id: state === 'Doing' ? 't-1' : 't-2', blocked: false }]);
  w.dispatcher.script.push({ queued: 'req_later' }, { queued: 'req_doing' });
  await w.orchestrator.wake('p');

  w.orchestrator.cancelWaiting('test-tracker', 't-1');
  assert.deepEqual(calls(w.dispatcher.cancel), [['req_doing']], 'the other ticket keeps its place');

  const stale = w.dispatcher.fulfil('req_doing');
  assert.deepEqual(
    await w.dispatcher.release.next(),
    [stale.id],
    'the dispatcher granted it first: the slot goes back',
  );
  w.dispatcher.fulfil('req_later');
  await w.tracker.startWork.next();
  assert.equal(w.ledger.activeByTicket('test-tracker', 't-2')?.lane, 'Later', 'the place that stands starts its run');
});

test('a walk that fails is said in the log and the wake still ends', async () => {
  const w = world();
  const failure = new Error('the board is unreachable');
  w.tracker.tickets.does(fails(failure));

  await w.orchestrator.wake('p');

  assert.deepEqual(w.log.said('warn'), [{ level: 'warn', event: 'walk.failed', project: 'p', error: failure }]);
});

test('a queue pickup whose lane move fails ends the run visibly and gives the slot back', async () => {
  const w = world({ lanes: [lane('Todo', { queue: true }), lane('Doing', { agent: 'dev' })] });
  w.tracker.tickets.does(async (_project, state) => (state === 'Todo' ? [{ id: 't-1', blocked: false }] : []));
  w.tracker.moveTo.does(fails(new Error('the lane would not take it')));

  await w.orchestrator.wake('p');

  const [ended] = w.ledger.terminalSince('test-tracker', 0);
  assert.equal(ended?.state, 'failed');
  assert.deepEqual(ended?.outcome, {
    kind: 'failure',
    reason: 'Could not enter the worker lane: the lane would not take it',
  });
  assert.deepEqual(calls(w.dispatcher.release), [[ended?.leaseId]]);
  assert.equal(w.tracker.initWork.mock.callCount(), 0, 'the ticket was never opened on its platform');
});

test('the lookups find a registered tracker, and the run on a session or on a ticket', async () => {
  const w = world();
  assert.equal(w.orchestrator.tracker('test-tracker'), w.tracker);
  assert.equal(w.orchestrator.tracker('other-tracker'), undefined);
  const run = await started(w);

  assert.deepEqual(w.orchestrator.runBySession(run.sessionId!), view(run));
  assert.deepEqual(w.orchestrator.activeRun('test-tracker', 't-1'), view(run));
  assert.equal(w.orchestrator.runBySession('ses_unknown'), undefined);

  await w.orchestrator.stop(run.id, 'done with it');
  assert.equal(w.orchestrator.activeRun('test-tracker', 't-1'), undefined, 'an ended run is not live on its ticket');
  assert.equal(w.orchestrator.runBySession(run.sessionId!)?.state, 'cancelled', 'but its session still names it');
});
