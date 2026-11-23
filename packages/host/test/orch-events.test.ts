import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, fails, started, type World, words, world } from './orch-fixture.ts';

const success = { outcome: 'success', summary: 'done' };

type Run = Awaited<ReturnType<typeof started>>;

const settled: [string, (w: World, run: Run) => Promise<unknown>][] = [
  ['parked on a question', (w, run) => w.orchestrator.askTool(call(run, { question: 'Which shade?' }))],
  ['completed', (w, run) => w.orchestrator.completeTool(call(run, success))],
];

for (const [state, settle] of settled) {
  test(`a turn that ends after the run is ${state} is not judged: nothing is read and nothing is sent`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    const run = await started(w);
    await settle(w, run);

    w.events.emit(run.sessionId!, 'session.execution.succeeded');
    t.mock.timers.tick(1);

    assert.equal(w.opencode.session.form.list.mock.callCount(), 0);
    assert.equal(w.opencode.session.prompt.mock.callCount(), 1, 'no nudge: only the first prompt was sent');
    assert.equal(w.ledger.get(run.id)?.nudges, 0);
  });
}

const succeeded = (w: World, run: Run) => w.events.emit(run.sessionId!, 'session.execution.succeeded');

interface Breaking {
  name: string;
  /** What stops working. */
  breaks: (w: World, failure: Error) => void;
  /** What the wire says next. */
  happens: (w: World, run: Run) => void;
  /** The warning the orchestrator keeps of it. */
  said: (run: Run) => Record<string, unknown>;
  /** What still stands afterwards. */
  stands: (w: World, run: Run) => void;
}

const breaking: Breaking[] = [
  {
    name: 'a turn end that cannot read OpenCode is said in the log, and earns neither a nudge nor a failure',
    breaks: (w, failure) => w.opencode.session.form.list.does(fails(failure)),
    happens: succeeded,
    said: run => ({ event: 'run.turn.reads.failed', run: run.id }),
    stands: (w, run) => {
      assert.equal(w.opencode.session.prompt.mock.callCount(), 1, 'no nudge went out');
      assert.equal(w.ledger.get(run.id)?.nudges, 0);
      assert.equal(w.ledger.get(run.id)?.state, 'working');
    },
  },
  {
    name: 'a nudge that OpenCode will not take is said in the log, and still counted',
    breaks: (w, failure) => w.opencode.session.prompt.does(fails(failure)),
    happens: succeeded,
    said: run => ({ event: 'run.nudge.failed', run: run.id }),
    stands: (w, run) => assert.equal(w.ledger.get(run.id)?.nudges, 1),
  },
  {
    name: 'a permission prompt whose reply cannot be sent is said in the log',
    breaks: (w, failure) => w.opencode.permission.reply.does(fails(failure)),
    happens: (w, run) =>
      w.events.emit(run.sessionId!, 'permission.asked', {
        id: 'ask-1',
        action: 'external_directory',
        resources: ['/elsewhere/*'],
      }),
    said: run => ({ event: 'permission.reply.failed', session: run.sessionId }),
    stands: (w, run) => assert.equal(w.ledger.get(run.id)?.state, 'working'),
  },
  {
    name: 'an execution failure whose ending cannot be finished is said in the log, and the run still ends',
    breaks: (w, failure) => w.dispatcher.release.does(fails(failure)),
    happens: (w, run) =>
      w.events.emit(run.sessionId!, 'session.execution.failed', { error: { message: 'the provider died' } }),
    said: run => ({ event: 'run.execution.failed.reply', session: run.sessionId }),
    stands: (w, run) => assert.equal(w.ledger.get(run.id)?.state, 'failed'),
  },
];

for (const { name, breaks, happens, said, stands } of breaking) {
  test(name, async () => {
    const w = world();
    const run = await started(w);
    const failure = new Error('OpenCode is down');
    breaks(w, failure);

    happens(w, run);

    const warning = said(run);
    assert.deepEqual(await w.log.next(String(warning.event)), { level: 'warn', ...warning, error: failure });
    stands(w, run);
  });
}

test('a permission prompt that names no resources is rejected all the same', async () => {
  const w = world({ deps: { prompt: words() } });
  const run = await started(w);

  w.events.emit(run.sessionId!, 'permission.asked', { id: 'ask-1', action: 'bash' });

  assert.deepEqual(await w.opencode.permission.reply.next(), [
    { sessionID: run.sessionId, requestID: 'ask-1', decision: 'reject', message: 'DENIED bash: ' },
  ]);
});

test('a permission prompt and a failed execution that arrive after the run ended are ignored', async () => {
  const w = world();
  const run = await started(w);
  await w.orchestrator.completeTool(call(run, success));

  w.events.emit(run.sessionId!, 'permission.asked', { id: 'ask-1', action: 'bash', resources: [] });
  w.events.emit(run.sessionId!, 'session.execution.failed', { error: { message: 'too late' } });

  assert.equal(w.opencode.permission.reply.mock.callCount(), 0);
  assert.equal(w.tracker.endWork.mock.callCount(), 1, 'the run ended once, as its completion');
  assert.deepEqual(w.log.said('error'), []);
});
