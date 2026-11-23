import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { ToolError } from '../src/tools.ts';
import { call, calls, fails, started, world } from './orch-fixture.ts';

/** A run that asked a question and whose keep-alive rang: parked, claim standing, no slot. */
async function parked(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world({ deps: { keepAliveMs: 1_000 } });
  const run = await started(w);
  await w.orchestrator.askTool(call(run, { question: 'Which shade?' }));
  t.mock.timers.tick(1_000);
  await w.log.next('elicitation.waiting');
  await w.dispatcher.release.next();
  return { w, run: w.ledger.get(run.id)! };
}

test('an answer for a session that is not an aivi run is refused', async () => {
  const w = world();

  await assert.rejects(
    () => w.orchestrator.answer('ses_unknown', 'hello'),
    (error: unknown) =>
      error instanceof ToolError && error.status === 404 && error.message === 'This session is not an aivi run.',
  );
});

test('an answer with no form id wakes the parked run through a pool-less lane and tells the worker the words', async t => {
  const { w, run } = await parked(t);

  assert.deepEqual(await w.orchestrator.answer(run.sessionId!, 'the deep one'), { resumed: true });

  assert.deepEqual(
    w.dispatcher.request.mock.calls.at(-1)?.arguments,
    [{ service: 'orchestrator', resume: run.sessionId }],
    'the session’s own pool decides: the lane names none',
  );
  const [sent] = await w.opencode.session.prompt.next();
  assert.equal(sent.text, 'The person answered your question: the deep one');
  assert.equal(sent.delivery, 'queue');
  assert.equal(w.opencode.session.form.reply.mock.callCount(), 0, 'no form was named, so none is closed');
  const resumed = w.ledger.get(run.id);
  assert.equal(resumed?.state, 'working');
  assert.deepEqual(w.dispatcher.activity.mock.calls.at(-1)?.arguments, [resumed?.leaseId]);
  assert.deepEqual(w.log.said('info').at(-1), { level: 'info', event: 'run.answered', run: run.id });
});

test('an answer the dispatcher refuses is said back, and the question stands', async t => {
  const { w, run } = await parked(t);
  w.dispatcher.script.push({ refused: 'waiting', pool: 'default' });

  assert.deepEqual(await w.orchestrator.answer(run.sessionId!, 'the deep one'), {
    resumed: false,
    refused: 'waiting',
  });

  assert.equal(w.ledger.get(run.id)?.state, 'awaiting_input');
  assert.equal(w.opencode.session.prompt.mock.callCount(), 1, 'the worker was not told');
});

test('an answer that waits for a slot without a form id still reaches the worker when the slot opens', async t => {
  const { w, run } = await parked(t);
  w.dispatcher.script.push({ queued: 'req_1' });
  assert.deepEqual(await w.orchestrator.answer(run.sessionId!, 'the deep one'), { resumed: false, queued: 'req_1' });

  const lease = w.dispatcher.fulfil('req_1');
  await w.log.next('run.answered');

  const [sent] = await w.opencode.session.prompt.next();
  assert.equal(sent.text, 'The person answered your question: the deep one');
  assert.equal(w.ledger.get(run.id)?.state, 'working');
  assert.equal(w.ledger.get(run.id)?.leaseId, lease.id);
});

test('an answer that waited for a slot finds its run stopped in the meantime: the slot goes back and the worker is not told', async t => {
  const { w, run } = await parked(t);
  w.dispatcher.script.push({ queued: 'req_1' });
  await w.orchestrator.answer(run.sessionId!, 'the deep one');
  const closing = Promise.withResolvers<void>();
  w.tracker.endWork.does(() => closing.promise);
  const stopping = w.orchestrator.stop(run.id, 'not needed any more');
  await w.tracker.endWork.next(); // the run is cancelled; its ending, and so its queue place, is still in flight

  const lease = w.dispatcher.fulfil('req_1');
  assert.deepEqual(await w.dispatcher.release.next(), [lease.id]);
  closing.resolve();
  await stopping;

  assert.equal(w.ledger.get(run.id)?.state, 'cancelled');
  assert.equal(w.opencode.session.prompt.mock.callCount(), 1, 'the worker was only ever sent its first prompt');
});

test('a form that refuses the reply is a stale record, not a lost answer: the worker has the words and the run goes on', async t => {
  const { w, run } = await parked(t);
  const failure = new Error('no open form form_1');
  w.opencode.session.form.reply.does(fails(failure));

  assert.deepEqual(await w.orchestrator.answer(run.sessionId!, 'the deep one', 'form_1'), { resumed: true });

  assert.deepEqual(w.log.said('warn').at(-1), {
    level: 'warn',
    event: 'run.form.reply.failed',
    run: run.id,
    form: 'form_1',
    error: failure,
  });
  assert.deepEqual(w.log.said('info').at(-1), { level: 'info', event: 'run.answered', run: run.id, form: 'form_1' });
  assert.equal(w.ledger.get(run.id)?.state, 'working');
});

test('stopping a parked run whose slot already went back releases nothing more', async t => {
  const { w, run } = await parked(t);
  assert.equal(w.dispatcher.release.mock.callCount(), 1, 'the keep-alive gave the slot back');

  await w.orchestrator.stop(run.id, 'not needed any more');

  assert.equal(w.ledger.get(run.id)?.state, 'cancelled');
  assert.equal(w.dispatcher.release.mock.callCount(), 1);
});

test('a keep-alive that cannot give the slot back is said in the log, and the run stays parked', async () => {
  const w = world({ deps: { keepAliveMs: 1 } });
  const run = await started(w);
  const failure = new Error('Lease was already gone');
  w.dispatcher.release.does(fails(failure));

  await w.orchestrator.askTool(call(run, { question: 'Which shade?' }));

  assert.deepEqual(await w.log.next('keep-alive.failed'), {
    level: 'warn',
    event: 'keep-alive.failed',
    run: run.id,
    error: failure,
  });
  assert.equal(w.ledger.get(run.id)?.state, 'awaiting_input');
});

test('a keep-alive that rings while the run’s ending is still in flight leaves the slot to the ending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world({ deps: { keepAliveMs: 1_000 } });
  const run = await started(w);
  await w.orchestrator.askTool(call(run, { question: 'Which shade?' }));
  const closing = Promise.withResolvers<void>();
  w.tracker.endWork.does(() => closing.promise);
  const stopping = w.orchestrator.stop(run.id, 'not needed any more');
  await w.tracker.endWork.next();

  t.mock.timers.tick(1_000);
  assert.equal(w.dispatcher.release.mock.callCount(), 0, 'the ending gives the slot back last');
  closing.resolve();
  await stopping;

  assert.deepEqual(calls(w.dispatcher.release), [[run.leaseId]]);
  assert.ok(!w.log.said('info').some(line => line.event === 'elicitation.waiting'));
});
