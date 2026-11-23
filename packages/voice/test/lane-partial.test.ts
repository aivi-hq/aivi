import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lanes } from './lane-fixture.ts';

test('an engine that dies in the middle of an utterance leaves a line that is said to be partial', async t => {
  const h = lanes(t);
  const lane = h.book.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  lane.push(new Float32Array([0.1]));
  const id = await h.joined;
  h.book.event({ ev: 'delta', text: 'halfway through', pos: 0.1, lane: id });

  h.book.engineDied();
  const text = await lane.end();

  assert.equal(text, 'halfway through');
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments[0]),
    ['voice.lane.partial'],
  );
  assert.equal(h.endLane.mock.callCount(), 0, 'a dead engine is asked for no tail');
});
