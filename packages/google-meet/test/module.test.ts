/** The Meet module as `aivi serve` runs it: it claims `meet.join` and
 *  `meet.leave`, holds one meeting, and wires the face tab and the voice room
 *  to each other. What it reaches is answered here: `openFaceTab` (`@aivi/core`,
 *  the rest of it is the real module) and the button trail in `meeting.ts` are
 *  module mocks, registered before the module is imported; the face tab and the
 *  voice room are stubs. The state directory is a real temp directory, because
 *  the record `meet.json` is a file the module writes and removes. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import * as core from '@aivi/core';
import { meetConfigSchema } from '../src/config.ts';

const openFaceTab = mock.fn<typeof core.openFaceTab>();
const driveJoin = mock.fn<typeof import('../src/meeting.ts').driveJoin>();
const driveLeave = mock.fn<typeof import('../src/meeting.ts').driveLeave>();
mock.module('@aivi/core', { exports: { ...core, openFaceTab } });
mock.module('../src/meeting.ts', { exports: { driveJoin, driveLeave } });

const { createMeetModule } = await import('../src/module.ts');

const URL = 'https://meet.google.com/abc-defg-hij';
const WAV = Buffer.from('wav');

/** The face tab, as far as the module uses it. `hear` and `die` are the page
 *  sending audio and the browser dying. */
function faceStub(t: TestContext) {
  let audio: ((pcm: Buffer) => void) | undefined;
  let gone: (() => void) | undefined;
  return {
    tab: { page: 'the tab' },
    setTap: t.mock.fn(async (_on: boolean, _muteOutput?: boolean) => {}),
    setFaceState: t.mock.fn(async (_state: string) => {}),
    speak: t.mock.fn(async (_wav: Buffer) => true),
    stopSpeaking: t.mock.fn(async () => {}),
    close: t.mock.fn(async () => {}),
    onAudio: t.mock.fn((listener: (pcm: Buffer) => void) => {
      audio = listener;
      return () => {};
    }),
    onGone: t.mock.fn((listener: () => void) => {
      gone = listener;
      return () => {};
    }),
    hear: (pcm: Buffer) => audio?.(pcm),
    die: () => gone?.(),
  };
}

/** The voice room, as far as the module uses it. `emit`, `say`, `barge` and
 *  `flush` are the room producing an event and calling its mouth. */
function roomStub(t: TestContext) {
  let onEvent: ((event: Record<string, unknown>) => void) | undefined;
  let play: ((wav: Buffer) => boolean | Promise<boolean>) | undefined;
  let stop: (() => void) | undefined;
  let flush: (() => void) | undefined;
  return {
    feed: t.mock.fn((_pcm: Buffer) => {}),
    stop: t.mock.fn(async () => {}),
    onEvent: t.mock.fn((listener: (event: Record<string, unknown>) => void) => {
      onEvent = listener;
      return () => {};
    }),
    mouth: t.mock.fn(
      (playWav: (wav: Buffer) => boolean | Promise<boolean>, stopMouth?: () => void, flushMouth?: () => void) => {
        play = playWav;
        stop = stopMouth;
        flush = flushMouth;
        return () => {};
      },
    ),
    emit: (event: Record<string, unknown>) => onEvent?.(event),
    say: (wav: Buffer) => Promise.resolve(play!(wav)),
    barge: () => stop!(),
    flush: () => flush!(),
  };
}

type Calls = { mock: { calls: Array<{ arguments: unknown[] }> } };
const calls = (mock: Calls) => mock.mock.calls.map(call => call.arguments);

/** A started module, with everything it reaches answering as a healthy
 *  machine would: the face opens, Meet lets the guest in, hanging up works. */
