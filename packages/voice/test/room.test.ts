import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { Store } from '@aivi/host';
import { ConfigurationError } from '@aivi/plugin';
import { boundary } from './boundary.ts';
import { voiceProcesses } from './process-fixture.ts';
import { hearingRoom, pcm } from './room-fixture.ts';

type Room = ReturnType<typeof hearingRoom>;

/** A finished utterance the platform named, worded by the shared engine. */
const say = (
  h: Room,
  text: string | null,
  who: { speaker?: string; user?: string; channel?: string; person?: boolean } = {},
) => {
  h.transcribe.mock.mockImplementationOnce(async () => text);
  return h.room.heard({ ...who, pcm });
};
const shown = (h: Room, kind: string) =>
  h.events.mock.calls.map(call => call.arguments[0]).filter(event => event.ev === kind);
const logged = (h: Room, level: 'info' | 'warn', message: string) =>
  h[level].mock.calls.filter(call => call.arguments[0] === message).map(call => call.arguments[1]);
/** The person is done talking: the finished window closes. */
const finished = (t: TestContext) => t.mock.timers.tick(1500);

test('a call room keeps no record: finished speech becomes one prompt once the person is done', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);

  assert.equal(await say(h, 'the wire is', { speaker: 'Ada', user: 'u-ada', channel: 'c-voice' }), 'the wire is');
  t.mock.timers.tick(1000);
  assert.equal(await say(h, 'alive again', { speaker: 'Grace' }), 'alive again');
  t.mock.timers.tick(1000);
  assert.equal(await say(h, 'and nameless'), 'and nameless');
  t.mock.timers.tick(1499);
  assert.equal(h.request.mock.callCount(), 0, 'every sentence reopens the window: nobody is done yet');
  t.mock.timers.tick(1);
  const [input] = await h.asked.next();

  assert.equal(input.text, '[Ada] the wire is\n[Grace] alive again\nand nameless');
  assert.deepEqual(input.messageMetadata, { aivi: { origin: 'discord', speakers: ['Ada', 'Grace'] } });
  assert.deepEqual(h.store.transcripts(), [], 'the session is the record');
  assert.deepEqual(logged(h, 'info', 'voice.flush'), [{ room: 'room', lines: 3, speakers: ['Ada', 'Grace'] }]);
  assert.deepEqual(logged(h, 'info', 'voice.line')[0], { room: 'room', speaker: 'Ada', text: 'the wire is' });
  assert.deepEqual(
    shown(h, 'line').map(({ speaker, text }) => [speaker, text]),
    [
      ['Ada', 'the wire is'],
      ['Grace', 'alive again'],
      ['', 'and nameless'],
    ],
  );
  assert.equal('id' in shown(h, 'line')[0]!, false, 'a caption, not a row');
});

test('speech nothing could word is lost, and a closed room hears nothing', async t => {
  const h = hearingRoom(t);

  assert.equal(await say(h, null), null);
  assert.equal(await say(h, ''), null);
  await h.room.stop();
  assert.equal(await h.room.heard({ pcm }), null);

  assert.equal(h.transcribe.mock.callCount(), 2, 'a closed room does not even ask the engine');
  assert.deepEqual(shown(h, 'line'), []);
});

test('finished speech is worded by the shared engine, then by the stt endpoint, and a room with neither says so', async t => {
  const h = hearingRoom(t, { engine: 'absent' });
  const endpoint = t.mock.fn(async (_pcm: Float32Array) => 'from the endpoint');
  h.getStt.mock.mockImplementationOnce(async () => ({ transcribe: endpoint }));

  assert.equal(await h.room.heard({ speaker: 'Ada', pcm }), 'from the endpoint');
  assert.equal(await h.room.heard({ speaker: 'Ada', pcm }), null);

  assert.equal(endpoint.mock.calls[0]!.arguments[0], pcm);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      [
        'voice.stt.missing',
        {
          room: 'room',
          hint: 'rooms that report finished speech need a running engine or a voice.stt endpoint',
        },
      ],
    ],
  );
});

