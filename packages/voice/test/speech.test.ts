import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TtsRun } from '../src/tts.ts';
import { boundary } from './boundary.ts';
import { drained, speechOut } from './speech-fixture.ts';

const start = (messageID: string) => ({ kind: 'start' as const, messageID });
const delta = (messageID: string, text: string) => ({ kind: 'delta' as const, messageID, delta: text });

test('an answer that never streamed is spoken whole, chunk by chunk, to every mouth', async t => {
  const h = speechOut(t);
  const page = h.mouth();
  const wire = h.mouth(async () => true);
  assert.equal(h.out.isSpeaking, false);

  h.out.finish('The whole answer.');
  const [sentence] = await h.sentences.next();

  assert.equal(sentence.text, 'The whole answer.');
  assert.equal(h.out.isSpeaking, true, 'words recognized now are an interruption');
  sentence.chunk('wav-1');
  sentence.chunk('wav-2');
  sentence.end();
  await wire.flushed.next();
  assert.deepEqual(page.heard(), ['wav-1', 'wav-2']);
  assert.deepEqual(wire.heard(), ['wav-1', 'wav-2']);
  assert.equal(page.flush.mock.callCount(), 1, 'every mouth hears that the answer is over');
  await drained();
  assert.equal(h.out.isSpeaking, false);
  assert.equal(h.warn.mock.callCount(), 0);
});

test('the speaking window stays open until the last chunk has left the mouth', async t => {
  const h = speechOut(t);
  const playing = Promise.withResolvers<boolean>();
  const wire = h.mouth(() => playing.promise);
  h.out.finish('Answer.');
  const [sentence] = await h.sentences.next();
  sentence.chunk('wav');
  sentence.end();
  await wire.flushed.next();

  assert.equal(h.out.isSpeaking, true, 'handed over is not played: the mouth is still on the air');
  playing.resolve(true);
  await drained();
  assert.equal(h.out.isSpeaking, false);
});

test('the first clause speaks at once; what is written while the voice is busy leaves as one stretch', async t => {
  const h = speechOut(t);
  h.mouth();

  h.out.text(start('msg-1'));
  h.out.text(delta('msg-1', 'Alpha. Beta. '));
  const [first] = await h.sentences.next();
  h.out.text(delta('msg-1', 'Gamma, delta'));
  h.out.finish('Alpha. Beta. Gamma, delta');
  first.chunk('wav');
  first.end();
  const [rest] = await h.sentences.next();

  assert.equal(first.text, 'Alpha.', 'the first sound waits for one clause, not the whole answer');
  assert.equal(rest.text, 'Beta. Gamma, delta', 'the unpunctuated tail leaves with the answer');
  rest.end();
  await drained();
  assert.deepEqual(h.spoken, ['Alpha.', 'Beta. Gamma, delta'], 'every clause reaches the voice exactly once');
});

test('a line break ends a clause once, and a scrap too thin to speak joins the next one', async t => {
  const h = speechOut(t);
  h.mouth();

  h.out.text(delta('msg-1', '\n\n… Kort en krachtig, zoals afgesproken\n\n'));
  const [first] = await h.sentences.next();
  h.out.text(delta('msg-1', 'De tweede zin. En nog een deel.'));
  h.out.finish('… Kort en krachtig, zoals afgesproken\n\nDe tweede zin. En nog een deel.');
  first.end();
  const [rest] = await h.sentences.next();

  assert.equal(first.text, '… Kort en krachtig,');
  assert.equal(rest.text, 'zoals afgesproken De tweede zin. En nog een deel.');
});

test('numbers keep their decimal marks and closing quotes stay with their sentence', async t => {
  const h = speechOut(t);
  h.mouth();

  h.out.text(delta('msg-1', 'Het is 3.5 graden, of 2,5 minder.\tHij zei "stop." Klaar!\nEn door'));
  const [first] = await h.sentences.next();
  h.out.finish('unused: the answer streamed');
  first.end();
  const [rest] = await h.sentences.next();

  assert.equal(first.text, 'Het is 3.5 graden,');
  assert.equal(rest.text, 'of 2,5 minder. Hij zei "stop." Klaar! En door');
});

test('a new assistant message speaks the tail of the block before it and starts its own', async t => {
  const h = speechOut(t);
  h.mouth();
  h.out.text(start('msg-1'));
  h.out.text(delta('msg-1', 'Even kijken'));
  assert.deepEqual(h.spoken, [], 'no clause has ended yet');

  h.out.text(start('msg-2'));
  const [tail] = await h.sentences.next();
  h.out.text(delta('msg-2', 'Gevonden. '));
  h.out.finish('Even kijken Gevonden.');
  tail.end();
  const [next] = await h.sentences.next();

  assert.equal(tail.text, 'Even kijken');
  assert.equal(next.text, 'Gevonden.');
});

