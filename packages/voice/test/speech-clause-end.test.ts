import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speechOut } from './speech-fixture.ts';

const delta = (text: string) => ({ kind: 'delta' as const, messageID: 'msg-1', delta: text });

test('a number whose decimal mark ends one piece of text is not cut in two', async t => {
  const h = speechOut(t);
  h.mouth();

  h.out.text(delta('De waarde is 3.'));
  assert.equal(h.getTts.mock.callCount(), 0, 'a mark with nothing after it yet is not known to end a clause');
  h.out.text(delta('5 procent. '));
  const [first] = await h.sentences.next();

  assert.equal(first.text, 'De waarde is 3.5 procent.');
});

test('a sentence that closes the answer is spoken when the answer ends', async t => {
  const h = speechOut(t);
  h.mouth();

  h.out.text(delta('Klaar.'));
  assert.equal(h.getTts.mock.callCount(), 0);
  h.out.finish('Klaar.');
  const [last] = await h.sentences.next();

  assert.equal(last.text, 'Klaar.', 'nothing waits on a timer: the end of the answer speaks what is left');
});