test('words from a linked person while aivi speaks interrupt the answer; a stranger cannot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);
  const stop = t.mock.fn();
  const onAir = Promise.withResolvers<boolean>();
  h.room.mouth(() => onAir.promise, stop);
  await say(h, 'a question', { speaker: 'Ada', person: true });
  finished(t);
  await h.asked.next();
  h.answers[0]!.resolve({ text: 'A long answer.' });
  const [sentence] = await h.sentences.next();
  sentence.chunk('wav');

  await say(h, 'hello', { speaker: 'forger', person: false });
  assert.equal(stop.mock.callCount(), 0, 'a stranger talking over aivi does not silence it');
  await say(h, 'wait', { speaker: 'Ada', person: true });

  assert.equal(stop.mock.callCount(), 1);
  assert.deepEqual(shown(h, 'stop_audio'), [{ ev: 'stop_audio' }]);
  onAir.resolve(false);
});

test('the answer is spoken as it is written and the face follows the turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);
  h.room.mouth(() => true);
  await say(h, 'tell me', { speaker: 'Ada' });
  finished(t);
  await h.asked.next();

  h.emit({ type: 'session.text.started', data: { assistantMessageID: 'msg-1' } });
  h.emit({ type: 'session.text.delta', data: { assistantMessageID: 'msg-1', delta: 'Alpha. Beta. ' } });
  h.emit({ type: 'session.tool.called', data: {} });
  const [first] = await h.sentences.next();
  h.answers[0]!.resolve({ text: 'Alpha. Beta.' });
  await h.moved.next();
  first.end();
  const [rest] = await h.sentences.next();

  assert.equal(first.text, 'Alpha.', 'the first clause speaks while the model still writes');
  assert.equal(rest.text, 'Beta.');
  assert.deepEqual(
    shown(h, 'turn').map(event => event.state),
    ['thinking', 'tool', 'idle'],
  );
});

test('a pool that had no room is tried again when capacity moves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t, { deps: { finishWindowMs: 200 } });
  h.request.mock.mockImplementationOnce(() => ({ refused: 'waiting', pool: 'default' }));
  await say(h, 'patient', { speaker: 'Ada' });
  t.mock.timers.tick(200);
  assert.equal(h.request.mock.callCount(), 1, 'a room may bring its own finished window');
  assert.equal(h.runTurn.mock.callCount(), 0);

  h.room.retryTurns();
  const [input] = await h.asked.next();

  assert.equal(input.text, '[Ada] patient');
});

test('a live lane interrupts on the first word of a linked person and its line becomes the next prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);
  const stop = t.mock.fn();
  const onAir = Promise.withResolvers<boolean>();
  h.room.mouth(() => onAir.promise, stop);
  await say(h, 'a question', { speaker: 'Ada', person: true });
  finished(t);
  await h.asked.next();
  h.answers[0]!.resolve({ text: 'A long answer.' });
  const [sentence] = await h.sentences.next();
  sentence.chunk('wav');
  await h.moved.next();

  const stranger = h.room.lane({ speaker: 'forger', user: 'u-forger', person: false });
  stranger.push(pcm);
  const [strange] = await h.joined.next();
  h.engineEvent({ ev: 'delta', text: 'ho', pos: 0.1, lane: strange });
  assert.equal(stop.mock.callCount(), 0, 'the word of a stranger is heard but interrupts nothing');
  const lane = h.room.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  lane.push(pcm);
  const [id] = await h.joined.next();
  h.engineEvent({ ev: 'delta', text: 'No', pos: 0.1, lane: id });

  assert.equal(stop.mock.callCount(), 1, 'the first recognized word silences the mouth, not the speaking start');
  assert.deepEqual(shown(h, 'stop_audio'), [{ ev: 'stop_audio' }]);
  h.engineEvent({ ev: 'delta', text: ' wait', pos: 0.2, lane: id });
  const ending = lane.end();
  h.engineEvent({ ev: 'lane_end', lane: id });
  assert.equal(await ending, 'No wait');
  onAir.resolve(false);
  finished(t);
  const [next] = await h.asked.next();
  assert.equal(next.text, '[Ada] No wait', 'what streamed live is the prompt, word for word');
  assert.deepEqual(shown(h, 'delta'), [], 'lane words are no mixed-audio captions');
});

