import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundary } from './boundary.ts';
import { speechOut } from './speech-fixture.ts';

test('a barged answer is silenced once: no end of answer is sent to a mouth that was already stopped', async t => {
  const h = speechOut(t);
  const wire = h.mouth();
  const interrupted = boundary();
  h.info.mock.mockImplementation(() => interrupted.reach());
  h.out.finish('A long answer.');
  const [sentence] = await h.sentences.next();

  h.out.barge();
  sentence.chunk('synthesized too late');
  await interrupted.next();

  assert.equal(wire.stop.mock.callCount(), 1);
  assert.equal(wire.flush.mock.callCount(), 0, 'the stop already closed everything');
});
