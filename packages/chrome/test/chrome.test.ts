/** `Chrome`: launch the installed browser or attach to one, and hand out tabs.
 *  What it reaches is mocked, and the mocks answer like a healthy machine: a
 *  binary that boots, a port file that is there, a browser that answers with
 *  its version, a connection that opens. A test changes only what it is about. */
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { CdpConnection, CdpError, Chrome, findChrome } from '../src/index.ts';
import { stubConnection } from './connection-stub.ts';

const WS_URL = 'ws://127.0.0.1:9333/devtools/browser/abc';
const VERSION = { Browser: 'Chrome/141.0.7390.107', webSocketDebuggerUrl: WS_URL };
const PORT_FILE = '9333\n/devtools/browser/abc\n';
const BOOT = { executablePath: '/opt/chrome', profileDir: '/profiles/one' };

const DEFAULT_FLAGS = [
  '--headless=new',
  '--user-data-dir=/profiles/one',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader',
  '--disable-blink-features=AutomationControlled',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=1280,720',
  '--lang=en-US',
  'about:blank',
];

/** What `spawn` returns, as far as `Chrome` looks at it. It ends the way a
 *  real child does: its codes are set, then `exit` is said. */
function childStub(t: TestContext) {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: t.mock.fn((_signal?: NodeJS.Signals) => true),
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null = null): void => {
    proc.exitCode = code;
    proc.signalCode = signal;
    proc.emit('exit', code, signal);
  };
  // a polite child ends when it is asked to, a little later, as a real one does
  proc.kill.mock.mockImplementation(signal => {
    queueMicrotask(() => exit(null, signal ?? 'SIGTERM'));
    return true;
  });
  /** A child that ignores SIGTERM: only SIGKILL ends it. */
  const stubborn = (): void => {
    proc.kill.mock.mockImplementation(signal => {
      if (signal === 'SIGKILL') queueMicrotask(() => exit(null, 'SIGKILL'));
      return true;
    });
  };
  return { proc, exit, stubborn };
}

/** The files `Chrome` looks for: `present` holds the paths that exist. */
function files(t: TestContext) {
  const present = new Set<string>();
  const existsSync = t.mock.method(fs, 'existsSync', (path: unknown) => present.has(String(path)));
  syncBuiltinESMExports();
  t.after(() => {
    existsSync.mock.restore();
    syncBuiltinESMExports();
  });
  return present;
}

/** Everything `Chrome` reaches. `order` is the order of the calls that matter. */
function world(t: TestContext) {
  const order: string[] = [];
  const present = files(t);
  const connection = stubConnection(t);
  const open = t.mock.method(CdpConnection, 'open', async () => connection);
  const fetched = t.mock.method(globalThis, 'fetch', async () => Response.json(VERSION));
  const child = childStub(t);
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    order.push('spawn');
    return child.proc as unknown as ChildProcess;
  });
  const mkdir = t.mock.method(fsPromises, 'mkdir', async () => {
    order.push('mkdir');
    return undefined;
  });
  const rm = t.mock.method(fsPromises, 'rm', async () => {
    order.push('rm');
  });
  const readFile = t.mock.method(
    fsPromises,
    'readFile',
    (async () => PORT_FILE) as unknown as typeof fsPromises.readFile,
  );
  syncBuiltinESMExports();
  t.after(() => {
    for (const mock of [spawn, mkdir, rm, readFile]) mock.mock.restore();
    syncBuiltinESMExports();
  });
  return { order, present, connection, open, fetched, child, spawn, mkdir, rm, readFile };
}

type World = ReturnType<typeof world>;

/** The port file as Chrome writes it: each read gets the next of `says`, the
 *  last one for ever after. `null` is a file that is not there yet. */