test('a shared engine that fails while a lane waits for its tail settles the line with what streamed', async t => {
  const h = hearingRoom(t);
  const lane = h.room.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  lane.push(pcm);
  const [id] = await h.joined.next();
  h.engineEvent({ ev: 'delta', text: 'halfway', pos: 0.1, lane: id });
  const ending = lane.end();

  h.engineState('failed');

  assert.equal(await ending, 'halfway');
  assert.equal(logged(h, 'warn', 'voice.lane.partial').length, 1);
  assert.equal(shown(h, 'engine').at(-1)!.state, 'failed', 'the page must not keep showing ready');
});

test('a room with named speakers ignores mixed audio events; a streaming room turns them into lines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const named = hearingRoom(t);
  const streaming = hearingRoom(t, { init: { streaming: true, label: 'page' } });
  const audio = Buffer.from(new Int16Array([1000, 2000]).buffer);

  streaming.room.feed(audio);
  for (const h of [named, streaming]) {
    h.engineEvent({ ev: 'act', t: 0, slot: 0 });
    h.engineEvent({ ev: 'delta', text: 'page audio', pos: 1 });
    h.engineEvent({ ev: 'session_reset', pos: 1.2 });
    h.engineEvent({ ev: 'act', t: 1.5, slot: -1 });
  }
  finished(t);
  const [input] = await streaming.asked.next();

  assert.deepEqual(streaming.push.mock.calls[0]!.arguments, [audio], 'the shared engine is fed by the room');
  assert.equal(input.text, 'page audio', 'a slot without a diarizer is nobody: the line carries no name');
  assert.deepEqual(shown(streaming, 'delta'), [{ ev: 'delta', text: 'page audio', pos: 1 }]);
  assert.deepEqual(shown(streaming, 'session_reset'), [{ ev: 'session_reset', pos: 1.2 }]);
  assert.deepEqual(shown(named, 'delta'), [], 'another room’s page audio is not this room’s line');
  assert.equal(named.request.mock.callCount(), 0);
  await streaming.room.stop();
  streaming.room.feed(audio);
  assert.equal(streaming.push.mock.callCount(), 1, 'a closed room feeds nothing');
});

test('a streaming room names a diarized voice from the middle of its stretch, through the person memory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const samples = new Float32Array([0.1, 0.2]);
  const stream = { acceptWaveform: t.mock.fn() };
  const embedder = {
    createStream: t.mock.fn(() => stream),
    isReady: t.mock.fn(() => true),
    compute: t.mock.fn(() => new Float32Array([1, 0])),
  };
  const h = hearingRoom(t, {
    init: { streaming: true },
    deps: { identity: { model: 'voice.onnx', threshold: 0.5 }, embedder },
  });
  h.slice.mock.mockImplementation(() => samples);
  h.engineEvent({ ev: 'diar', on: true });

  h.engineEvent({ ev: 'act', t: 0, slot: 0 });
  h.engineEvent({ ev: 'delta', text: 'good morning', pos: 1 });
  h.engineEvent({ ev: 'act', t: 4, slot: -1 });
  finished(t);
  const [input] = await h.asked.next();

  assert.deepEqual(h.slice.mock.calls[0]!.arguments, [1, 3]);
  assert.deepEqual(stream.acceptWaveform.mock.calls[0]!.arguments, [{ samples, sampleRate: 16000 }]);
  assert.equal(input.text, '[t1] good morning', 'a voice heard for the first time is minted and named');
  assert.deepEqual(logged(h, 'info', 'voice.identify'), [{ name: 't1', score: 0, minted: true }]);
});

