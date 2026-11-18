import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hearingRoom } from './room-fixture.ts';

test('a watcher that fails on the state it is shown first is said, and still gets its way out', t => {
  const h = hearingRoom(t);
  const broken = t.mock.fn(() => {
    throw new Error('page closed');
  });
  let leave = () => {};

  assert.doesNotThrow(() => {
    leave = h.room.onEvent(broken);
  });

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['voice.listener.failed', { room: 'room', error: 'Error: page closed' }]],
  );
  leave();
  h.engineState('loading');
  assert.equal(broken.mock.callCount(), 1, 'a watcher that left hears nothing more');
});
