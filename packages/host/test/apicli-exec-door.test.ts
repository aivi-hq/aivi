/** The exec door as a unit over fakes: who it lets in, what it runs, what it
 *  hands the child, how bytes and frames travel, and how a session ends. The
 *  HTTP server is an emitter the door hangs its upgrade handler on, `ws` is a
 *  module mock whose connections are fakes the test speaks through, and every
 *  child is a fake: no socket is opened and nothing is spawned. node-pty's
 *  loader (`node-pty` is a module mock) and node's `spawn` are reached through
 *  the door's own defaults. */
import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import Module, { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { beforeEach, mock, type TestContext, test } from 'node:test';
import { Store } from '../src/store.ts';
import { hostVersion } from '../src/version.ts';
import { loadedWith } from './apicli-fixture.ts';
import { recorder } from './support.ts';

/** A connection as the door holds it: the frames it sent are on record, and
 *  the test plays the client by emitting frames at it. */
class Connection extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  /** Settles when the door announces its child with a ready frame. */
  readonly ready: Promise<void>;
  readonly frames: { binary: boolean; data: Buffer }[] = [];
  closed = 0;
  terminated = 0;
  #announce: () => void = () => {};

  constructor() {
    super();
    this.ready = new Promise(resolve => {
      this.#announce = resolve;
    });
  }

  send(data: string | Buffer): void {
    this.frames.push({ binary: typeof data !== 'string', data: Buffer.from(data) });
    if (typeof data === 'string' && (JSON.parse(data) as { t: string }).t === 'ready') this.#announce();
  }
  close(): void {
    this.closed++;
    this.readyState = 2;
  }
  terminate(): void {
    this.terminated++;
    this.readyState = 3;
  }
  /** The control frames the door sent, in order. */
  events(): Record<string, unknown>[] {
    return this.frames.filter(frame => !frame.binary).map(frame => JSON.parse(frame.data.toString('utf8')));
  }
  /** What the door sent as terminal bytes. */
  output(): string {
    return Buffer.concat(this.frames.filter(frame => frame.binary).map(frame => frame.data)).toString('utf8');
  }
  /** The client sends a control message. */
  says(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  /** The client sends terminal bytes. */
  types(bytes: Buffer | string): void {
    this.emit('message', Buffer.from(bytes), true);
  }
}

const accepted: Connection[] = [];
const closedServers = mock.fn();
class WebSocketServer {
  handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, accept: (ws: Connection) => void): void {
    const connection = new Connection();
    accepted.push(connection);
    accept(connection);
  }
  close(): void {
    closedServers();
  }
}

/** A child on a pseudo-terminal, as node-pty hands it over. */
function ptyChild() {
  const events = new EventEmitter();
  return {
    pid: 4243,
    write: mock.fn((_bytes: string) => {}),
    resize: mock.fn((_cols: number, _rows: number) => {}),
    kill: mock.fn(),
    onData: (callback: (data: string) => void) => events.on('data', callback),
    onExit: (callback: (exit: { exitCode: number | null }) => void) => events.on('exit', callback),
    says: (text: string) => events.emit('data', text),
    exits: (exitCode: number | null) => events.emit('exit', { exitCode }),
  };
}
type PtyChild = ReturnType<typeof ptyChild>;

/** A child on plain pipes, as node's spawn hands it over. */
function pipeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof mock.fn> };
    kill: ReturnType<typeof mock.fn>;
  };
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: mock.fn() });
  child.kill = mock.fn();
  return child;
}

const ptys: PtyChild[] = [];
const ptySpawn = mock.fn((_command: string, _argv: string[], _options: unknown) => {
  const pty = ptyChild();
  ptys.push(pty);
  return pty;
});
const importPty = async () => ({ spawn: ptySpawn }) as never;

mock.module('ws', { exports: { WebSocketServer } });
mock.module('node-pty', { exports: { spawn: ptySpawn } });

const { attachExec } = await import('../src/api/exec.ts');

beforeEach(() => {
  accepted.length = 0;
  ptys.length = 0;
  ptySpawn.mock.resetCalls();
  closedServers.mock.resetCalls();
});

const home = '/aivi-home';