test('a stretch the ring no longer holds, or too thin to embed, leaves its line nameless', async t => {
  const embedder = {
    createStream: () => ({ acceptWaveform: () => {} }),
    isReady: t.mock.fn(() => false),
    compute: t.mock.fn(() => new Float32Array([1, 0])),
  };
  const h = hearingRoom(t, {
    init: { streaming: true },
    deps: { identity: { model: 'voice.onnx', threshold: 0.5 }, embedder },
  });
  h.engineEvent({ ev: 'diar', on: true });

  h.engineEvent({ ev: 'act', t: 0, slot: 0 });
  h.engineEvent({ ev: 'delta', text: 'lost audio', pos: 1 });
  h.engineEvent({ ev: 'act', t: 4, slot: 1 });
  h.slice.mock.mockImplementation(() => new Float32Array([0.1]));
  h.engineEvent({ ev: 'delta', text: 'thin audio', pos: 5 });
  h.engineEvent({ ev: 'act', t: 8, slot: -1 });

  assert.deepEqual(
    shown(h, 'line').map(({ speaker, text }) => [speaker, text]),
    [
      ['', 'lost audio'],
      ['', 'thin audio'],
    ],
  );
  assert.deepEqual(logged(h, 'warn', 'voice.slice.lost'), [{ room: 'room', t0: 1, t1: 3 }]);
  assert.equal(embedder.compute.mock.callCount(), 0);
  assert.deepEqual(h.store.speakers(), [], 'nobody is minted from audio that was not there');
});

test('a diarizer without a voiceprint model names nobody', t => {
  const h = hearingRoom(t, { init: { streaming: true } });
  h.engineEvent({ ev: 'diar', on: true });

  h.engineEvent({ ev: 'act', t: 0, slot: 0 });
  h.engineEvent({ ev: 'delta', text: 'who am I', pos: 1 });
  h.engineEvent({ ev: 'act', t: 4, slot: -1 });

  assert.deepEqual(
    shown(h, 'line').map(({ speaker, text }) => [speaker, text]),
    [['', 'who am I']],
  );
  assert.equal(h.slice.mock.callCount(), 0, 'no audio is cut out for a model that is not there');
});

test('mixed words while aivi speaks interrupt a streaming call room', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t, { init: { streaming: true } });
  const stop = t.mock.fn();
  const onAir = Promise.withResolvers<boolean>();
  h.room.mouth(() => onAir.promise, stop);
  h.engineEvent({ ev: 'act', t: 0, slot: 0 });
  h.engineEvent({ ev: 'delta', text: 'a question', pos: 1 });
  h.engineEvent({ ev: 'act', t: 1.5, slot: -1 });
  finished(t);
  await h.asked.next();
  h.answers[0]!.resolve({ text: 'A long answer.' });
  const [sentence] = await h.sentences.next();
  sentence.chunk('wav');

  h.engineEvent({ ev: 'delta', text: '.', pos: 3 });
  assert.equal(stop.mock.callCount(), 0, 'a sound that is no word interrupts nothing');
  h.engineEvent({ ev: 'delta', text: 'wait', pos: 3.2 });

  assert.equal(stop.mock.callCount(), 1);
  onAir.resolve(false);
});

test('a lane the engine never joined is worded from its buffered audio by the stt endpoint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t, { engine: 'absent' });
  const endpoint = t.mock.fn(async (_pcm: Float32Array) => 'from the batch lane');
  h.getStt.mock.mockImplementation(async () => ({ transcribe: endpoint }));
  const lane = h.room.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  lane.push(pcm);
  lane.push(pcm);

  assert.equal(await lane.end(), 'from the batch lane');
  finished(t);
  const [input] = await h.asked.next();

  assert.equal(endpoint.mock.calls[0]!.arguments[0].length, pcm.length * 2, 'the whole utterance is handed over');
  assert.equal(h.writeLane.mock.callCount(), 0, 'there was no live lane');
  assert.equal(input.text, '[Ada] from the batch lane');
});

