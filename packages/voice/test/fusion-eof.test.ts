import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fusion } from './fusion-fixture.ts';

test('the last diarized speaker is identified before EOF commits its first line', t => {
  const h = fusion(t);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'act', t: 0, slot: 0 });
  h.f.event({ ev: 'delta', text: 'the final words', pos: 4 });

  h.f.event({ ev: 'eof' });

  assert.deepEqual(h.commit.mock.calls[0]!.arguments, [0, 4, 'Ada', 'the final words', null]);
  assert.equal(h.identify.mock.callCount(), 1);
  assert.deepEqual(h.identify.mock.calls[0]!.arguments, [1, 3]);
});