/** The door attached to an emitter, with an operator who can connect and
 *  the audit rows it has written. */
function door(t: TestContext, deps: Partial<Parameters<typeof attachExec>[1]> = {}) {
  const store = new Store(':memory:');
  const abort = new AbortController();
  const server = new EventEmitter();
  const log = recorder();
  t.after(() => {
    abort.abort();
    store.close();
  });
  attachExec(server as unknown as Server, {
    store,
    loaded: loadedWith({}, { path: `${home}/config.json` }),
    log: log.log,
    signal: abort.signal,
    ...deps,
  });
  const operator = store.createPerson({ name: 'Ada', roles: ['operator'] });
  const secret = store.mintToken(operator.id, 'laptop').secret;

  /** One arrival at the upgrade handler; `socket` is where a refusal is written. */
  const arrive = (request: { url?: string; headers?: Record<string, string>; address?: string }) => {
    const socket = { write: mock.fn((_response: string) => true), destroy: mock.fn() };
    const req = { url: request.url, headers: request.headers ?? {}, socket: { remoteAddress: request.address } };
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    return socket;
  };
  /** What a refusal said: the status line and the JSON body. */
  const refusal = (socket: ReturnType<typeof arrive>) => {
    const [head, body] = socket.write.mock.calls[0]!.arguments[0].split('\r\n\r\n') as [string, string];
    return { status: Number(/^HTTP\/1\.1 (\d+) Refused/.exec(head)![1]), body: JSON.parse(body) };
  };
  return {
    store,
    abort,
    log,
    secret,
    operator,
    arrive,
    refusal,
    /** An operator’s connection, let in; `null` is a socket that reports no address. */
    connect: (address: string | null = '203.0.113.9') => {
      arrive({
        url: '/exec',
        ...(address === null ? {} : { address }),
        headers: { 'x-aivi-client': hostVersion, authorization: `Bearer ${secret}` },
      });
      return accepted.at(-1)!;
    },
    audit: () =>
      store
        .requests({ method: 'EXEC' })
        .map(row => ({ ...JSON.parse(row.body!), status: row.status, headers: row.headers })),
  };
}