test('a meeting room appends every line to its record and stays silent until it is addressed', async t => {
  const h = hearingRoom(t, { mode: 'meeting' });
  const stop = t.mock.fn();
  h.room.mouth(() => true, stop);

  await say(h, 'quarterly numbers', { speaker: 'Ada', user: 'u-ada', channel: 'c-voice' });
  const [meeting] = h.store.transcripts();
  assert.equal(h.request.mock.callCount(), 0, 'no wake phrase: the meeting is not addressed');
  await say(h, 'Hey assistant, what did Ada say?', { speaker: 'Grace' });
  const [input] = await h.asked.next();

  assert.deepEqual([meeting!.source, h.store.transcripts()[0]!.lines], ['room', 2], 'a meeting keeps its record');
  const [first, addressed] = h.store.readLines({ transcript: meeting!.id, last: 10 });
  assert.deepEqual(
    [first!.speaker, first!.text, first!.wake, first!.user, first!.channel],
    ['Ada', 'quarterly numbers', false, 'u-ada', 'c-voice'],
  );
  assert.deepEqual([addressed!.speaker, addressed!.wake, addressed!.user], ['Grace', true, undefined]);
  assert.equal(
    input.text,
    `You were addressed by Grace during a meeting (transcript ${meeting!.id}, line ${addressed!.id}). They said: "Hey assistant, what did Ada say?". Use the aivi_voice_transcript tool to read back what was said around this moment.`,
  );
  assert.deepEqual(input.messageMetadata, {
    aivi: { origin: 'discord', transcript: meeting!.id, speakers: ['Grace'], wake: 'hey assistant' },
  });
  assert.deepEqual(
    shown(h, 'line').map(({ id, speaker }) => [id, speaker]),
    [
      [first!.id, 'Ada'],
      [addressed!.id, 'Grace'],
    ],
    'a meeting line is shown with its row',
  );
  h.room.bargeIn();
  assert.equal(stop.mock.callCount(), 0, 'meetings are polite: an answer plays to its end');
});

test('a nameless voice may address a meeting too: nobody is invented for it', async t => {
  const h = hearingRoom(t, { mode: 'meeting' });

  await say(h, 'hey assistant are you there');
  const [input] = await h.asked.next();

  assert.match(
    String(input.text),
    /^You were addressed by someone during a meeting .* They said: "hey assistant are you there"\./,
  );
  assert.deepEqual((input.messageMetadata as { aivi: object }).aivi, {
    origin: 'discord',
    transcript: h.store.transcripts()[0]!.id,
    wake: 'hey assistant',
  });
});

test('a meeting that only carries audio is refused without identity', t => {
  assert.throws(
    () => hearingRoom(t, { mode: 'meeting', init: { streaming: true, label: 'meet:abc' } }),
    (error: Error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /^room meet:abc: meeting rooms that only carry audio need identity/);
      return true;
    },
  );
});

test('a rejoin inside the resume window continues the session; past it the room starts fresh', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-18T10:00:00Z') });
  const database = new Store(':memory:');
  t.after(() => database.close());
  const exchange = async (h: Room, text: string) => {
    await say(h, text, { speaker: 'Ada' });
    finished(t);
    const [input] = await h.asked.next();
    h.answers.at(-1)!.resolve({ text: 'answer' });
    await h.moved.next();
    return input.sessionId as string;
  };

  const first = hearingRoom(t, { database });
  const session = await exchange(first, 'still here?');
  await first.room.stop();
  t.mock.timers.tick(29 * 60_000);
  const rejoined = hearingRoom(t, { database });
  await exchange(rejoined, 'back again');
  await rejoined.room.stop();
  t.mock.timers.tick(31 * 60_000);
  const late = hearingRoom(t, { database });
  await exchange(late, 'a new day');

  assert.equal(first.store.roomSession('room'), session, 'the room remembers the session its slot was given');
  assert.deepEqual(first.request.mock.calls[0]!.arguments, [{ service: 'voice' }]);
  assert.deepEqual(rejoined.request.mock.calls[0]!.arguments, [{ service: 'voice', resume: session }]);
  assert.deepEqual(logged(rejoined, 'info', 'voice.session.expired'), []);
  assert.deepEqual(
    late.request.mock.calls[0]!.arguments,
    [{ service: 'voice' }],
    'an old conversation is not replayed',
  );
  assert.deepEqual(logged(late, 'info', 'voice.session.expired'), [
    {
      room: 'room',
      session,
      quietMinutes: 31,
      hint: 'past the resume window: a fresh session, not an old conversation replayed as prefill',
    },
  ]);
});

