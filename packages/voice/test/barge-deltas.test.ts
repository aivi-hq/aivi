import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fusion } from './fusion-fixture.ts';
import { lanes } from './lane-fixture.ts';

test('empty, whitespace and punctuation-only mixed deltas cannot interrupt an answer', t => {
  const h = fusion(t, 'call');
  h.speaking.mock.mockImplementation(() => true);

  for (const text of ['', ' ', '\n', '.']) h.f.event({ ev: 'delta', text, pos: 1 });

  assert.equal(h.barge.mock.callCount(), 0);
  h.f.event({ ev: 'delta', text: 'hello', pos: 2 });
  assert.equal(h.barge.mock.callCount(), 1);
});

test('a linked live lane interrupts and reports first-word latency only for an actual word', async t => {
  const h = lanes(t);
  h.speaking.mock.mockImplementation(() => true);
  const lane = h.book.lane({ speaker: 'Ada', user: 'user', person: true });
  t.after(() => lane.abort());
  lane.push(new Float32Array([0]));
  const id = await h.joined;

  for (const text of ['', ' ', '\n', '.']) h.book.event({ ev: 'delta', text, pos: 1, lane: id });

  assert.equal(h.barge.mock.callCount(), 0);
  assert.equal(h.debug.mock.callCount(), 0);
  h.book.event({ ev: 'delta', text: 'hello', pos: 2, lane: id });
  assert.equal(h.barge.mock.callCount(), 1);
  assert.equal(h.debug.mock.callCount(), 1);
});