/** These variables set (undefined: unset) until the test ends. */
function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** A built-in replaced until the test ends, the named ESM exports kept in step. */
function restoreBuiltins(t: TestContext) {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

// This one runs first on purpose: the repair is once per process, and the
// first session of the file is the one that carries it.
test('on macOS the door repairs node-pty’s spawn helper once per process, and a read-only install still gets its session', async t => {
  t.mock.property(process, 'platform', 'darwin');
  t.mock.property(process, 'arch', 'x64');
  const helper = '/fake/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper';
  const exists = t.mock.method(fs, 'existsSync', () => true);
  const chmod = t.mock.method(fs, 'chmodSync', () => {
    throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
  });
  const requireFrom = t.mock.method(Module, 'createRequire', () => ({
    resolve: () => '/fake/node_modules/node-pty/lib/index.js',
  }));
  restoreBuiltins(t);
  const d = door(t, { importPty });

  for (const _session of [1, 2]) {
    const ws = d.connect();
    ws.says({ t: 'start', argv: ['status'] });
    await ws.ready;
  }

  assert.equal(ptySpawn.mock.callCount(), 2, 'a repair that could not happen never stops the session');
  assert.match(String(requireFrom.mock.calls[0]!.arguments[0]), /\/src\/api\/exec\.ts$/);
  const asked = (spy: typeof exists | typeof chmod) =>
    spy.mock.calls.map(call => call.arguments).filter(([path]) => String(path).endsWith('spawn-helper'));
  assert.deepEqual(asked(exists), [[helper]]);
  assert.deepEqual(asked(chmod), [[helper, 0o755]], 'the execute bit, asked for once however many sessions follow');
});

test('the anonymous, the silent and the unwelcome are refused with the reason, and each refusal is audited', async t => {
  const d = door(t);
  const stranger = d.store.createPerson({ name: 'Eve', roles: [] });
  const strangerToken = d.store.mintToken(stranger.id, 'laptop').secret;
  const client = { 'x-aivi-client': hostVersion };

  const lost = d.arrive({});
  assert.deepEqual(d.refusal(lost), { status: 404, body: { error: 'Not found' } }, 'a request with no url is the root');
  const silent = d.arrive({ url: '/exec', headers: { authorization: 'Bearer anything' } });
  const refusedSilent = d.refusal(silent);
  assert.deepEqual(
    [refusedSilent.status, refusedSilent.body.code, refusedSilent.body.minVersion],
    [403, 'client_version_unsupported', hostVersion],
    'a client that names no version is not served',
  );
  const anonymous = d.arrive({ url: '/exec', headers: client, address: '203.0.113.9' });
  assert.equal(d.refusal(anonymous).status, 401);
  const unknown = d.arrive({ url: '/exec', headers: { ...client, authorization: 'Bearer aivi-unknown' } });
  assert.equal(d.refusal(unknown).status, 401);
  const member = d.arrive({ url: '/exec', headers: { ...client, authorization: `Bearer ${strangerToken}` } });
  assert.deepEqual(d.refusal(member), {
    status: 403,
    body: { error: 'Only an operator can drive this host remotely', person: { id: stranger.id, name: 'Eve' } },
  });

  for (const socket of [lost, silent, anonymous, unknown, member]) assert.equal(socket.destroy.mock.callCount(), 1);
  assert.equal(accepted.length, 0, 'nobody was let in');
  assert.deepEqual(
    d.audit().map(row => [row.status, row.address, row.headers]),
    [
      [404, null, {}],
      [403, null, { authorization: '[present]' }],
      [401, '203.0.113.9', { 'x-aivi-client': hostVersion }],
      [401, null, { 'x-aivi-client': hostVersion, authorization: '[present]' }],
      [403, null, { 'x-aivi-client': hostVersion, authorization: '[present]' }],
    ],
    'the address is the one the socket reported, or null; a credential is only ever said to be present',
  );
});

test('a session runs aivi on a terminal through the loader of its own, and its end is audited with who, what and where from', async t => {
  environment(t, {
    PATH: '/opt/bin',
    HOME: '/Users/ada',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    DISCORD_BOT_TOKEN: 'must-never-travel',
  });
  const d = door(t);
  const ws = d.connect();
  ws.says({ t: 'start', argv: ['jobs', 'list'], term: 'screen', cols: 120, rows: 50 });
  await ws.ready;

  assert.deepEqual(ptySpawn.mock.calls[0]!.arguments, [
    'aivi',
    ['jobs', 'list'],
    {
      name: 'screen',
      cols: 120,
      rows: 50,
      cwd: home,
      env: {
        PATH: '/opt/bin',
        HOME: '/Users/ada',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
        AIVI_HOME: home,
        TERM: 'screen',
        AIVI_OPERATOR_BEARER: d.secret,
        AIVI_EXEC_SESSION: '1',
      },
    },
  ]);
  assert.deepEqual(ws.events(), [{ t: 'ready', pid: 4243 }]);

  ptys[0]!.says('2 jobs\r\n');
  assert.equal(ws.output(), '2 jobs\r\n');
  ptys[0]!.exits(3);
  assert.deepEqual(ws.events().at(-1), { t: 'exit', code: 3 });
  assert.equal(ws.closed, 1);
  assert.deepEqual(d.audit(), [
    {
      status: 101,
      person: { id: d.operator.id, name: 'Ada' },
      address: '203.0.113.9',
      exitCode: 3,
      argv: ['jobs', 'list'],
      headers: { 'x-aivi-client': hostVersion, authorization: '[present]' },
    },
  ]);
  ws.emit('close');
  assert.equal(d.audit().length, 1, 'one line per session: the close after the exit adds none');
  assert.equal(ptys[0]!.kill.mock.callCount(), 0, 'a child that has gone is not killed again');
});

for (const [name, variables, expected] of [
  [
    'the child’s environment names the system defaults when the host has none',
    { PATH: undefined, HOME: undefined, COLORTERM: undefined, LANG: undefined },
    { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/fallback-home' },
  ],
  [
    'the child’s environment carries only the terminal and locale hints the host has',
    { PATH: '/opt/bin', HOME: '/Users/ada', COLORTERM: 'truecolor', LANG: undefined },
    { PATH: '/opt/bin', HOME: '/Users/ada', COLORTERM: 'truecolor' },
  ],
] as const)
  test(name, async t => {
    environment(t, variables);
    t.mock.method(os, 'homedir', () => '/fallback-home');
    restoreBuiltins(t);
    const d = door(t, { importPty });
    const ws = d.connect(null);
    ws.says({ t: 'start', argv: ['status'] });
    await ws.ready;
    const { env, name: term } = ptySpawn.mock.calls[0]!.arguments[2] as { env: Record<string, string>; name: string };
    assert.deepEqual(env, {
      ...expected,
      AIVI_HOME: home,
      TERM: 'xterm-256color',
      AIVI_OPERATOR_BEARER: d.secret,
      AIVI_EXEC_SESSION: '1',
    });
    assert.equal(term, 'xterm-256color', 'a start with no terminal named gets the usual one');
    assert.equal(d.audit().length, 0, 'the session is still running: nothing is audited yet');
    ws.emit('close');
    assert.equal(d.audit()[0]!.address, null, 'a connection that reports no address is audited with none');
  });

test('a piped session runs aivi through node’s spawn, keeps stderr apart, and survives its stdin dying early', async t => {
  const child = pipeChild();
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  restoreBuiltins(t);
  const d = door(t);
  const ws = d.connect();
  ws.says({ t: 'start', argv: ['status'], pty: false });

  const [command, argv, options] = spawn.mock.calls[0]!.arguments as unknown as [
    string,
    string[],
    { cwd: string; env: Record<string, string> },
  ];
  assert.deepEqual(
    [command, argv, options.cwd, options.env.AIVI_OPERATOR_BEARER],
    ['aivi', ['status'], home, d.secret],
  );
  assert.deepEqual(ws.events(), [{ t: 'ready', pid: 4242 }]);
  child.stdout.emit('data', Buffer.from('the answer\n'));
  child.stderr.emit('data', Buffer.from('a warning\n'));
  assert.equal(ws.output(), 'the answer\n');
  const warning = ws.events().find(event => event.t === 'err')!;
  assert.equal(Buffer.from(String(warning.b64), 'base64').toString('utf8'), 'a warning\n');
  assert.doesNotThrow(
    () => child.stdin.emit('error', new Error('write EPIPE')),
    'EPIPE after death is the exit’s news',
  );
  child.emit('close', 3);
  assert.deepEqual(ws.events().at(-1), { t: 'exit', code: 3 });
  assert.equal(d.audit()[0]!.exitCode, 3);
});

test('a child that cannot be spawned degrades plainly, once: its close afterwards adds no second exit', async t => {
  const child = pipeChild();
  const d = door(t, { spawnPipe: () => child as unknown as ChildProcessWithoutNullStreams });
  const ws = d.connect();
  ws.says({ t: 'start', argv: ['status'], pty: false });
  const failure = Object.assign(new Error('spawn aivi ENOENT'), { code: 'ENOENT' });
  child.emit('error', failure);
  child.emit('close', null);

  assert.equal(ws.output(), 'remote exec unavailable on this host\n');
  assert.deepEqual(
    ws.events().filter(event => event.t === 'exit'),
    [{ t: 'exit', code: 1 }],
  );
  assert.deepEqual(
    d.audit().map(row => [row.exitCode, row.reason]),
    [[1, 'spawn failed']],
  );
  assert.deepEqual(d.log.said('warn'), [{ level: 'warn', event: 'exec.unavailable', error: failure }]);
});

for (const [mode, start] of [
  ['a terminal', { t: 'start', argv: ['cat'] }],
  ['plain pipes', { t: 'start', argv: ['cat'], pty: false }],
] as const)
  test(`bytes typed at ${mode} reach the child whole however the frames split them, and none after it has gone`, async t => {
    const pipe = pipeChild();
    const d = door(t, { importPty, spawnPipe: () => pipe as unknown as ChildProcessWithoutNullStreams });
    const ws = d.connect();
    ws.types('before a start there is no child to hear this');
    ws.says(start);
    await ws.ready;
    const written = () =>
      (mode === 'a terminal' ? ptys[0]!.write : pipe.stdin.write).mock.calls.map(call => call.arguments[0]);

    ws.types(Buffer.from([0x68, 0xc3])); // "h" and the first half of "é"
    ws.types(Buffer.from([0xa9, 0x6c])); // the second half, and "l"
    ws.types(Buffer.from([0xe2, 0x82])); // two thirds of "€": nothing to say yet
    ws.types(Buffer.from([0xac]));
    assert.deepEqual(written(), ['h', 'él', '€']);

    if (mode === 'a terminal') ptys[0]!.exits(0);
    else pipe.emit('close', 0);
    ws.types('too late');
    assert.deepEqual(written(), ['h', 'él', '€'], 'the child has gone: nothing more is written');
  });

test('a resize moves a terminal’s window, with absurd sizes falling back to the usual one, and means nothing before a start', async t => {
  const d = door(t, { importPty });
  const ws = d.connect();
  ws.says({ t: 'resize', cols: 100, rows: 40 });
  ws.says({ t: 'start', argv: ['top'] });
  await ws.ready;
  for (const size of [
    { cols: 100, rows: 40 },
    { cols: 5000, rows: -3 },
    { cols: 90.5, rows: '30' },
  ])
    ws.says({ t: 'resize', ...size });
  assert.deepEqual(
    ptys[0]!.resize.mock.calls.map(call => call.arguments),
    [
      [100, 40],
      [80, 24],
      [80, 24],
    ],
  );
});

test('a frame the door cannot read is answered with a plain error, and the session can still start properly', async t => {
  const d = door(t, { importPty });
  const ws = d.connect();
  ws.emit('message', Buffer.from('this is not json'), false);
  assert.deepEqual(ws.events(), [{ t: 'error', message: 'expected one JSON start message' }]);

  for (const unusable of [
    null,
    { t: 'nope' },
    { t: 'start' },
    { t: 'start', argv: [] },
    { t: 'start', argv: [7] },
    { t: 'start', argv: 'status' },
    { t: 'start', argv: ['status'], pty: 'yes' },
  ])
    ws.says(unusable);
  assert.deepEqual(
    ws.events().slice(1),
    Array.from({ length: 7 }, () => ({ t: 'error', message: 'start needs a non-empty string argv' })),
  );
  assert.equal(ptySpawn.mock.callCount(), 0, 'nothing was started, so nothing owns the session yet');

  ws.says({ t: 'start', argv: ['status'] });
  await ws.ready;
  assert.equal(ptySpawn.mock.callCount(), 1);
});

test('a client that hangs up takes its child with it, and the close is audited', async t => {
  const child = pipeChild();
  const d = door(t, { spawnPipe: () => child as unknown as ChildProcessWithoutNullStreams });
  const ws = d.connect();
  ws.says({ t: 'start', argv: ['linger'], pty: false });
  ws.emit('close');
  assert.deepEqual(
    child.kill.mock.calls.map(call => call.arguments),
    [['SIGTERM']],
  );
  assert.deepEqual(
    d.audit().map(row => [row.exitCode, row.reason]),
    [[null, 'connection closed']],
  );
});

test('when the host stops, every live session ends with it: its child is killed and its connection cut', async t => {
  const alive = pipeChild();
  const gone = pipeChild();
  const children = [alive, gone];
  const d = door(t, { importPty, spawnPipe: () => children.shift() as unknown as ChildProcessWithoutNullStreams });
  const piped = d.connect();
  piped.says({ t: 'start', argv: ['linger'], pty: false });
  const finished = d.connect();
  finished.says({ t: 'start', argv: ['done'], pty: false });
  gone.emit('close', 0);
  const terminal = d.connect();
  terminal.says({ t: 'start', argv: ['top'] });
  await terminal.ready;

  d.abort.abort();

  assert.deepEqual(
    alive.kill.mock.calls.map(call => call.arguments),
    [['SIGTERM']],
  );
  assert.equal(ptys[0]!.kill.mock.callCount(), 1);
  assert.equal(gone.kill.mock.callCount(), 0, 'a child that already exited is not killed');
  assert.deepEqual(
    [piped, finished, terminal].map(ws => ws.terminated),
    [1, 0, 1],
    'a session that already ended has gone from the door: the stop leaves it alone',
  );
  assert.equal(closedServers.mock.callCount(), 1);
});