test('a resume window of zero starts fresh at every join and stays steady within one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const database = new Store(':memory:');
  t.after(() => database.close());
  hearingRoom(t, { database }).store.setRoomSession('room', 'ses_voice_last_sitting');

  const h = hearingRoom(t, { database, deps: { resumeMinutes: 0 } });
  await say(h, 'hello?', { speaker: 'Ada' });
  finished(t);
  const [first] = await h.asked.next();
  h.answers[0]!.resolve({ text: 'answer' });
  await h.moved.next();
  await say(h, 'and again', { speaker: 'Ada' });
  finished(t);
  const [second] = await h.asked.next();

  assert.equal(logged(h, 'info', 'voice.session.expired').length, 1, 'the remembered session was another sitting');
  assert.deepEqual(h.request.mock.calls[0]!.arguments, [{ service: 'voice' }]);
  assert.equal(second.sessionId, first.sessionId, 'the room never loses its session mid-meeting');
});

test('without a resume window the same session is resumed however long the quiet', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-18T10:00:00Z') });
  const database = new Store(':memory:');
  t.after(() => database.close());
  hearingRoom(t, { database }).store.setRoomSession('room', 'ses_voice_forever');
  t.mock.timers.tick(10 * 86_400_000);

  const h = hearingRoom(t, { database, deps: { resumeMinutes: false } });
  await say(h, 'still the same?', { speaker: 'Ada' });
  finished(t);
  const [input] = await h.asked.next();

  assert.equal(input.sessionId, 'ses_voice_forever');
  assert.deepEqual(logged(h, 'info', 'voice.session.expired'), []);
});

test('a session OpenCode no longer has is forgotten by the room and replaced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);
  h.store.setRoomSession('room', 'ses_voice_stale');
  const stale = hearingRoom(t, { database: h.database });
  await say(stale, 'are you there?', { speaker: 'Ada' });
  finished(t);
  await stale.asked.next();

  stale.answers[0]!.reject(new Error('Session not found: ses_voice_stale'));
  const [retried] = await stale.asked.next();

  assert.equal(retried.text, '[Ada] are you there?');
  assert.equal(stale.store.roomSession('room'), retried.sessionId, 'the room points at the fresh session now');
  assert.notEqual(retried.sessionId, 'ses_voice_stale');
});

test('a page that joins sees the engine state at once; a failing watcher is said and never silences the others', async t => {
  const h = hearingRoom(t);
  const broken = t.mock.fn((event: Record<string, unknown>) => {
    if (event.state !== 'ready') throw new Error('page closed');
  });
  const late = t.mock.fn<(event: Record<string, unknown>) => void>();
  h.room.onEvent(broken);

  h.engineState('loading');
  const leave = h.room.onEvent(late);
  h.engineState('ready');
  leave();
  h.engineState('idle');

  assert.deepEqual(
    late.mock.calls.map(call => call.arguments[0]),
    [
      { ev: 'engine', state: 'loading' },
      { ev: 'engine', state: 'ready' },
    ],
  );
  assert.deepEqual(
    shown(h, 'engine').map(event => event.state),
    ['ready', 'loading', 'ready', 'idle'],
    'the first watcher still hears everything',
  );
  assert.deepEqual(logged(h, 'warn', 'voice.listener.failed')[0], { room: 'room', error: 'Error: page closed' });
});

