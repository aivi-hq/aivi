import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import { boundary } from './boundary.ts';
import { voiceTurns } from './turns-fixture.ts';

test('a held slot is noted before its session is prepared: a crash while preparing cannot hide it', async t => {
  const h = voiceTurns(t);
  const preparing = boundary();
  const prepared = Promise.withResolvers<DispatcherLeaseRef>();
  h.provide.mock.mockImplementation(() => {
    preparing.reach();
    return prepared.promise;
  });

  h.turns.prompt({ text: 'hello', speakers: [] });
  await preparing.next();

  assert.deepEqual(
    h.rememberLease.mock.calls.map(call => call.arguments[0]),
    ['lease-1'],
  );
  prepared.resolve({ ...h.lease('lease-1', 'active'), sessionId: 'ses_voice_new' });
  await h.asked.next();
  assert.equal(h.rememberLease.mock.callCount(), 1, 'the slot is noted once');
});
