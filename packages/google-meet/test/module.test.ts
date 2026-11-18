/** The Meet module as `aivi serve` runs it: it claims `meet.join` and
 *  `meet.leave`, holds one meeting, and wires the face tab and the voice room
 *  to each other. What it reaches is the browser: `Chrome.launch` is mocked (a
 *  static method), so the face tab, the button trail and the page functions are
 *  the real ones, and the tab they drive is a stub that answers each page
 *  function by name, the way the page would. There is no module mock of a file
 *  of ours on purpose: a module mock overwrites that file's coverage in the
 *  report, in a way that changes with the run (`docs/testing.md`). The voice
 *  room is a stub, and the state directory is a real temp directory, because the
 *  record `meet.json` is a file the module writes and removes. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Chrome } from '@aivi/chrome';
import type { ExecutionResult } from '@aivi/core';
import { meetConfigSchema } from '../src/config.ts';
import { createMeetModule } from '../src/module.ts';
import type { Screen } from '../src/page.ts';

const URL = 'https://meet.google.com/abc-defg-hij';
const WAV = Buffer.from('wav');
const NAME_BOX = 'input[aria-label="Your name"], input[aria-label="full name"], input[placeholder="Your name"]';
const LEAVE = 'name:leave call|leave meeting|hang up';

const screen = (words: string, buttons: Screen['buttons'] = [], url = URL): Screen => ({ url, words, buttons });
const inCall = screen('Meeting details', [{ name: 'Leave call', enabled: true }]);
const lobby = screen('Please wait until a meeting host brings you into the call', [
  { name: 'Leave call', enabled: true },
]);
const signIn = screen('Sign in', [], 'https://accounts.google.com/ServiceLogin?continue=meet');

function stubLocator(t: TestContext, matcher: string) {
  return {
    exists: t.mock.fn(async () => false),
    click: t.mock.fn(async (_options?: object) => matcher),
    fill: t.mock.fn(async (_value: string) => {}),
    attr: t.mock.fn(async (_name: string): Promise<string | undefined> => undefined),
  };
}

/** The browser tab behind the face tab. `call` answers each page function by
 *  its name; `script` is what a test changes: the screens Meet shows, the page
 *  functions that fail, how long a wav plays, and a hook at every look at the
 *  screen. `ring` is the page calling its audio binding. */
function tabStub(t: TestContext) {
  const script = {
    screens: [inCall] as Screen[],
    looks: 0,
    broken: false,
    rejects: {} as Record<string, Error>,
    playing: undefined as ((b64: string) => Promise<boolean>) | undefined,
    onLook: undefined as (() => Promise<void>) | undefined,
  };
  const locators = new Map<string, ReturnType<typeof stubLocator>>();
  const locator = (matcher: string) => {
    if (script.broken) throw new Error('the target is gone');
    let found = locators.get(matcher);
    if (found === undefined) {
      found = stubLocator(t, matcher);
      locators.set(matcher, found);
    }
    return found;
  };
  let bound: ((event: { params?: Record<string, unknown> }) => void) | undefined;
  const call = t.mock.fn(async (fn: { name: string }, ...args: unknown[]): Promise<unknown> => {
    const failure = script.rejects[fn.name];
    if (failure !== undefined) throw failure;
    if (fn.name === 'lookAtScreen') {
      await script.onLook?.();
      return script.screens[Math.min(script.looks++, script.screens.length - 1)];
    }
    if (fn.name === 'titleOfPage') return 'Meet';
    if (fn.name === 'playWav') return script.playing ? script.playing(String(args[0])) : true;
    return undefined;
  });
  return {
    script,
    locator,
    call,
    send: t.mock.fn(async (_method: string, _params?: object): Promise<unknown> => ({})),
    on: t.mock.fn((_event: string, listener: (event: { params?: Record<string, unknown> }) => void) => {
      bound = listener;
    }),
    hideHeadless: t.mock.fn(async () => false),
    goto: t.mock.fn(async (_url: string, _options?: object) => {}),
    waitFor: t.mock.fn(async (_condition: unknown, _options?: object, ..._args: unknown[]) => true),
    evaluate: t.mock.fn(async (_expression: string): Promise<unknown> => undefined),
    close: t.mock.fn(async () => {}),
    ring: (params: Record<string, unknown>) => bound?.({ params }),
  };
}