test('closing a call room drops the sentences nobody finished, leaves the shared engine and closes its lanes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);
  const lane = h.room.lane({ speaker: 'Grace', user: 'u-grace' });
  lane.push(pcm);
  const [id] = await h.joined.next();
  await say(h, 'half a thought', { speaker: 'Ada' });

  await h.room.stop();
  finished(t);
  await h.room.stop();

  assert.deepEqual(logged(h, 'info', 'voice.batch.dropped'), [
    {
      room: 'room',
      lines: 1,
      hint: 'the room closed inside the finished window: those sentences were never finished',
    },
  ]);
  assert.equal(h.request.mock.callCount(), 0);
  assert.equal(h.detach.mock.callCount(), 1, 'the meeting ends; the models stay warm for the next one');
  assert.deepEqual(
    h.endLane.mock.calls.map(call => call.arguments[0]),
    [id],
  );
  h.room.bargeIn();
  assert.deepEqual(shown(h, 'stop_audio'), []);
});

test('a room of its own starts its engine at once, feeds it what arrived early and words speech in it', async t => {
  const processes = voiceProcesses(t);
  const h = hearingRoom(t, { init: { engineInput: { type: 'mic' }, streaming: true, label: 'mic:default' } });
  const ready = boundary();
  h.events.mock.mockImplementation(event => {
    if (event.ev === 'engine' && event.state === 'ready') ready.reach();
  });
  const early = Buffer.from(new Int16Array([1000, 2000]).buffer);
  const live = Buffer.from(new Int16Array([3000]).buffer);
  const [engine] = processes.children;

  h.room.feed(early);
  engine!.ready();
  await ready.next();
  h.room.feed(live);
  const heard = h.room.heard({ speaker: 'Ada', pcm });
  const lines = engine!.inputs.map(line => JSON.parse(line));

  assert.deepEqual(shown(h, 'engine')[0], { ev: 'engine', state: 'loading' }, 'the page says so while models load');
  assert.deepEqual(
    lines.slice(0, 2).map(line => line.a),
    [early.toString('base64'), live.toString('base64')],
  );
  engine!.response({ id: lines[2].id, text: 'worded in its own engine' });
  assert.equal(await heard, 'worded in its own engine');
  assert.equal(h.attach.mock.callCount(), 0, 'a room with its own process never joins the shared engine');
  assert.equal(h.push.mock.callCount(), 0);
  assert.equal(h.ready.mock.callCount(), 0);
  engine!.response({ ev: 'delta', text: 'from its own process', pos: 1 });
  assert.deepEqual(shown(h, 'delta'), [{ ev: 'delta', text: 'from its own process', pos: 1 }]);
});

test('a room of its own names a voice from the audio its own engine kept', async t => {
  const processes = voiceProcesses(t);
  const embedder = {
    createStream: () => ({ acceptWaveform: t.mock.fn() }),
    isReady: () => true,
    compute: () => new Float32Array([1, 0]),
  };
  const h = hearingRoom(t, {
    mode: 'meeting',
    init: { engineInput: { type: 'file', path: '/meeting.wav' }, streaming: true, label: '/meeting.wav' },
    deps: { identity: { model: 'voice.onnx', threshold: 0.5 }, embedder },
  });
  const [engine] = processes.children;
  engine!.ready();
  const [, decoder] = processes.children;
  decoder!.stdout.write(Buffer.alloc(4 * 16000 * 2));

  engine!.response({ ev: 'diar', on: true });
  engine!.response({ ev: 'act', t: 0, slot: 0 });
  engine!.response({ ev: 'delta', text: 'good morning', pos: 1 });
  engine!.response({ ev: 'act', t: 4, slot: -1 });

  assert.deepEqual(
    h.store.readLines({ last: 10 }).map(line => [line.speaker, line.text]),
    [['t1', 'good morning']],
  );
  assert.equal(h.slice.mock.callCount(), 0, 'the shared ring is another stream');
});