async function started(t: TestContext, block: Record<string, unknown> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'aivi-meet-module-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const face = faceStub(t);
  const room = roomStub(t);
  const left = Promise.withResolvers<void>();
  const info = t.mock.fn((message: string, _extra?: Record<string, unknown>) => {
    if (message === 'meet.left') left.resolve();
  });
  const warn = t.mock.fn((_message: string, _extra?: Record<string, unknown>) => {});
  const handlers = new Map<string, (run: never) => Promise<core.ExecutionResult>>();
  const released: string[] = [];
  const voice = { room: t.mock.fn((_options: Record<string, unknown>) => room) };
  openFaceTab.mock.resetCalls();
  openFaceTab.mock.mockImplementation(async () => face as never);
  driveJoin.mock.resetCalls();
  driveJoin.mock.mockImplementation(async () => ({ viaWaitingRoom: false }));
  driveLeave.mock.resetCalls();
  driveLeave.mock.mockImplementation(async () => true);
  const services = {
    loaded: { path: '/home/config.json', config: { stateDirectory: stateDir } },
    log: { getChild: () => ({ info, warn, error: () => {}, debug: () => {} }) },
    tasks: {
      claim: (name: string, handler: (run: never) => Promise<core.ExecutionResult>) => handlers.set(name, handler),
      release: (name: string) => released.push(name),
    },
    voice,
  };
  const running = await createMeetModule(meetConfigSchema.parse(block)).start(services as never);
  t.after(() => running.stop());
  return {
    stateDir,
    record: join(stateDir, 'meet.json'),
    face,
    room,
    voice,
    info,
    warn,
    left: left.promise,
    released,
    running,
    run: (name: string, run: unknown) => handlers.get(name)!(run as never),
    join: (args: unknown) =>
      handlers.get('meet.join')!({ task: { kind: 'invocation', name: 'meet.join', args } } as never),
    leave: () => handlers.get('meet.leave')!({ task: { kind: 'invocation', name: 'meet.leave' } } as never),
  };
}

type Started = Awaited<ReturnType<typeof started>>;

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

/** True when the promise has not settled once the event loop has turned. */
const stillWaiting = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    new Promise<boolean>(resolve => setImmediate(() => resolve(true))),
  ]);

/** The module is in a call, and its face tab is the one this test drives. */
async function inCall(m: Started): Promise<void> {
  assert.equal((await m.join({ url: URL })).state, 'succeeded');
}

test('meet.join opens the face, clicks through Meet, wires both directions, and says the call is on', async t => {
  const m = await started(t, {
    name: 'Clawd',
    headless: false,
    joinTimeoutMs: 1_234,
    askTimeoutMs: 5_678,
    mode: 'meeting',
  });
  let recordDuringJoin: Record<string, unknown> = {};
  driveJoin.mock.mockImplementation(async (_tab, joinOptions) => {
    recordDuringJoin = JSON.parse(await readFile(m.record, 'utf8'));
    joinOptions.log('meet.clicked', { button: 'Ask to join' });
    return { viaWaitingRoom: true };
  });

  assert.deepEqual(await m.join({ url: URL }), {
    state: 'succeeded',
    result: { url: URL, viaWaitingRoom: true },
  });

  assert.deepEqual(calls(openFaceTab), [
    [{ home: '/home', stateDir: m.stateDir, url: URL, hear: true, headless: false }],
  ]);
  assert.deepEqual(calls(m.face.setTap), [[false, true], [true]]);
  assert.deepEqual(calls(m.voice.room), [
    [{ id: 'meet', label: URL, streaming: true, mode: 'meeting', agent: 'assistant' }],
  ]);
  const [tab, options] = driveJoin.mock.calls[0]!.arguments;
  assert.equal(tab, m.face.tab);
  const { log: _log, ...rest } = options;
  assert.deepEqual(rest, { name: 'Clawd', joinTimeoutMs: 1_234, askTimeoutMs: 5_678 });
  assert.deepEqual(
    calls(m.info).map(([message]) => message),
    ['meet.clicked', 'meet.ears-open', 'meet.in-call'],
  );
  assert.deepEqual(calls(m.info)[0], ['meet.clicked', { button: 'Ask to join' }]);
  assert.deepEqual(calls(m.info)[2], ['meet.in-call', { url: URL, viaWaitingRoom: true }]);
  assert.deepEqual([recordDuringJoin.phase, recordDuringJoin.url, recordDuringJoin.pid], ['joining', URL, process.pid]);
  const record = JSON.parse(await readFile(m.record, 'utf8'));
  assert.deepEqual([record.phase, record.url, record.pid], ['in-call', URL, process.pid]);
  assert.equal(new Date(record.since).toISOString(), record.since);
});

