import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speechOut } from './speech-fixture.ts';

test('an answer whose text block opened but never streamed is still spoken whole', async t => {
  const h = speechOut(t);
  h.mouth();
  h.out.text({ kind: 'start', messageID: 'msg-1' });

  h.out.finish('The whole answer.');

  assert.equal(h.getTts.mock.callCount(), 1, 'an opened block that brought no text streamed nothing');
  const [sentence] = await h.sentences.next();
  assert.equal(sentence.text, 'The whole answer.');
});