test('audio that waits too long for a loading engine is dropped oldest first, and said', async t => {
  const processes = voiceProcesses(t);
  const h = hearingRoom(t, { init: { engineInput: { type: 'mic' }, streaming: true } });
  const ready = boundary();
  h.events.mock.mockImplementation(event => {
    if (event.ev === 'engine' && event.state === 'ready') ready.reach();
  });

  h.room.feed(Buffer.alloc(1_200_000, 1));
  h.room.feed(Buffer.alloc(1_200_000, 2));
  processes.children[0]!.ready();
  await ready.next();

  assert.deepEqual(logged(h, 'warn', 'voice.room.dropped'), [
    { room: 'room', hint: 'audio arrived before the engine was ready' },
  ]);
  const written = processes.children[0]!.inputs.map(line => Buffer.from(JSON.parse(line).a, 'base64'));
  assert.deepEqual([written.length, written[0]![0]], [1, 2], 'only the newest audio reaches the engine');
});

test('a room whose own engine cannot start says so and tries again with the next audio', async t => {
  const processes = voiceProcesses(t);
  const h = hearingRoom(t, { init: { engineInput: { type: 'mic' }, streaming: true } });
  const state = boundary<[state: unknown]>();
  h.events.mock.mockImplementation(event => {
    if (event.ev === 'engine' && event.state !== 'loading') state.reach(event.state);
  });

  processes.children[0]!.stderr.write('ModuleNotFoundError: mlx\n');
  processes.children[0]!.exit(1);
  assert.deepEqual(await state.next(), ['failed']);
  h.room.feed(Buffer.from(new Int16Array([1000]).buffer));
  processes.children[1]!.ready();

  assert.deepEqual(await state.next(), ['ready']);
  assert.deepEqual(logged(h, 'warn', 'voice.engine.start-failed'), [
    { room: 'room', error: 'Error: engine exited 1 before ready: ModuleNotFoundError: mlx' },
  ]);
  assert.equal(processes.children[1]!.inputs.length, 1, 'the audio that asked for the retry is not lost');
});

test('an engine of its own that dies leaves the room failed; one that reached the end of its file does not', async t => {
  for (const ending of ['crash', 'end of file'] as const) {
    await t.test(ending, async t => {
      const processes = voiceProcesses(t);
      const h = hearingRoom(t, {
        init: { engineInput: { type: 'file', path: '/meeting.wav' }, streaming: true, label: '/meeting.wav' },
      });
      const ready = boundary();
      h.events.mock.mockImplementation(event => {
        if (event.ev === 'engine' && event.state === 'ready') ready.reach();
      });
      const [engine] = processes.children;
      engine!.ready();
      await ready.next();

      if (ending === 'end of file') engine!.response({ ev: 'eof' });
      engine!.exit(ending === 'crash' ? 3 : 0);

      assert.deepEqual(
        logged(h, 'warn', 'voice.engine.exited'),
        ending === 'crash' ? [{ room: '/meeting.wav', code: 3 }] : [],
      );
      assert.equal(shown(h, 'engine').at(-1)!.state, ending === 'crash' ? 'failed' : 'ready');
      assert.deepEqual(logged(h, 'info', 'voice.engine.eof'), ending === 'crash' ? [] : [{ room: '/meeting.wav' }]);
    });
  }
});

test('closing a room with its own engine ends that engine and its decoder', async t => {
  const processes = voiceProcesses(t);
  const h = hearingRoom(t, { init: { engineInput: { type: 'mic' }, streaming: true } });
  const ready = boundary();
  h.events.mock.mockImplementation(event => {
    if (event.ev === 'engine' && event.state === 'ready') ready.reach();
  });
  processes.children[0]!.ready();
  await ready.next();

  await h.room.stop();

  assert.deepEqual(
    processes.children.map(child => child.process.kill.mock.callCount()),
    [1, 1],
  );
  assert.equal(h.detach.mock.callCount(), 0);
  assert.deepEqual(h.said('warn'), [], 'a room that closed did not fail');
});
