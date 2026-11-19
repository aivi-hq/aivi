import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { call, started, world } from './orch-fixture.ts';

/** A world whose host can end, with its clocks on mock time. */
async function ending(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const abort = new AbortController();
  const w = world({ deps: { keepAliveMs: 1_000, signal: abort.signal } });
  const run = await started(w);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return { w, run, abort, flush };
}

test('a host that ends takes the keep-alive clock of a parked run with it', async t => {
  const { w, run, abort, flush } = await ending(t);
  await w.orchestrator.askTool(call(run, { question: 'Which shade?' }));

  abort.abort();
  t.mock.timers.tick(1_000);
  await flush();

  assert.equal(w.dispatcher.release.mock.callCount(), 0, 'the keep-alive did not ring, so no slot went back');
  assert.equal(w.ledger.get(run.id)?.state, 'awaiting_input');
});

test('a question asked after the host ended arms no keep-alive clock', async t => {
  const { w, run, abort, flush } = await ending(t);

  abort.abort();
  await w.orchestrator.askTool(call(run, { question: 'Which shade?' }));
  t.mock.timers.tick(1_000);
  await flush();

  assert.equal(w.dispatcher.release.mock.callCount(), 0);
  assert.equal(w.ledger.get(run.id)?.state, 'awaiting_input');
});

test('a turn end waiting out its quiet span goes with the host, and no turn end arms one after it', async t => {
  const { w, run, abort, flush } = await ending(t);
  const succeeded = () => w.events.emit(run.sessionId!, 'session.execution.succeeded');

  succeeded();
  abort.abort();
  succeeded();
  t.mock.timers.tick(1);
  await flush();

  assert.equal(w.opencode.session.form.list.mock.callCount(), 0, 'nothing was read: no turn was judged');
  assert.equal(w.opencode.session.prompt.mock.callCount(), 1, 'no nudge: only the first prompt was sent');
});
