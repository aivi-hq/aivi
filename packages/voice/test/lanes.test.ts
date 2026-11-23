import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineRun } from '../src/engine.ts';
import { lanes } from './lane-fixture.ts';

const audio = (...samples: number[]) => new Float32Array(samples);

test('a live lane streams its audio from the top and commits what the engine heard once the tail is in', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T10:00:00Z') });
  const h = lanes(t);
  const opened = Date.now() / 1000;
  const lane = h.book.lane({ speaker: 'Ada', user: 'u-ada', person: true, channel: 'c-voice' });
  lane.push(audio(0.1));
  lane.push(audio(0.2));
  const id = await h.joined;
  lane.push(audio(0.3));

  h.book.event({ ev: 'delta', text: 'Hello', pos: 0.1, lane: id });
  h.book.event({ ev: 'session_reset', pos: 0.2, lane: id });
  h.book.event({ ev: 'delta', text: ' there ', pos: 0.3, lane: id });
  t.mock.timers.tick(2000);
  const ending = lane.end();
  assert.deepEqual(h.endLane.mock.calls[0]!.arguments, [id], 'the engine is asked for the tail first');
  h.book.event({ ev: 'lane_end', lane: id });

  assert.equal(await ending, 'Hello there');
  assert.equal(id, 'room/1');
  assert.deepEqual(
    h.writeLane.mock.calls.map(call => [call.arguments[0], Array.from(call.arguments[1])]),
    [audio(0.1), audio(0.2), audio(0.3)].map(pcm => [id, Array.from(pcm)]),
    'audio buffered before the engine joined goes in first, in order',
  );
  assert.deepEqual(h.commit.mock.calls[0]!.arguments, [
    opened,
    opened + 2,
    'Ada',
    'Hello there',
    { wake: null, user: 'u-ada', person: true, channel: 'c-voice' },
  ]);
  assert.equal(h.transcribe.mock.callCount(), 0, 'streamed words need no second pass');
  assert.equal(h.warn.mock.callCount(), 0);
  lane.push(audio(0.4));
  assert.equal(await lane.end(), null, 'one lane is one utterance');
  assert.equal(h.writeLane.mock.callCount(), 3);
  assert.equal(h.commit.mock.callCount(), 1);
});

test('only lane-tagged engine events are taken, whoever opened the lane', t => {
  const h = lanes(t);

  assert.equal(h.book.event({ ev: 'delta', text: 'mixed audio', pos: 1 }), false);
  assert.equal(h.book.event({ ev: 'act', t: 1, slot: 0 }), false);
  assert.equal(h.book.event({ ev: 'eof' }), false);
  assert.equal(h.book.event({ ev: 'delta', text: 'another room', pos: 1, lane: 'elsewhere/1' }), true);
  assert.equal(h.book.event({ ev: 'lane_end', lane: 'elsewhere/1' }), true);
  assert.equal(h.commit.mock.callCount(), 0);
});

test('a meeting lane names the wake phrase its line carries and a stranger stays a stranger', async t => {
  const h = lanes(t, 'meeting');
  h.speaking.mock.mockImplementation(() => true);
  const lane = h.book.lane({ speaker: 'Grace', user: 'u-grace' });
  lane.push(audio(0.1));
  const id = await h.joined;
  h.book.event({ ev: 'delta', text: 'Hey assistant, are you there?', pos: 0.1, lane: id });

  const ending = lane.end();
  h.book.event({ ev: 'lane_end', lane: id });

  assert.equal(await ending, 'Hey assistant, are you there?');
  assert.deepEqual(h.commit.mock.calls[0]!.arguments.slice(2), [
    'Grace',
    'Hey assistant, are you there?',
    { wake: 'hey assistant', user: 'u-grace', person: false },
  ]);
  assert.equal(h.barge.mock.callCount(), 0, 'meetings are polite, and a stranger never interrupts');
});

test('a lane the engine never joined is transcribed from its buffered audio', async t => {
  const h = lanes(t);
  h.ready.mock.mockImplementation(async () => null);
  const lane = h.book.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  lane.push(audio(0.1, 0.2));
  lane.push(audio(0.3));

  const text = await lane.end();

  assert.equal(text, 'fallback');
  assert.deepEqual(Array.from(h.transcribe.mock.calls[0]!.arguments[0]), Array.from(audio(0.1, 0.2, 0.3)));
  assert.equal(h.endLane.mock.callCount(), 0, 'there is no live lane to flush');
  assert.deepEqual(h.commit.mock.calls[0]!.arguments.slice(2), [
    'Ada',
    'fallback',
    { wake: null, user: 'u-ada', person: true },
  ]);
});

