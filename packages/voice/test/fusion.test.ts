import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fusion } from './fusion-fixture.ts';

test('mixed deltas and context resets are captioned while only words in a call can interrupt', t => {
  const h = fusion(t, 'call');
  h.f.event({ ev: 'diar', on: false });
  h.f.event({ ev: 'session_reset', pos: 1 });
  h.f.event({ ev: 'lane_end', lane: 'someone-else' });
  h.f.event({ ev: 'delta', text: 'hello ', pos: 2 });
  h.speaking.mock.mockImplementation(() => true);
  h.f.event({ ev: 'delta', text: 'world', pos: 3 });
  h.f.event({ ev: 'eof' });

  assert.deepEqual(
    h.emit.mock.calls.map(call => call.arguments[0].ev),
    ['session_reset', 'delta', 'delta'],
  );
  assert.equal(h.barge.mock.callCount(), 1);
  assert.equal(h.identify.mock.callCount(), 0);
  assert.deepEqual(h.commit.mock.calls[0]!.arguments, [0, 3, '', 'hello world', null]);
});

test('a late activity label adopts buffered words and cannot cut before the words actually ended', t => {
  const h = fusion(t);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'delta', text: 'already spoken', pos: 2 });
  h.f.event({ ev: 'act', t: 0, slot: 0 });
  assert.equal(h.commit.mock.callCount(), 0);
  h.f.event({ ev: 'delta', text: ' more words', pos: 4 });
  h.f.event({ ev: 'act', t: 3, slot: 1 });

  assert.deepEqual(h.commit.mock.calls[0]!.arguments, [0, 4, 'Ada', 'already spoken more words', null]);
  assert.deepEqual(h.identify.mock.calls[0]!.arguments, [0.75, 2.25]);
});

test('an activity that repeats the same slot does not split the utterance or create another identity', t => {
  const h = fusion(t);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'act', t: 0, slot: 0 });
  h.f.event({ ev: 'delta', text: 'one ', pos: 1 });
  h.f.event({ ev: 'act', t: 1, slot: 0 });
  h.f.event({ ev: 'delta', text: 'sentence', pos: 3 });
  h.f.event({ ev: 'act', t: 3, slot: -1 });
  h.f.event({ ev: 'act', t: 4, slot: 0 });
  h.f.event({ ev: 'delta', text: 'next', pos: 7 });
  h.f.event({ ev: 'act', t: 7, slot: -1 });

  assert.equal(h.identify.mock.callCount(), 1);
  assert.deepEqual(
    h.commit.mock.calls.map(call => call.arguments[3]),
    ['one sentence', 'next'],
  );
  assert.ok(h.commit.mock.calls.every(call => call.arguments[2] === 'Ada'));
});

test('a failed identity lookup retries the clean longest stretch instead of a later, shorter overlap', t => {
  const h = fusion(t);
  h.identify.mock.mockImplementationOnce(() => null);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'act', t: 0, slot: 0 });
  h.f.event({ ev: 'delta', text: 'first', pos: 4 });
  h.f.event({ ev: 'act', t: 4, slot: -1 });
  h.f.event({ ev: 'act', t: 5, slot: 0 });
  h.f.event({ ev: 'delta', text: 'next', pos: 6 });
  h.f.event({ ev: 'act', t: 6, slot: -1 });

  assert.deepEqual(
    h.identify.mock.calls.map(call => call.arguments),
    [
      [1, 3],
      [1, 3],
    ],
  );
  assert.deepEqual(
    h.commit.mock.calls.map(call => call.arguments[2]),
    ['', 'Ada'],
  );
});

test('an unbound thin stretch can grow into a real speaker without naming the earlier breath', t => {
  const h = fusion(t);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'act', t: 0, slot: 0 });
  h.f.event({ ev: 'delta', text: 'hm', pos: 1 });
  h.f.event({ ev: 'act', t: 1, slot: -1 });
  h.f.event({ ev: 'act', t: 2, slot: 0 });
  h.f.event({ ev: 'delta', text: 'now speaking', pos: 6 });
  h.f.event({ ev: 'act', t: 6, slot: -1 });

  assert.deepEqual(h.identify.mock.calls[0]!.arguments, [3, 5]);
  assert.deepEqual(
    h.commit.mock.calls.map(call => call.arguments[2]),
    ['', 'Ada'],
  );
});

test('a meeting wake cuts one addressed line and keeps the same speaker on the remaining words', t => {
  const h = fusion(t);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'act', t: 0, slot: 0 });
  h.f.event({ ev: 'delta', text: 'first line', pos: 3 });
  h.f.event({ ev: 'act', t: 3, slot: -1 });
  h.f.event({ ev: 'act', t: 4, slot: 0 });
  h.f.event({ ev: 'delta', text: 'hey assistant, ', pos: 5 });
  h.f.event({ ev: 'delta', text: '  please\nhelp  ', pos: 6 });
  h.f.event({ ev: 'act', t: 6, slot: -1 });

  assert.deepEqual(
    h.commit.mock.calls.map(call => call.arguments),
    [
      [0, 3, 'Ada', 'first line', null],
      [4, 5, 'Ada', 'hey assistant,', 'hey assistant'],
      [5, 6, 'Ada', 'please help', null],
    ],
  );
  assert.equal(h.identify.mock.callCount(), 1);
});

test('empty text and sub-200ms breaths do not become transcript rows', t => {
  const h = fusion(t, 'call');
  h.f.event({ ev: 'eof' });
  h.f.event({ ev: 'act', t: 1, slot: 0 });
  h.f.event({ ev: 'delta', text: ' ', pos: 1.05 });
  h.f.event({ ev: 'act', t: 1.05, slot: -1 });
  h.f.event({ ev: 'act', t: 2, slot: 0 });
  h.f.event({ ev: 'delta', text: 'hm', pos: 2.1 });
  h.f.event({ ev: 'act', t: 2.1, slot: -1 });

  assert.equal(h.commit.mock.callCount(), 0);
});

test('an unknown negative activity label cannot invent a diarized speaker for pending words', t => {
  const h = fusion(t);
  h.f.event({ ev: 'diar', on: true });
  h.f.event({ ev: 'delta', text: 'unnamed words', pos: 2 });

  h.f.event({ ev: 'act', t: 2, slot: -2 });
  h.f.event({ ev: 'eof' });

  assert.equal(h.identify.mock.callCount(), 0);
  assert.equal(h.commit.mock.callCount(), 1);
  assert.equal(h.commit.mock.calls[0]!.arguments[2], '');
});
