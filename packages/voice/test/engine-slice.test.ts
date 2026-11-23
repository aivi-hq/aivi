import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineFixture } from './process-fixture.ts';

test('a stretch that starts before the stream began is nothing to slice', async t => {
  const h = engineFixture(t);
  await h.start();
  h.run.write(Buffer.from(new Int16Array([1000, 2000]).buffer));

  const before = h.run.slice(-1 / 16000, 1 / 16000);

  assert.equal(before === null, true, 'audio that never existed is not handed out as samples');
  assert.equal(h.run.slice(0, 1 / 16000) === null, false);
});
