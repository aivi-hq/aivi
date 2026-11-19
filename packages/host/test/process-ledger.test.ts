/** The run ledger as a unit, over the host's real in-memory store: the
 *  double-work guard, the refusal of an unknown run, and the code a stop
 *  can leave on a run's outcome. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunLedger } from '../src/orchestrator/ledger.ts';
import { Store } from '../src/store.ts';

const ticket = { projectId: 'site', trackerId: 'linear', ticketId: 'T-1', lane: 'Todo', agent: 'dev' };

function ledger(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return new RunLedger(store);
}

test('a ticket that a run still works never gets a second one; a finished run frees it', t => {
  const runs = ledger(t);
  const first = runs.request(ticket, 1_000);
  assert.equal(first.created, true);
  const again = runs.request({ ...ticket, lane: 'Doing' }, 2_000);
  assert.equal(again.created, false, 'the ticket is held until the run ends');
  assert.equal(again.run.id, first.run.id);
  assert.equal(again.run.lane, 'Todo', 'the request does not rewrite the run that holds the ticket');
  runs.finish(first.run.id, { kind: 'success', summary: 'done' }, 'Done', 3_000);
  const next = runs.request(ticket, 4_000);
  assert.equal(next.created, true, 'a later delegation is new work');
  assert.notEqual(next.run.id, first.run.id);
});

test('a call that names a run the ledger does not hold is refused with that name', t => {
  const runs = ledger(t);
  assert.throws(() => runs.awaiting('run_missing'), /No run run_missing/);
  assert.equal(runs.get('run_missing'), undefined);
});

test('a stop leaves the failure code on the outcome only when the stop was not verified', t => {
  const runs = ledger(t);
  const verified = runs.request(ticket).run;
  const loose = runs.request({ ...ticket, ticketId: 'T-2' }).run;
  assert.deepEqual(runs.cancel(verified.id, 'asked to stop').outcome, { kind: 'failure', reason: 'asked to stop' });
  assert.deepEqual(runs.cancel(loose.id, 'asked to stop', 'stop-unconfirmed').outcome, {
    kind: 'failure',
    reason: 'asked to stop',
    code: 'stop-unconfirmed',
  });
});