test('an utterance nothing could word is a logged loss, not a line', async t => {
  for (const answer of [null, '   ']) {
    await t.test(JSON.stringify(answer), async t => {
      const h = lanes(t);
      h.transcribe.mock.mockImplementation(async () => answer);
      const lane = h.book.lane({ speaker: 'Ada', user: 'u-ada' });
      lane.push(audio(0.1));
      const id = await h.joined;

      const ending = lane.end();
      h.book.event({ ev: 'lane_end', lane: id });

      assert.equal(await ending, null);
      assert.deepEqual(
        h.warn.mock.calls.map(call => call.arguments),
        [['voice.lane.lost', { room: 'room', speaker: 'Ada' }]],
      );
      assert.equal(h.commit.mock.callCount(), 0);
    });
  }
});

test('an aborted lane is closed in the engine and commits nothing', async t => {
  const h = lanes(t);
  const cough = h.book.lane({ speaker: 'Ada', user: 'u-ada' });
  cough.push(audio(0.1));
  const id = await h.joined;
  h.book.event({ ev: 'delta', text: 'ahem', pos: 0.1, lane: id });

  cough.abort();

  assert.deepEqual(h.endLane.mock.calls[0]!.arguments, [id], 'the engine drops the lane it was streaming');
  assert.equal(await cough.end(), null);
  h.book.event({ ev: 'delta', text: ' late', pos: 0.2, lane: id });
  assert.equal(h.commit.mock.callCount(), 0);
});

test('a lane thrown away before the engine joined never joins it', async t => {
  const h = lanes(t);
  const joining = Promise.withResolvers<EngineRun | null>();
  h.ready.mock.mockImplementation(() => joining.promise);
  const cough = h.book.lane({ speaker: 'Ada', user: 'u-ada' });
  cough.push(audio(0.1));

  cough.abort();
  joining.resolve(h.run);
  await joining.promise;

  assert.equal(h.endLane.mock.callCount(), 0, 'nothing was streaming yet');
  assert.equal(h.writeLane.mock.callCount(), 0);
});

test('an engine that dies while a lane waits for its tail settles it with what streamed, and says so', async t => {
  const h = lanes(t);
  const waiting = h.book.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  const speaking = h.book.lane({ speaker: 'Grace', user: 'u-grace' });
  waiting.push(audio(0.1));
  speaking.push(audio(0.2));
  const id = await h.joined;
  h.book.event({ ev: 'delta', text: 'halfway through', pos: 0.1, lane: id });
  const ending = waiting.end();

  h.book.engineDied();

  assert.equal(await ending, 'halfway through');
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      [
        'voice.lane.partial',
        {
          room: 'room',
          speaker: 'Ada',
          hint: 'the engine died before the tail: the line is what streamed so far',
        },
      ],
    ],
  );
  const written = h.writeLane.mock.callCount();
  speaking.push(audio(0.3));
  assert.equal(h.writeLane.mock.callCount(), written, 'nothing more is written to the dead engine');
  assert.equal(await speaking.end(), 'fallback', 'the other lane is worded from its buffer instead');
  assert.deepEqual(Array.from(h.transcribe.mock.calls[0]!.arguments[0]), Array.from(audio(0.2, 0.3)));
});

test('closing the room ends every live lane in the engine and settles whoever waits on a tail', async t => {
  const h = lanes(t);
  const waiting = h.book.lane({ speaker: 'Ada', user: 'u-ada' });
  const speaking = h.book.lane({ speaker: 'Grace', user: 'u-grace' });
  waiting.push(audio(0.1));
  speaking.push(audio(0.2));
  const id = await h.joined;
  h.book.event({ ev: 'delta', text: 'almost done', pos: 0.1, lane: id });
  const ending = waiting.end();

  h.book.closeAll();

  assert.equal(await ending, 'almost done');
  assert.deepEqual(
    h.endLane.mock.calls.map(call => call.arguments[0]),
    ['room/1', 'room/1', 'room/2'],
    'the waiting lane was asked for its tail; both are closed with the room',
  );
  h.book.event({ ev: 'delta', text: 'after the room closed', pos: 0.2, lane: 'room/2' });
  h.book.closeAll();
  assert.equal(h.endLane.mock.callCount(), 3, 'a closed book holds no lanes');
});

test('a closing room takes no more audio and no new lane joins the engine', async t => {
  const h = lanes(t);
  const joining = Promise.withResolvers<EngineRun | null>();
  h.ready.mock.mockImplementation(() => joining.promise);
  const lane = h.book.lane({ speaker: 'Ada', user: 'u-ada' });
  lane.push(audio(0.1));

  h.stopped.mock.mockImplementation(() => true);
  lane.push(audio(0.2));
  joining.resolve(h.run);
  await joining.promise;

  assert.equal(h.writeLane.mock.callCount(), 0);
  assert.equal(await lane.end(), null);
  assert.equal(h.transcribe.mock.callCount(), 0);
  assert.equal(h.commit.mock.callCount(), 0);
});
