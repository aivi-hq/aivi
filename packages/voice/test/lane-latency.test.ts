import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lanes } from './lane-fixture.ts';

test('live first-word latency is measured in milliseconds, not rounded seconds', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T10:00:00Z') });
  const h = lanes(t);
  const lane = h.book.lane({ speaker: 'Ada', user: 'user', person: true });
  t.after(() => lane.abort());
  lane.push(new Float32Array([0]));
  const id = await h.joined;
  t.mock.timers.tick(325);

  h.book.event({ ev: 'delta', text: 'hello', pos: 0.325, lane: id });

  assert.equal(h.debug.mock.callCount(), 1);
  assert.equal(h.debug.mock.calls[0]!.arguments[0], 'voice.lane.firstword');
  assert.equal(h.debug.mock.calls[0]!.arguments[1].ms, 325);
});
