/** `openFaceTab`: the browser core hands a platform module. Its collaborators
 *  are the shared Chrome (`Chrome.launch`, mocked), the tab that Chrome opens
 *  (a stub that records what it is asked) and the face file in the home (a real
 *  temp directory: the default face is read when the home has none). The shared
 *  browser is module state, ref-counted by the open face tabs, so every test
 *  closes what it opened. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Chrome } from '@aivi/chrome';
import { faceIsUp, playWav, setFace, setFaceWith, setTapOn, stopAllVoice } from '../src/face-page.ts';
import { type FaceTab, type FaceTabOptions, faceInjection, openFaceTab } from '../src/index.ts';

const URL = 'https://meet.google.com/abc-defg-hij';

/** The tab, as far as `openFaceTab` uses it. `ring` is the page calling its
 *  binding with heard audio. */
function tabStub(t: TestContext) {
  let bound: ((event: { params?: Record<string, unknown> }) => void) | undefined;
  return {
    send: t.mock.fn(async (_method: string, _params?: object): Promise<unknown> => ({})),
    on: t.mock.fn((_event: string, listener: (event: { params?: Record<string, unknown> }) => void) => {
      bound = listener;
    }),
    hideHeadless: t.mock.fn(async () => false),
    goto: t.mock.fn(async (_url: string, _options?: object) => {}),
    waitFor: t.mock.fn(async (_condition: unknown, _options?: object) => true),
    call: t.mock.fn(async (_fn: unknown, ..._args: unknown[]): Promise<unknown> => undefined),
    evaluate: t.mock.fn(async (_expression: string): Promise<unknown> => undefined),
    close: t.mock.fn(async () => {}),
    ring: (params: Record<string, unknown>) => bound?.({ params }),
  };
}

/** The shared Chrome, as far as `openFaceTab` uses it. `die` is the browser
 *  going away on its own. */
function chromeStub(t: TestContext, ...tabs: Array<ReturnType<typeof tabStub>>) {
  const gone: Array<() => void> = [];
  const opened = [...tabs];
  return {
    onGone: t.mock.fn((listener: () => void) => {
      gone.push(listener);
    }),
    newTab: t.mock.fn(async () => opened.shift()),
    close: t.mock.fn(async () => {}),
    die: () => {
      for (const listener of gone) listener();
    },
  };
}

type Calls = { mock: { calls: Array<{ arguments: unknown[] }> } };
const calls = (mock: Calls) => mock.mock.calls.map(call => call.arguments);

/** A home, a Chrome that launches, and a way to open face tabs that are closed
 *  when the test ends. */
async function world(t: TestContext, ...tabs: Array<ReturnType<typeof tabStub>>) {
  const home = await mkdtemp(join(tmpdir(), 'aivi-face-tab-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const chrome = chromeStub(t, ...tabs);
  const launch = t.mock.method(Chrome, 'launch', async () => chrome as unknown as Chrome);
  const faces: FaceTab[] = [];
  t.after(async () => {
    for (const face of faces) await face.close();
  });
  return {
    home,
    stateDir: '/state',
    chrome,
    launch,
    open: async (options: Partial<FaceTabOptions> = {}) => {
      const face = await openFaceTab({ home, stateDir: '/state', url: URL, ...options });
      faces.push(face);
      return face;
    },
  };
}

test('openFaceTab launches the shared browser, installs the face before the page loads, and waits until it paints', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);

  const face = await w.open();

  assert.deepEqual(calls(w.launch), [[{ profileDir: join('/state', 'face-chrome'), headless: true }]]);
  assert.equal(w.chrome.newTab.mock.callCount(), 1);
  assert.deepEqual(calls(tab.send), [
    ['Page.addScriptToEvaluateOnNewDocument', { source: await faceInjection(w.home) }],
  ]);
  assert.equal(tab.hideHeadless.mock.callCount(), 1);
  assert.deepEqual(calls(tab.goto), [[URL, { timeoutMs: 20_000 }]]);
  assert.deepEqual(calls(tab.waitFor), [[faceIsUp, { timeoutMs: 20_000 }]]);
  assert.equal(face.tab, tab as never);
});

test('openFaceTab can open a window, and gives the page as long as it is told', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);

  await w.open({ headless: false, readyTimeoutMs: 5_000 });

  assert.deepEqual(calls(w.launch), [[{ profileDir: join('/state', 'face-chrome'), headless: false }]]);
  assert.deepEqual(calls(tab.goto), [[URL, { timeoutMs: 5_000 }]]);
  assert.deepEqual(calls(tab.waitFor), [[faceIsUp, { timeoutMs: 5_000 }]]);
});