test('the room is asked for the resume window and the pool when the block names them', async t => {
  const m = await started(t, { resumeMinutes: 30, pool: 'meetings', agent: 'scribe' });

  await inCall(m);

  assert.deepEqual(calls(m.voice.room), [
    [{ id: 'meet', label: URL, streaming: true, mode: 'call', agent: 'scribe', resumeMinutes: 30, pool: 'meetings' }],
  ]);
});

for (const [name, args] of [
  ['no args', undefined],
  ['a url that is not text', { url: 42 }],
  ['a url that is not http', { url: 'ftp://meet.google.com/abc' }],
] as const) {
  test(`meet.join says what it needs when it is handed ${name}`, async t => {
    const m = await started(t);

    assert.deepEqual(await m.join(args), {
      state: 'failed',
      result: null,
      reason: 'meet.join needs args {url: "https://meet.google.com/…"}',
    });

    assert.equal(openFaceTab.mock.callCount(), 0);
  });
}

test('meet.join says what it needs when its task is not an invocation', async t => {
  const m = await started(t);

  const result = await m.run('meet.join', { task: { kind: 'prompt', prompt: 'join the call' } });

  assert.equal(result.state, 'failed');
  assert.equal(openFaceTab.mock.callCount(), 0);
});

test('meet.join says when a call is already on, and joins nothing', async t => {
  const m = await started(t);
  await inCall(m);

  assert.deepEqual(await m.join({ url: 'https://meet.google.com/other' }), {
    state: 'failed',
    result: null,
    reason: `already in a call: ${URL} — meet.leave first`,
  });

  assert.equal(openFaceTab.mock.callCount(), 1);
});

test('meet.join fails with the reason when the face cannot be opened, and leaves no record', async t => {
  const m = await started(t);
  openFaceTab.mock.mockImplementation(async () => {
    throw new Error('no Chrome binary found');
  });

  assert.deepEqual(await m.join({ url: URL }), { state: 'failed', result: null, reason: 'no Chrome binary found' });

  assert.deepEqual(calls(m.warn), [['meet.join-failed', { url: URL, error: 'no Chrome binary found' }]]);
  assert.equal(await exists(m.record), false);
  assert.equal(m.face.close.mock.callCount() + m.room.stop.mock.callCount(), 0);
  assert.equal(driveJoin.mock.callCount(), 0);
});