test('a barge silences every mouth at once and the stretch still being synthesized goes unheard', async t => {
  const h = speechOut(t);
  const wire = h.mouth();
  const interrupted = boundary();
  h.info.mock.mockImplementation(() => interrupted.reach());
  h.out.finish('A long answer.');
  const [sentence] = await h.sentences.next();

  h.out.barge();

  assert.equal(h.out.isSpeaking, false, 'the air is free for the person at once');
  assert.equal(wire.stop.mock.callCount(), 1);
  assert.deepEqual(
    h.emit.mock.calls.map(call => call.arguments[0]),
    [{ ev: 'stop_audio' }],
  );
  assert.deepEqual(h.debug.mock.calls[0]!.arguments, [
    'voice.reply.barged',
    { room: 'room', hint: 'recognized words took the air: the answer is silenced now' },
  ]);
  sentence.chunk('synthesized too late');
  await interrupted.next();
  assert.deepEqual(wire.heard(), []);
  assert.deepEqual(h.info.mock.calls[0]!.arguments, ['voice.reply.interrupted', { room: 'room', chars: 14 }]);
});

test('a barge between two chunks leaves the rest of the sentence unheard', async t => {
  const h = speechOut(t);
  const wire = h.mouth();
  const interrupted = boundary();
  h.info.mock.mockImplementation(() => interrupted.reach());
  h.out.finish('A long answer.');
  const [sentence] = await h.sentences.next();
  const played = boundary();
  wire.play.mock.mockImplementation(() => {
    played.reach();
    return true;
  });
  sentence.chunk('first');
  await played.next();

  h.out.barge();
  sentence.chunk('second');
  await interrupted.next();

  assert.deepEqual(wire.heard(), ['first']);
});

test('clauses waiting behind a barged answer die with it, and the reconsidered message is heard', async t => {
  const h = speechOut(t);
  h.mouth();
  h.out.text(start('msg-1'));
  h.out.text(delta('msg-1', 'Eerste zin. Tweede zin. '));
  const [first] = await h.sentences.next();

  h.out.barge();
  h.out.text(start('msg-2'));
  h.out.text(delta('msg-2', 'Je hebt gelijk, opnieuw. '));
  first.chunk('unheard');
  const [reconsidered] = await h.sentences.next();

  assert.equal(reconsidered.text, 'Je hebt gelijk, opnieuw.');
  assert.deepEqual(h.spoken, ['Eerste zin.', 'Je hebt gelijk, opnieuw.'], 'the clause of the dead answer never speaks');
});

test('a stretch barged before the voice was ready never gets the air', async t => {
  const h = speechOut(t);
  h.mouth();
  const ready = Promise.withResolvers<TtsRun | null>();
  h.getTts.mock.mockImplementationOnce(() => ready.promise);
  h.out.finish('Too slow.');

  h.out.barge();
  ready.resolve(h.tts);
  await drained();

  assert.deepEqual(h.spoken, []);
  assert.equal(h.out.isSpeaking, false);
});

test('a mouth can leave, and with no mouth nothing is synthesized', t => {
  const h = speechOut(t);
  const wire = h.mouth();

  wire.unregister();
  h.out.finish('Nobody to hear this.');
  h.out.text(delta('msg-1', 'Nor this. '));

  assert.equal(h.getTts.mock.callCount(), 0);
});

test('a mouth that fails to play, to stop or to close its answer is said and never silences the others', async t => {
  const h = speechOut(t);
  const broken = h.mouth(async () => {
    throw new Error('wire closed');
  });
  broken.stop.mock.mockImplementation(() => {
    throw new Error('stop failed');
  });
  broken.flush.mock.mockImplementation(() => {
    throw new Error('flush failed');
  });
  const plain = t.mock.fn(() => true);
  h.out.mouth(plain);
  const working = h.mouth();

  h.out.finish('Answer.');
  const [sentence] = await h.sentences.next();
  sentence.chunk('wav');
  sentence.end();
  await working.flushed.next();
  h.out.barge();

  assert.deepEqual(working.heard(), ['wav']);
  assert.equal(plain.mock.callCount(), 1, 'a mouth with no stop and no end of answer still plays');
  assert.equal(working.stop.mock.callCount(), 1);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      ['voice.mouth.failed', { room: 'room', error: 'Error: wire closed' }],
      ['voice.mouth.flush-failed', { room: 'room', error: 'Error: flush failed' }],
      ['voice.mouth.stop-failed', { room: 'room', error: 'Error: stop failed' }],
    ],
  );
});

test('without a voice the answers stay in text and the room says so once', async t => {
  const h = speechOut(t);
  h.mouth();
  h.getTts.mock.mockImplementation(async () => null);

  h.out.finish('First answer.');
  await drained();
  h.out.finish('Second answer.');
  await drained();

  assert.equal(h.getTts.mock.callCount(), 2);
  assert.deepEqual(
    h.info.mock.calls.map(call => call.arguments[0]),
    ['voice.room.mute'],
  );
  assert.equal(h.out.isSpeaking, false);
});

test('a voice that produces no audio is a logged unspoken answer', async t => {
  const h = speechOut(t);
  const wire = h.mouth();
  const unspoken = boundary();
  h.warn.mock.mockImplementation(() => unspoken.reach());

  h.out.finish('Silence.');
  const [sentence] = await h.sentences.next();
  sentence.end();
  await unspoken.next();

  assert.deepEqual(h.warn.mock.calls[0]!.arguments, ['voice.reply.unspoken', { room: 'room', chars: 8 }]);
  assert.deepEqual(wire.heard(), []);
});
