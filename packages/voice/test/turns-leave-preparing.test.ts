import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import { boundary } from './boundary.ts';
import { voiceTurns } from './turns-fixture.ts';

test('a room that leaves while its session is being prepared never asks the model and returns the slot', async t => {
  const h = voiceTurns(t);
  const preparing = boundary();
  const prepared = Promise.withResolvers<DispatcherLeaseRef>();
  h.provide.mock.mockImplementation(() => {
    preparing.reach();
    return prepared.promise;
  });
  h.turns.prompt({ text: 'are you there?', speakers: ['Ada'] });
  await preparing.next();

  const left = h.turns.stop().then(() => 'left');
  prepared.resolve({ ...h.lease('lease-1', 'active'), sessionId: 'ses_voice_new' });
  const outcome = await Promise.race([left, h.asked.next().then(() => 'asked the model')]);

  assert.equal(outcome, 'left', 'leaving does not wait out an answer nobody is left to hear');
  assert.equal(h.runTurn.mock.callCount(), 0);
  assert.deepEqual(
    h.release.mock.calls.map(call => call.arguments[0]),
    ['lease-1'],
  );
  assert.deepEqual(
    h.rememberSession.mock.calls.map(call => call.arguments[0]),
    ['ses_voice_new'],
    'the prepared session is kept for the next join',
  );
  assert.deepEqual(h.said('info'), ['turns.cut']);
  assert.deepEqual(h.said('warn'), []);
});