/** The shared Chrome. `die` is the browser going away on its own. */
function chromeStub(t: TestContext, tab: ReturnType<typeof tabStub>) {
  const gone: Array<() => void> = [];
  return {
    onGone: t.mock.fn((listener: () => void) => {
      gone.push(listener);
    }),
    newTab: t.mock.fn(async () => tab),
    close: t.mock.fn(async () => {}),
    die: () => {
      for (const listener of gone) listener();
    },
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

/** A started module, with the browser, the voice room and the services
 *  answering as a healthy machine would. */
async function started(t: TestContext, block: Record<string, unknown> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'aivi-meet-module-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const tab = tabStub(t);
  const chrome = chromeStub(t, tab);
  const launch = t.mock.method(Chrome, 'launch', async () => chrome as unknown as Chrome);
  const room = roomStub(t);
  const left = Promise.withResolvers<void>();
  const info = t.mock.fn((message: string, _extra?: Record<string, unknown>) => {
    if (message === 'meet.left') left.resolve();
  });
  const warn = t.mock.fn((_message: string, _extra?: Record<string, unknown>) => {});
  const handlers = new Map<string, (run: never) => Promise<ExecutionResult>>();
  const released: string[] = [];
  const voice = { room: t.mock.fn((_options: Record<string, unknown>) => room) };
  const services = {
    loaded: { path: join(stateDir, 'config.json'), config: { stateDirectory: stateDir } },
    log: { getChild: () => ({ info, warn, error: () => {}, debug: () => {} }) },
    tasks: {
      claim: (name: string, handler: (run: never) => Promise<ExecutionResult>) => handlers.set(name, handler),
      release: (name: string) => released.push(name),
    },
    voice,
  };
  const running = await createMeetModule(meetConfigSchema.parse(block)).start(services as never);
  t.after(() => running.stop());
  return {
    stateDir,
    record: join(stateDir, 'meet.json'),
    tab,
    chrome,
    launch,
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

/** What the module asked the page to run: the name of the page function and its arguments. */
const pageCalls = (m: Started) =>
  m.tab.call.mock.calls.map(call => [(call.arguments[0] as { name: string }).name, ...call.arguments.slice(1)]);

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

/** The module is in a call. */
async function inTheCall(m: Started): Promise<void> {
  assert.equal((await m.join({ url: URL })).state, 'succeeded');
}

test('meet.join opens the face, clicks through Meet, wires both directions, and says the call is on', async t => {
  const m = await started(t, { name: 'Clawd', headless: false, mode: 'meeting' });
  m.tab.script.screens = [lobby, inCall];
  m.tab.locator(NAME_BOX).exists.mock.mockImplementationOnce(async () => true);
  let recordDuringJoin: Record<string, unknown> = {};
  m.tab.script.onLook = async () => {
    recordDuringJoin = JSON.parse(await readFile(m.record, 'utf8'));
  };

  assert.deepEqual(await m.join({ url: URL }), {
    state: 'succeeded',
    result: { url: URL, viaWaitingRoom: true },
  });

  assert.deepEqual(calls(m.launch), [[{ profileDir: join(m.stateDir, 'face-chrome'), headless: false }]]);
  assert.equal(calls(m.tab.goto)[0]?.[0], URL);
  assert.deepEqual(
    calls(m.tab.send).map(([method]) => method),
    ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.enable', 'Runtime.addBinding'],
  );
  assert.deepEqual(pageCalls(m), [
    ['setTapOn', false, true],
    ['lookAtScreen'],
    ['lookAtScreen'],
    ['setTapOn', true, true],
  ]);
  assert.deepEqual(calls(m.voice.room), [
    [{ id: 'meet', label: URL, streaming: true, mode: 'meeting', agent: 'assistant' }],
  ]);
  assert.deepEqual(
    calls(m.tab.locator(NAME_BOX).fill),
    [['Clawd']],
    'the name of the block is typed at the waiting room',
  );
  assert.deepEqual(
    calls(m.info).map(([message]) => message),
    ['meet.asked', 'meet.ears-open', 'meet.in-call'],
  );
  assert.deepEqual(calls(m.info)[0]?.[1], {
    name: 'Clawd',
    hint: 'admitting aivi is the host click; this waits',
  });
  assert.deepEqual(calls(m.info)[2], ['meet.in-call', { url: URL, viaWaitingRoom: true }]);
  assert.deepEqual([recordDuringJoin.phase, recordDuringJoin.url, recordDuringJoin.pid], ['joining', URL, process.pid]);
  const record = JSON.parse(await readFile(m.record, 'utf8'));
  assert.deepEqual([record.phase, record.url, record.pid], ['in-call', URL, process.pid]);
  assert.equal(new Date(record.since).toISOString(), record.since);
});

test('the room is asked for the resume window and the pool when the block names them', async t => {
  const m = await started(t, { resumeMinutes: 30, pool: 'meetings', agent: 'scribe' });

  await inTheCall(m);

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

    assert.equal(m.launch.mock.callCount(), 0);
  });
}

test('meet.join says what it needs when its task is not an invocation', async t => {
  const m = await started(t);

  const result = await m.run('meet.join', { task: { kind: 'prompt', prompt: 'join the call' } });

  assert.equal(result.state, 'failed');
  assert.equal(m.launch.mock.callCount(), 0);
});

test('meet.join says when a call is already on, and joins nothing', async t => {
  const m = await started(t);
  await inTheCall(m);

  assert.deepEqual(await m.join({ url: 'https://meet.google.com/other' }), {
    state: 'failed',
    result: null,
    reason: `already in a call: ${URL} — meet.leave first`,
  });

  assert.equal(m.launch.mock.callCount(), 1);
});

test('meet.join fails with the reason when the browser cannot be launched, leaves no record, and can try again', async t => {
  const m = await started(t);
  m.launch.mock.mockImplementationOnce(async () => {
    throw new Error('no Chrome binary found');
  }, 0);

  assert.deepEqual(await m.join({ url: URL }), { state: 'failed', result: null, reason: 'no Chrome binary found' });

  assert.deepEqual(calls(m.warn), [['meet.join-failed', { url: URL, error: 'no Chrome binary found' }]]);
  assert.equal(await exists(m.record), false);
  assert.equal(m.tab.close.mock.callCount() + m.room.stop.mock.callCount(), 0);
  assert.equal((await m.join({ url: URL })).state, 'succeeded', 'a later join launches the browser again');
});

test('meet.join closes what it opened when Meet will not let a guest in, even if closing fails too', async t => {
  const m = await started(t);
  m.tab.script.screens = [signIn];
  m.room.stop.mock.mockImplementationOnce(async () => {
    throw new Error('room gone');
  });
  m.tab.close.mock.mockImplementationOnce(async () => {
    throw new Error('tab gone');
  });

  const result = await m.join({ url: URL });

  assert.equal(result.state, 'failed');
  assert.match(String(result.reason), /^Meet asked for a Google sign-in — aivi joins as a guest only\./);
  assert.equal(m.room.stop.mock.callCount(), 1);
  assert.equal(m.tab.close.mock.callCount(), 1);
  assert.equal(m.chrome.close.mock.callCount(), 1, 'the browser goes with its last tab');
  assert.equal(await exists(m.record), false);
  m.tab.script.screens = [inCall];
  assert.equal((await m.join({ url: URL })).state, 'succeeded', 'and the next join works');
});

test('the heard audio feeds the room; the log says the tap flows, then once in 240 chunks', async t => {
  const m = await started(t);
  await inTheCall(m);
  const pcm = Buffer.alloc(320, 1);

  for (let heard = 0; heard < 240; heard++) m.tab.ring({ name: '__aiviAudio', payload: pcm.toString('base64') });

  assert.equal(m.room.feed.mock.callCount(), 240);
  assert.deepEqual(calls(m.room.feed)[0], [pcm]);
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
  await inTheCall(m);
  await m.leave();

  m.tab.ring({ name: '__aiviAudio', payload: Buffer.alloc(320).toString('base64') });

  assert.equal(m.room.feed.mock.callCount(), 0);
});

test('the face listens when words arrive, and shows what the turn does', async t => {
  const m = await started(t);
  await inTheCall(m);

  m.room.emit({ ev: 'delta' });
  m.room.emit({ ev: 'delta' });
  m.room.emit({ ev: 'turn', state: 'thinking' });
  m.room.emit({ ev: 'turn', state: 'tool' });
  m.room.emit({ ev: 'turn', state: 'idle' });
  m.room.emit({ ev: 'turn', state: 'something else' });
  m.room.emit({ ev: 'engine', state: 'ready' });
  m.room.emit({ ev: 'line' });

  assert.deepEqual(
    pageCalls(m).filter(([name]) => name === 'setFace'),
    [
      ['setFace', 'listening'],
      ['setFace', 'thinking'],
      ['setFace', 'tool'],
      ['setFace', 'idle'],
    ],
  );
  assert.deepEqual(
    calls(m.info).filter(([message]) => message === 'meet.engine-state'),
    [['meet.engine-state', { state: 'ready' }]],
  );
});

test('a face that cannot be told its state does not stop the meeting', async t => {
  const m = await started(t);
  await inTheCall(m);
  m.tab.script.rejects.setFace = new Error('cdp gone');

  m.room.emit({ ev: 'delta' });

  assert.equal(pageCalls(m).filter(([name]) => name === 'setFace').length, 1);
});

test('the answer plays out of the page, and the face speaks while it does and rests after', async t => {
  const m = await started(t);
  await inTheCall(m);
  const playing = Promise.withResolvers<boolean>();
  m.tab.script.playing = () => playing.promise;

  const said = m.room.say(WAV);
  m.room.emit({ ev: 'delta' });
  m.room.emit({ ev: 'turn', state: 'thinking' });
  const faceStates = () => pageCalls(m).filter(([name]) => name === 'setFace');
  assert.deepEqual(faceStates(), [['setFace', 'speaking']], 'events do not stamp on a mouth that is playing');
  playing.resolve(true);

  assert.equal(await said, true);
  assert.deepEqual(
    pageCalls(m).filter(([name]) => name === 'playWav'),
    [['playWav', WAV.toString('base64')]],
  );
  assert.deepEqual(faceStates(), [
    ['setFace', 'speaking'],
    ['setFace', 'idle'],
  ]);
});

test('answers that overlap speak once, and the face rests after the last one', async t => {
  const m = await started(t);
  await inTheCall(m);
  const answers = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()];
  let asked = 0;
  m.tab.script.playing = () => answers[asked++]!.promise;

  const one = m.room.say(WAV);
  const two = m.room.say(WAV);
  answers[0]!.resolve(true);
  await one;
  const faceStates = () => pageCalls(m).filter(([name]) => name === 'setFace');
  assert.deepEqual(faceStates(), [['setFace', 'speaking']], 'one answer is still playing');
  answers[1]!.resolve(false);

  assert.deepEqual([await two], [false]);
  assert.deepEqual(faceStates(), [
    ['setFace', 'speaking'],
    ['setFace', 'idle'],
  ]);
});

test('an answer the page cannot play fails its own promise, and the face rests', async t => {
  const m = await started(t);
  await inTheCall(m);
  m.tab.script.rejects.playWav = new Error('page gone');

  await assert.rejects(m.room.say(WAV), new Error('page gone'));

  assert.deepEqual(
    pageCalls(m).filter(([name]) => name === 'setFace'),
    [
      ['setFace', 'speaking'],
      ['setFace', 'idle'],
    ],
  );
});

test('an answer that comes after the hang-up is said not played, and one in flight leaves the face alone', async t => {
  const m = await started(t);
  await inTheCall(m);
  const playing = Promise.withResolvers<boolean>();
  m.tab.script.playing = () => playing.promise;
  const inFlight = m.room.say(WAV);
  await m.leave();
  playing.resolve(true);
  assert.equal(await inFlight, true);

  assert.equal(await m.room.say(WAV), false);

  assert.equal(pageCalls(m).filter(([name]) => name === 'playWav').length, 1);
  assert.deepEqual(
    pageCalls(m).filter(([name]) => name === 'setFace'),
    [['setFace', 'speaking']],
    'no rest for a face that is gone',
  );
});

test('a barge-in silences the page, and a stop that fails is not a failure; after the hang-up nothing is asked', async t => {
  const m = await started(t);
  await inTheCall(m);
  m.tab.script.rejects.stopAllVoice = new Error('cdp gone');
  const stops = () => pageCalls(m).filter(([name]) => name === 'stopAllVoice').length;

  m.room.barge();
  m.room.flush();
  assert.equal(stops(), 1);

  await m.leave();
  m.room.barge();
  assert.equal(stops(), 1);
});

test('meet.leave hangs up, closes the room and the tab, clears the record, and says it left', async t => {
  const m = await started(t);
  await inTheCall(m);

  assert.deepEqual(await m.leave(), { state: 'succeeded', result: { left: true, url: URL } });

  assert.equal(m.tab.locator(LEAVE).click.mock.callCount(), 1, 'the leave button was pressed');
  assert.equal(m.room.stop.mock.callCount(), 1);
  assert.equal(m.tab.close.mock.callCount(), 1);
  assert.equal(m.chrome.close.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
  assert.deepEqual(calls(m.info).slice(-2), [
    ['meet.leave-clicked', { button: LEAVE }],
    ['meet.left', { url: URL }],
  ]);
});

test('meet.leave with no meeting leaves nothing', async t => {
  const m = await started(t);

  assert.deepEqual(await m.leave(), { state: 'succeeded', result: { left: false } });

  assert.equal(m.tab.locator(LEAVE).click.mock.callCount(), 0);
});

test('a browser that is already gone does not keep the hang-up from closing everything', async t => {
  const m = await started(t);
  await inTheCall(m);
  m.tab.script.broken = true;
  m.room.stop.mock.mockImplementation(async () => {
    throw new Error('room gone');
  });
  m.tab.close.mock.mockImplementation(async () => {
    throw new Error('tab gone');
  });

  assert.deepEqual(await m.leave(), { state: 'succeeded', result: { left: true, url: URL } });

  assert.deepEqual(calls(m.warn), [
    ['meet.room-stop-failed', { error: 'Error: room gone' }],
    ['meet.tab-close-failed', { error: 'Error: tab gone' }],
  ]);
  assert.equal(m.chrome.close.mock.callCount(), 1, 'the dead browser is given back');
  assert.equal(await exists(m.record), false);
});

test('a browser that dies mid-call ends the meeting at once', async t => {
  const m = await started(t);
  await inTheCall(m);

  m.chrome.die();
  await m.left;

  assert.deepEqual(
    calls(m.warn).map(([message, extra]) => [message, (extra as { url: string }).url]),
    [['meet.browser-died', URL]],
  );
  assert.equal(m.tab.locator(LEAVE).click.mock.callCount(), 1);
  assert.equal(m.tab.close.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
});

test('a browser that dies while the join is still clicking is left to the join', async t => {
  const m = await started(t);
  m.tab.script.onLook = async () => m.chrome.die();

  assert.equal((await m.join({ url: URL })).state, 'succeeded');

  assert.deepEqual(calls(m.warn), []);
  assert.equal(m.tab.locator(LEAVE).click.mock.callCount(), 0);
  assert.equal(await stillWaiting(m.left), true);
});

test('stop gives the operations back, and ends the meeting that is still going', async t => {
  const m = await started(t);
  await inTheCall(m);

  await m.running.stop();

  assert.deepEqual(m.released, ['meet.join', 'meet.leave']);
  assert.equal(m.room.stop.mock.callCount(), 1);
  assert.equal(await exists(m.record), false);
});