function portFile(w: World, ...says: Array<string | null>): void {
  let reads = 0;
  w.readFile.mock.mockImplementation((async () => {
    const say = says[Math.min(reads++, says.length - 1)];
    if (say === null || say === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return say;
  }) as unknown as typeof fsPromises.readFile);
}

/** The answers of `/json/version`, each in turn, the last one for ever after. */
function versions(w: World, ...says: Array<() => Response>): void {
  let asks = 0;
  w.fetched.mock.mockImplementation(async () => says[Math.min(asks++, says.length - 1)]!());
}

const unavailable = () => new Response('', { status: 503 });
const withoutSocket = () => Response.json({ Browser: 'Chrome/141.0.7390.107' });
const healthy = () => Response.json(VERSION);

const calls = (mock: { mock: { calls: Array<{ arguments: unknown[] }> } }) =>
  mock.mock.calls.map(call => call.arguments);

test('findChrome takes AIVI_CHROME_PATH before anything else', t => {
  files(t).add('/opt/chrome').add('/usr/bin/google-chrome-stable');
  t.mock.property(process, 'env', { AIVI_CHROME_PATH: '/opt/chrome', PATH: '/usr/bin' });

  assert.equal(findChrome(), '/opt/chrome');
});

test('findChrome fails loudly when AIVI_CHROME_PATH points at nothing', t => {
  files(t).add('/usr/bin/google-chrome-stable');
  t.mock.property(process, 'env', { AIVI_CHROME_PATH: '/opt/gone' });

  assert.throws(findChrome, new Error('AIVI_CHROME_PATH points at nothing: /opt/gone'));
});

test('findChrome ignores an AIVI_CHROME_PATH that is empty', t => {
  files(t).add('/usr/bin/chromium');
  t.mock.property(process, 'platform', 'linux');
  t.mock.property(process, 'env', { AIVI_CHROME_PATH: '' });

  assert.equal(findChrome(), '/usr/bin/chromium');
});

for (const [platform, candidates] of [
  [
    'darwin',
    [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
  ],
  [
    'linux',
    [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
  ],
] as const) {
  test(`findChrome tries the usual ${platform} paths in order`, t => {
    const present = files(t);
    t.mock.property(process, 'platform', platform);
    t.mock.property(process, 'env', { PATH: '/usr/local/bin' });
    present.add('/usr/local/bin/chromium');

    present.add(candidates.at(-1)!);
    assert.equal(findChrome(), candidates.at(-1), 'a later candidate beats the PATH');
    present.add(candidates[0]);
    assert.equal(findChrome(), candidates[0], 'the first candidate beats a later one');
  });
}

test('findChrome then looks along the PATH, and skips its empty entries', t => {
  const present = files(t);
  present.add('/b/chromium');
  t.mock.property(process, 'platform', 'freebsd');
  t.mock.property(process, 'env', { PATH: '/a::/b' });

  assert.equal(findChrome(), '/b/chromium');
});

test('findChrome answers undefined when there is no browser, with or without a PATH', t => {
  files(t);
  t.mock.property(process, 'platform', 'freebsd');
  const env: Record<string, string> = { PATH: '/a:/b' };
  t.mock.property(process, 'env', env);
  assert.equal(findChrome(), undefined);

  delete env.PATH;
  assert.equal(findChrome(), undefined);
});

test('launch makes the profile, clears an old port file, then starts the browser on it with a debug port of its own', async t => {
  const w = world(t);

  const chrome = await Chrome.launch(BOOT);

  assert.deepEqual(w.order, ['mkdir', 'rm', 'spawn']);
  assert.deepEqual(calls(w.mkdir), [['/profiles/one', { recursive: true }]]);
  assert.deepEqual(calls(w.rm), [['/profiles/one/DevToolsActivePort', { force: true }]]);
  assert.deepEqual(calls(w.spawn), [['/opt/chrome', DEFAULT_FLAGS, { stdio: 'ignore' }]]);
  assert.deepEqual(calls(w.readFile), [['/profiles/one/DevToolsActivePort', 'utf8']]);
  assert.deepEqual(
    w.fetched.mock.calls.map(call => call.arguments[0]),
    ['http://127.0.0.1:9333/json/version'],
  );
  assert.deepEqual(calls(w.open), [[WS_URL, {}]]);
  assert.deepEqual(
    [chrome.browser, chrome.port, chrome.launched, chrome.connection],
    ['Chrome/141.0.7390.107', 9333, true, w.connection],
  );
});

test('launch can show the window, and adds its own flags after the defaults and before the blank tab', async t => {
  const w = world(t);

  await Chrome.launch({ ...BOOT, headless: false, args: ['--mute-audio', '--lang=nl-NL'] });

  const flags = w.spawn.mock.calls[0]?.arguments[1] as string[];
  assert.equal(flags.includes('--headless=new'), false);
  assert.deepEqual(flags.slice(-3), ['--mute-audio', '--lang=nl-NL', 'about:blank']);
  assert.equal(flags[0], '--user-data-dir=/profiles/one');
});

test('launch without a binary looks for one', async t => {
  const w = world(t);
  w.present.add('/opt/from-env');
  t.mock.property(process, 'env', { AIVI_CHROME_PATH: '/opt/from-env' });

  await Chrome.launch({ profileDir: '/profiles/one' });

  assert.equal(w.spawn.mock.calls[0]?.arguments[0], '/opt/from-env');
});

test('launch says so when there is no browser to start', async t => {
  const w = world(t);
  t.mock.property(process, 'platform', 'freebsd');
  t.mock.property(process, 'env', {});

  await assert.rejects(
    Chrome.launch({ profileDir: '/profiles/one' }),
    new Error('no Chrome binary found — install Chrome or set AIVI_CHROME_PATH'),
  );

  assert.equal(w.spawn.mock.callCount(), 0);
});

test('launch refuses the default profile, which Chrome would not give a debug port', async t => {
  const w = world(t);

  await assert.rejects(
    Chrome.launch({ ...BOOT, profileDir: '' }),
    new Error('launch needs its own profileDir (Chrome ignores the debug port on the default profile)'),
  );

  assert.equal(w.spawn.mock.callCount(), 0);
});

test('a browser that gives no version is called unknown', async t => {
  const w = world(t);
  versions(w, () => Response.json({ webSocketDebuggerUrl: WS_URL }));

  const chrome = await Chrome.launch(BOOT);

  assert.equal(chrome.browser, 'unknown');
});

test('launch gives its commandMaxTime to the connection', async t => {
  const w = world(t);

  await Chrome.launch({ ...BOOT, commandMaxTime: 700 });

  assert.deepEqual(calls(w.open), [[WS_URL, { commandMaxTime: 700 }]]);
});

for (const [name, exit, message] of [
  ['with its exit code', [1, null], 'chrome exited before reporting a port (code 1) — check the flags'],
  ['with its signal', [null, 'SIGKILL'], 'chrome exited before reporting a port (code SIGKILL) — check the flags'],
] as const) {
  test(`launch fails when the browser exits before it reports a port, ${name}`, async t => {
    const w = world(t);
    portFile(w, null);
    w.child.proc.exitCode = exit[0];
    w.child.proc.signalCode = exit[1];

    await assert.rejects(Chrome.launch({ ...BOOT, pollMs: 1 }), new Error(message));

    assert.equal(w.child.proc.kill.mock.callCount(), 0, 'nothing left to end');
  });
}

test('launch reads the port file again until it holds a port', async t => {
  const w = world(t);
  portFile(w, null, '', 'abc', '0', '70000', '9333\n/devtools/browser/abc');

  const chrome = await Chrome.launch({ ...BOOT, pollMs: 1 });

  assert.equal(w.readFile.mock.callCount(), 6);
  assert.equal(chrome.port, 9333);
});

test('launch gives up on a port that never comes, and ends the browser', async t => {
  const w = world(t);
  portFile(w, null);

  await assert.rejects(
    Chrome.launch({ ...BOOT, startupTimeoutMs: 5, pollMs: 1 }),
    new Error('no DevToolsActivePort in the profile within 5 ms'),
  );

  assert.deepEqual(calls(w.child.proc.kill), [['SIGTERM']]);
});

test('launch kills a browser that ignores SIGTERM once killAfterMs has passed', async t => {
  const w = world(t);
  portFile(w, null);
  w.child.stubborn();

  await assert.rejects(
    Chrome.launch({ ...BOOT, startupTimeoutMs: 5, pollMs: 1, killAfterMs: 5 }),
    new Error('no DevToolsActivePort in the profile within 5 ms'),
  );

  assert.deepEqual(calls(w.child.proc.kill), [['SIGTERM'], ['SIGKILL']]);
});

test('launch asks for the version again until the browser gives one with a websocket', async t => {
  const w = world(t);
  versions(w, unavailable, withoutSocket, () => Promise.reject(new TypeError('fetch failed')) as never, healthy);

  const chrome = await Chrome.launch({ ...BOOT, pollMs: 1 });

  assert.equal(w.fetched.mock.callCount(), 4);
  assert.equal(chrome.browser, 'Chrome/141.0.7390.107');
});

test('launch gives up on a browser that never answers its version, and ends it', async t => {
  const w = world(t);
  versions(w, unavailable);

  await assert.rejects(
    Chrome.launch({ ...BOOT, startupTimeoutMs: 5, pollMs: 1 }),
    new Error('the browser at http://127.0.0.1:9333 never answered /json/version'),
  );

  assert.deepEqual(calls(w.child.proc.kill), [['SIGTERM']]);
});

test('launch fails when the browser exits while it is asked for its version', async t => {
  const w = world(t);
  versions(w, unavailable);
  w.child.proc.exitCode = 2;

  await assert.rejects(
    Chrome.launch({ ...BOOT, pollMs: 1 }),
    new Error('chrome exited before answering /json/version (code 2)'),
  );
});

test('launch ends the browser when the connection to it is refused, and passes the error on', async t => {
  const w = world(t);
  const refused = new CdpError(`could not reach the browser at ${WS_URL}`, 'connectionRefused');
  w.open.mock.mockImplementation(async () => {
    throw refused;
  });

  await assert.rejects(Chrome.launch(BOOT), refused);

  assert.deepEqual(calls(w.child.proc.kill), [['SIGTERM']]);
});

test('a binary that cannot be started fails the launch with the reason, and does not end the process', async t => {
  const w = world(t);
  portFile(w, null);
  const failure = Object.assign(new Error('spawn /opt/chrome ENOENT'), { code: 'ENOENT' });
  w.spawn.mock.mockImplementation(() => {
    // spawn tells a binary it cannot start on the next tick: the codes are set, then an error is said
    process.nextTick(() => {
      w.child.proc.exitCode = -2;
      w.child.proc.emit('error', failure);
    });
    return w.child.proc as unknown as ChildProcess;
  });

  await assert.rejects(Chrome.launch({ ...BOOT, pollMs: 1 }), failure);
});

test('attach with a websocket url skips the discovery, and takes the port from the url', async t => {
  const w = world(t);

  const chrome = await Chrome.attach({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' });

  assert.equal(w.fetched.mock.callCount(), 0);
  assert.deepEqual(calls(w.open), [['ws://127.0.0.1:9222/devtools/browser/abc', {}]]);
  assert.deepEqual([chrome.browser, chrome.port, chrome.launched], ['unknown', 9222, false]);
});

test('attach asks the debug url where the websocket is, and trusts the answer over the question', async t => {
  const w = world(t);
  versions(w, () =>
    Response.json({ Browser: 'Chrome/141', webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/x' }),
  );

  const chrome = await Chrome.attach({ debugUrl: 'http://127.0.0.1:9444' });

  assert.deepEqual(
    w.fetched.mock.calls.map(call => call.arguments[0]),
    ['http://127.0.0.1:9444/json/version'],
  );
  assert.deepEqual(calls(w.open), [['ws://127.0.0.1:9555/devtools/browser/x', {}]]);
  assert.deepEqual([chrome.browser, chrome.port], ['Chrome/141', 9555]);
});

test('attach looks at port 9222 of this machine unless told otherwise', async t => {
  const w = world(t);

  await Chrome.attach();

  assert.deepEqual(
    w.fetched.mock.calls.map(call => call.arguments[0]),
    ['http://127.0.0.1:9222/json/version'],
  );
});

test('attach gives up after timeoutMs when nothing answers', async t => {
  const w = world(t);
  versions(w, unavailable);

  await assert.rejects(
    Chrome.attach({ timeoutMs: 5, pollMs: 1 }),
    new Error('the browser at http://127.0.0.1:9222 never answered /json/version'),
  );

  assert.equal(w.open.mock.callCount(), 0);
});

test('a browser that takes the request and never answers does not outlast timeoutMs', async t => {
  const w = world(t);
  // a stalled endpoint: the request ends only when its signal is aborted
  w.fetched.mock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );

  await assert.rejects(
    Chrome.attach({ timeoutMs: 5, pollMs: 1 }),
    new Error('the browser at http://127.0.0.1:9222 never answered /json/version'),
  );
});

test('attach gives its commandMaxTime to the connection', async t => {
  const w = world(t);

  await Chrome.attach({ wsUrl: WS_URL, commandMaxTime: 700 });

  assert.deepEqual(calls(w.open), [[WS_URL, { commandMaxTime: 700 }]]);
});

test('close ends a launched browser politely, and waits for it to go', async t => {
  const w = world(t);
  const chrome = await Chrome.launch(BOOT);

  await chrome.close();

  assert.deepEqual(calls(w.child.proc.kill), [['SIGTERM']]);
  assert.equal(w.connection.close.mock.callCount(), 1);
});

test('close kills a browser that ignores SIGTERM once killAfterMs has passed', async t => {
  const w = world(t);
  w.child.stubborn();
  const chrome = await Chrome.launch({ ...BOOT, killAfterMs: 5 });

  await chrome.close();

  assert.deepEqual(calls(w.child.proc.kill), [['SIGTERM'], ['SIGKILL']]);
});

test('by default a browser gets 5 seconds to end before it is killed', async t => {
  const w = world(t);
  const chrome = await Chrome.launch(BOOT);
  const timers = t.mock.method(globalThis, 'setTimeout');

  await chrome.close();

  assert.deepEqual(
    timers.mock.calls.map(call => call.arguments[1]),
    [5_000],
  );
  assert.equal(w.child.proc.kill.mock.callCount(), 1);
});

test('close is done once, and does not end a browser that is already gone', async t => {
  const w = world(t);
  const chrome = await Chrome.launch(BOOT);
  w.child.exit(1);

  await chrome.close();
  await chrome.close();

  assert.equal(w.child.proc.kill.mock.callCount(), 0);
  assert.equal(w.connection.close.mock.callCount(), 1);
});

test('close leaves an attached browser running', async t => {
  const w = world(t);
  const chrome = await Chrome.attach({ wsUrl: WS_URL });

  await chrome.close();

  assert.equal(w.connection.close.mock.callCount(), 1);
  assert.equal(w.child.proc.kill.mock.callCount(), 0);
  assert.equal(w.spawn.mock.callCount(), 0);
});

test('onGone tells once when the browser goes away on its own', async t => {
  const w = world(t);
  const chrome = await Chrome.attach({ wsUrl: WS_URL });
  const gone: string[] = [];
  chrome.onGone(() => gone.push('gone'));

  w.connection.dispatchEvent(new Event('close'));
  w.connection.dispatchEvent(new Event('close'));

  assert.deepEqual(gone, ['gone']);
});

test('onGone does not tell about our own close', async t => {
  const w = world(t);
  w.connection.close.mock.mockImplementation(() => {
    w.connection.dispatchEvent(new Event('close'));
  });
  const chrome = await Chrome.attach({ wsUrl: WS_URL });
  const gone: string[] = [];
  chrome.onGone(() => gone.push('gone'));

  await chrome.close();

  assert.deepEqual(gone, []);
});

test('newTab opens a blank target and attaches to it with a flat session', async t => {
  const w = world(t);
  w.connection.answers['Target.createTarget'] = { targetId: 'target-7' };
  w.connection.answers['Target.attachToTarget'] = { sessionId: 'session-7' };
  const chrome = await Chrome.attach({ wsUrl: WS_URL });

  const tab = await chrome.newTab();

  assert.deepEqual([tab.targetId, tab.sessionId], ['target-7', 'session-7']);
  assert.deepEqual(w.connection.sent(), [
    ['Target.createTarget', { url: 'about:blank' }],
    ['Target.attachToTarget', { targetId: 'target-7', flatten: true }],
  ]);
});