test('meet.join closes what it opened when the clicks fail, even if closing fails too, and can join again', async t => {
  const m = await started(t);
  driveJoin.mock.mockImplementationOnce(async () => {
    throw new Error('Meet kept refusing the guest');
  });
  m.room.stop.mock.mockImplementationOnce(async () => {
    throw new Error('room gone');
  });
  m.face.close.mock.mockImplementationOnce(async () => {
    throw new Error('tab gone');
  });

  assert.deepEqual(await m.join({ url: URL }), {
    state: 'failed',
    result: null,
    reason: 'Meet kept refusing the guest',
  });

  assert.equal(m.room.stop.mock.callCount(), 1);
  assert.equal(m.face.close.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
  assert.equal((await m.join({ url: URL })).state, 'succeeded');
});

test('the heard audio feeds the room; the log says the tap flows, then once in 240 chunks', async t => {
  const m = await started(t);
  await inCall(m);
  const pcm = Buffer.alloc(320);

  for (let heard = 0; heard < 240; heard++) m.face.hear(pcm);

  assert.equal(m.room.feed.mock.callCount(), 240);
  assert.deepEqual(
    calls(m.info).filter(([message]) => message === 'meet.first-audio' || message === 'meet.audio-flow'),
    [
      ['meet.first-audio', { bytes: 320, hint: 'the tap is flowing' }],
      ['meet.audio-flow', { chunks: 240 }],
    ],
  );
});

test('audio that arrives after the hang-up goes nowhere', async t => {
  const m = await started(t);
  await inCall(m);
  await m.leave();

  m.face.hear(Buffer.alloc(320));

  assert.equal(m.room.feed.mock.callCount(), 0);
});

test('the face listens when words arrive, and shows what the turn does', async t => {
  const m = await started(t);
  await inCall(m);

  m.room.emit({ ev: 'delta' });
  m.room.emit({ ev: 'delta' });
  m.room.emit({ ev: 'turn', state: 'thinking' });
  m.room.emit({ ev: 'turn', state: 'tool' });
  m.room.emit({ ev: 'turn', state: 'idle' });
  m.room.emit({ ev: 'turn', state: 'something else' });
  m.room.emit({ ev: 'engine', state: 'ready' });
  m.room.emit({ ev: 'line' });

  assert.deepEqual(calls(m.face.setFaceState), [['listening'], ['thinking'], ['tool'], ['idle']]);
  assert.deepEqual(
    calls(m.info).filter(([message]) => message === 'meet.engine-state'),
    [['meet.engine-state', { state: 'ready' }]],
  );
});

test('a face that cannot be told its state does not stop the meeting', async t => {
  const m = await started(t);
  await inCall(m);
  m.face.setFaceState.mock.mockImplementation(async () => {
    throw new Error('cdp gone');
  });

  m.room.emit({ ev: 'delta' });

  assert.equal(m.face.setFaceState.mock.callCount(), 1);
});

test('the answer plays out of the page, and the face speaks while it does and rests after', async t => {
  const m = await started(t);
  await inCall(m);
  const playing = Promise.withResolvers<boolean>();
  m.face.speak.mock.mockImplementationOnce(() => playing.promise);

  const said = m.room.say(WAV);
  m.room.emit({ ev: 'delta' });
  m.room.emit({ ev: 'turn', state: 'thinking' });
  assert.deepEqual(calls(m.face.setFaceState), [['speaking']], 'events do not stamp on a mouth that is playing');
  playing.resolve(true);

  assert.equal(await said, true);
  assert.deepEqual(calls(m.face.speak), [[WAV]]);
  assert.deepEqual(calls(m.face.setFaceState), [['speaking'], ['idle']]);
});

test('answers that overlap speak once, and the face rests after the last one', async t => {
  const m = await started(t);
  await inCall(m);
  const first = Promise.withResolvers<boolean>();
  const second = Promise.withResolvers<boolean>();
  m.face.speak.mock.mockImplementationOnce(() => first.promise, 0);
  m.face.speak.mock.mockImplementationOnce(() => second.promise, 1);

  const one = m.room.say(WAV);
  const two = m.room.say(WAV);
  first.resolve(true);
  await one;
  assert.deepEqual(calls(m.face.setFaceState), [['speaking']], 'one answer is still playing');
  second.resolve(false);

  assert.deepEqual([await two], [false]);
  assert.deepEqual(calls(m.face.setFaceState), [['speaking'], ['idle']]);
});

test('an answer the page cannot play fails its own promise, and the face rests', async t => {
  const m = await started(t);
  await inCall(m);
  m.face.speak.mock.mockImplementationOnce(async () => {
    throw new Error('page gone');
  });

  await assert.rejects(m.room.say(WAV), new Error('page gone'));

  assert.deepEqual(calls(m.face.setFaceState), [['speaking'], ['idle']]);
});

test('an answer that comes after the hang-up is said not played, and one in flight leaves the face alone', async t => {
  const m = await started(t);
  await inCall(m);
  const playing = Promise.withResolvers<boolean>();
  m.face.speak.mock.mockImplementationOnce(() => playing.promise);
  const inFlight = m.room.say(WAV);
  await m.leave();
  playing.resolve(true);
  assert.equal(await inFlight, true);

  assert.equal(await m.room.say(WAV), false);

  assert.equal(m.face.speak.mock.callCount(), 1);
  assert.deepEqual(calls(m.face.setFaceState), [['speaking']], 'no rest for a face that is gone');
});

test('a barge-in silences the page, and a stop that fails is not a failure; after the hang-up nothing is asked', async t => {
  const m = await started(t);
  await inCall(m);
  m.face.stopSpeaking.mock.mockImplementationOnce(async () => {
    throw new Error('cdp gone');
  });

  m.room.barge();
  m.room.flush();
  assert.equal(m.face.stopSpeaking.mock.callCount(), 1);

  await m.leave();
  m.room.barge();
  assert.equal(m.face.stopSpeaking.mock.callCount(), 1);
});

test('meet.leave hangs up, closes the room and the tab, clears the record, and says it left', async t => {
  const m = await started(t);
  driveLeave.mock.mockImplementation(async (_tab, log) => {
    log('meet.leave-clicked', { button: 'Leave call' });
    return true;
  });
  await inCall(m);

  assert.deepEqual(await m.leave(), { state: 'succeeded', result: { left: true, url: URL } });

  assert.equal(driveLeave.mock.calls[0]?.arguments[0], m.face.tab);
  assert.equal(m.room.stop.mock.callCount(), 1);
  assert.equal(m.face.close.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
  assert.deepEqual(calls(m.info).slice(-2), [
    ['meet.leave-clicked', { button: 'Leave call' }],
    ['meet.left', { url: URL }],
  ]);
});

test('meet.leave with no meeting leaves nothing', async t => {
  const m = await started(t);

  assert.deepEqual(await m.leave(), { state: 'succeeded', result: { left: false } });

  assert.equal(driveLeave.mock.callCount(), 0);
});

test('a browser that is already gone does not keep the hang-up from closing everything', async t => {
  const m = await started(t);
  await inCall(m);
  driveLeave.mock.mockImplementation(async () => {
    throw new Error('connection closed');
  });
  m.room.stop.mock.mockImplementation(async () => {
    throw new Error('room gone');
  });
  m.face.close.mock.mockImplementation(async () => {
    throw new Error('tab gone');
  });

  assert.deepEqual(await m.leave(), { state: 'succeeded', result: { left: true, url: URL } });

  assert.deepEqual(calls(m.warn), [
    ['meet.room-stop-failed', { error: 'Error: room gone' }],
    ['meet.tab-close-failed', { error: 'Error: tab gone' }],
  ]);
  assert.equal(await exists(m.record), false);
});

test('a browser that dies mid-call ends the meeting at once', async t => {
  const m = await started(t);
  await inCall(m);

  m.face.die();
  await m.left;

  assert.deepEqual(
    calls(m.warn).map(([message, extra]) => [message, (extra as { url: string }).url]),
    [['meet.browser-died', URL]],
  );
  assert.equal(driveLeave.mock.callCount(), 1);
  assert.equal(m.face.close.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
});

test('a browser that dies while the join is still clicking is left to the join', async t => {
  const m = await started(t);
  driveJoin.mock.mockImplementation(async () => {
    m.face.die();
    return { viaWaitingRoom: false };
  });

  assert.equal((await m.join({ url: URL })).state, 'succeeded');

  assert.deepEqual(calls(m.warn), []);
  assert.equal(driveLeave.mock.callCount(), 0);
  assert.equal(await stillWaiting(m.left), true);
});

test('stop gives the operations back, and ends the meeting that is still going', async t => {
  const m = await started(t);
  await inCall(m);

  await m.running.stop();

  assert.deepEqual(m.released, ['meet.join', 'meet.leave']);
  assert.equal(m.room.stop.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
});