test('with hear, the audio binding is made before the page loads, and what the page rings reaches the listeners', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);

  const face = await w.open({ hear: true });
  const heard: Buffer[] = [];
  const unsubscribe = face.onAudio(pcm => heard.push(pcm));
  tab.ring({ name: '__aiviAudio', payload: Buffer.from('pcm one').toString('base64') });
  tab.ring({ name: 'somebody else', payload: Buffer.from('not ours').toString('base64') });
  tab.ring({ name: '__aiviAudio', payload: 42 });
  tab.ring({ name: '__aiviAudio' });
  unsubscribe();
  tab.ring({ name: '__aiviAudio', payload: Buffer.from('pcm two').toString('base64') });

  assert.deepEqual(calls(tab.send).slice(1), [['Runtime.enable'], ['Runtime.addBinding', { name: '__aiviAudio' }]]);
  assert.equal(calls(tab.on)[0]?.[0], 'Runtime.bindingCalled');
  assert.deepEqual(heard, [Buffer.from('pcm one')]);
});

test('without hear, no binding is made', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);

  await w.open();

  assert.equal(tab.on.mock.callCount(), 0);
  assert.equal(calls(tab.send).length, 1);
});

test('face tabs share one browser, and the last one to close ends it', async t => {
  const first = tabStub(t);
  const second = tabStub(t);
  const w = await world(t, first, second);

  const one = await w.open();
  const two = await w.open();
  assert.equal(w.launch.mock.callCount(), 1);

  await one.close();
  await one.close();
  assert.equal(w.chrome.close.mock.callCount(), 0, 'one face tab is still using it');
  assert.equal(first.close.mock.callCount(), 1, 'a second close does nothing');

  await two.close();
  assert.equal(w.chrome.close.mock.callCount(), 1);
  assert.equal(second.close.mock.callCount(), 1);
});

test('after the last face tab closed, the next one launches the browser again', async t => {
  const first = tabStub(t);
  const second = tabStub(t);
  const w = await world(t, first, second);

  await (await w.open()).close();
  await w.open();

  assert.equal(w.launch.mock.callCount(), 2);
});

test('a page that never gets there closes the tab and the browser, and the open fails with the error of the page', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);
  const failure = new Error('no Page.loadEventFired within 20000 ms');
  tab.goto.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(w.open(), failure);

  assert.equal(tab.close.mock.callCount(), 1);
  assert.equal(w.chrome.close.mock.callCount(), 1);
});

test('closing a tab and a browser that are already gone does not hide why the open failed', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);
  const failure = new Error('the face never came up');
  tab.waitFor.mock.mockImplementation(async () => {
    throw failure;
  });
  tab.close.mock.mockImplementation(async () => {
    throw new Error('connection closed');
  });
  w.chrome.close.mock.mockImplementation(async () => {
    throw new Error('connection closed');
  });

  await assert.rejects(w.open(), failure);
});

test('a browser that gives no tab fails the open, with nothing to close but the browser', async t => {
  const w = await world(t);
  w.chrome.newTab.mock.mockImplementation(async () => {
    throw new Error('Target.createTarget failed');
  });

  await assert.rejects(w.open(), new Error('Target.createTarget failed'));

  assert.equal(w.chrome.close.mock.callCount(), 1);
});

test('a face file without a script fails the open before the browser moves', async t => {
  const w = await world(t);
  await mkdir(join(w.home, 'face'));
  await writeFile(join(w.home, 'face', 'index.html'), '<html><body>no script here</body></html>');

  await assert.rejects(w.open(), /no inline <script>/);

  assert.equal(w.launch.mock.callCount(), 0);
});

test('the face tab speaks to the page through the page functions', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);
  const face = await w.open();
  tab.call.mock.mockImplementation(async fn => (fn === playWav ? true : undefined));
  tab.evaluate.mock.mockImplementation(async () => ({ video: true }));

  await face.setFaceState('listening');
  await face.setFaceState('tool', { name: 'search' });
  assert.equal(await face.speak(Buffer.from('wav')), true);
  await face.stopSpeaking();
  await face.setTap(true);
  await face.setTap(false, false);
  assert.deepEqual(await face.cameraAsked(), { video: true });

  assert.deepEqual(calls(tab.call), [
    [setFace, 'listening'],
    [setFaceWith, 'tool', { name: 'search' }],
    [playWav, Buffer.from('wav').toString('base64')],
    [stopAllVoice],
    [setTapOn, true, true],
    [setTapOn, false, false],
  ]);
  assert.deepEqual(calls(tab.evaluate), [['window.__aiviCameraAsked']]);
});

test('every listener hears the browser going away, until it takes itself off', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);
  const face = await w.open();
  const heard: string[] = [];
  face.onGone(() => heard.push('one'));
  const takeOff = face.onGone(() => heard.push('two'));

  w.chrome.die();
  takeOff();
  w.chrome.die();

  assert.deepEqual(heard, ['one', 'two', 'one']);
});

test('a browser that fails to launch does not poison the next open', async t => {
  const tab = tabStub(t);
  const w = await world(t, tab);
  w.launch.mock.mockImplementationOnce(async () => {
    throw new Error('no Chrome binary found');
  }, 0);

  await assert.rejects(w.open(), new Error('no Chrome binary found'));
  const face = await w.open();

  assert.equal(w.launch.mock.callCount(), 2, 'the cause is fixed, so the next open launches again');
  assert.equal(face.tab, tab as never);
});
