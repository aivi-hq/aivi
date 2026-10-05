/** The exec door as a unit: its protocol, its closed env, its kill rules —
 *  driven without spawning anything. Every child the door builds is a scripted
 *  answer with its spawn arguments on record; whether the OS can spawn and
 *  whether node-pty can drive a terminal are the live gate's subject, not
 *  this file's. */
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { configSchema, getLogger } from '@aivi/core';
import { createApp, Store, serveApp } from '@aivi/host';
import { WebSocket } from 'ws';
import { attachExec } from '../src/api/exec.ts';
import { hostVersion } from '../src/version.ts';

const log = getLogger(['aivi', 'test']);

/** Async poll until true; the door answers when it answers, tests never assume timing. */
const until = async (probe: () => boolean | Promise<boolean>, what = 'the exec session'): Promise<void> => {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/** A pipe child as the door sees it: everything the door handed it is on
 *  record — the closed env, the argv, the writes — and the test answers with
 *  stream data and an exit whenever it likes. */
class FakeChild {
  readonly pid = 4242;
  readonly kills: (string | undefined)[] = [];
  /** What the door wrote toward stdin, already rejoined from split frames. */
  readonly written: string[] = [];
  readonly command: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  private handlers = new Map<string, ((chunk: Buffer) => void)[]>();
  private exit: (code: number | null) => void = () => {};
  private failure: (error: Error) => void = () => {};
  readonly stdout = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.handlers.set('stdout', [...(this.handlers.get('stdout') ?? []), cb]);
    },
  };
  readonly stderr = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.handlers.set('stderr', [...(this.handlers.get('stderr') ?? []), cb]);
    },
  };
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
    on: (_event: 'error', _cb: (error: Error) => void): void => {},
  };
  constructor(command: string, argv: string[], cwd: string, env: Record<string, string>) {
    this.command = command;
    this.argv = argv;
    this.cwd = cwd;
    this.env = env;
  }
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  on(event: 'close' | 'error', cb: (arg: never) => void): void {
    if (event === 'close') this.exit = cb as (code: number | null) => void;
    else this.failure = cb as (error: Error) => void;
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  says(text: string): void {
    for (const handler of this.handlers.get('stdout') ?? []) handler(Buffer.from(text, 'utf8'));
  }
  complains(text: string): void {
    for (const handler of this.handlers.get('stderr') ?? []) handler(Buffer.from(text, 'utf8'));
  }
  died(code: number | null): void {
    this.exit(code);
  }
  broke(error: Error): void {
    this.failure(error);
  }
}

/** A PTY child as the door sees it: spawn options on record, scripted output,
 *  and every write/resize/kill the door sends. */
class FakePty {
  readonly pid = 4243;
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = 0;
  private data: ((data: string) => void) | undefined;
  private exit: ((exit: { exitCode: number | null }) => void) | undefined;
  argv: string[];
  options: { name?: string; cols?: number; rows?: number; env?: Record<string, string> };
  constructor(argv: string[], options: { name?: string; cols?: number; rows?: number; env?: Record<string, string> }) {
    this.argv = argv;
    this.options = options;
  }
  onData(cb: (data: string) => void): void {
    this.data = cb;
  }
  onExit(cb: (exit: { exitCode: number | null }) => void): void {
    this.exit = cb;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed++;
  }
  says(text: string): void {
    this.data?.(text);
  }
  exited(code: number | null): void {
    this.exit?.({ exitCode: code });
  }
}

/** A host with the exec door. Every child the door builds lands in
 *  `children` (pipe) or `ptys` (PTY) for the test to interrogate and answer. */
const harness = async (t: TestContext, options: { importPty?: () => Promise<typeof import('node-pty')> } = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-exec-'));
  await mkdir(home, { recursive: true });
  const store = new Store(':memory:');
  const loaded = {
    path: join(home, 'config.json'),
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  const http = serveApp(createApp({ store, loaded, log }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const abort = new AbortController();
  const children: FakeChild[] = [];
  const attach: Parameters<typeof attachExec>[1] = {
    store,
    loaded,
    log,
    signal: abort.signal,
    spawnPipe: (command, argv, spawnOptions) => {
      const child = new FakeChild(command, argv, spawnOptions.cwd, spawnOptions.env);
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    ...(options.importPty ? { importPty: options.importPty } : {}),
  };
  attachExec(http, attach);
  const operator = store.createPerson({ name: 'Ada', roles: ['operator'] });
  const { secret } = store.mintToken(operator.id, 'laptop');
  t.after(async () => {
    abort.abort();
    await new Promise<void>(resolve => http.close(() => resolve()));
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return { store, home, port, secret, children };
};

const headers = (bearer?: string) => ({
  'x-aivi-client': hostVersion,
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
});

/** A fake PTY loader: every spawn lands in `ptys`. */
const ptyLoader = (ptys: FakePty[]) => (): typeof import('node-pty') =>
  ({
    spawn: (_command: string, argv: string[], options: never) => {
      const pty = new FakePty(argv, options);
      ptys.push(pty);
      return pty as unknown as ReturnType<typeof import('node-pty').spawn>;
    },
  }) as unknown as typeof import('node-pty');

/** An upgrade the door must refuse: the HTTP answer it wrote, nothing else. */
const refused = async (port: number, requestHeaders: Record<string, string>, path = '/exec') => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: requestHeaders });
  ws.on('error', () => {}); // the aborted socket is news to nobody after the refusal
  return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    ws.on('unexpected-response', (_request, response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => (text += chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }),
      );
    });
    ws.on('open', () => reject(new Error('connected; the door was expected to refuse')));
  });
};

/** One open connection: send `start` (plus bytes), collect frames. */
const connect = async (port: number, bearer: string, start: Record<string, unknown>, bytes: Buffer[] = []) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/exec`, { headers: headers(bearer) });
  const events: Record<string, unknown>[] = [];
  let stdout = '';
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) stdout += data.toString('utf8');
    else {
      try {
        events.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      } catch {
        stdout += data.toString('utf8'); // PTY bytes ride as text frames: they are output, not events
      }
    }
  });
  ws.on('error', () => {}); // after the open, a dropped socket is the child's answer
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify(start));
  for (const chunk of bytes) ws.send(chunk);
  return {
    ws,
    events,
    get stdout() {
      return stdout;
    },
    exit: () => until(() => events.some(event => event.t === 'exit') || ws.readyState === WebSocket.CLOSED),
  };
};

const auditRows = (store: Store) => store.requests({ method: 'EXEC' });

test('the anonymous upgrade is refused 401 and the refusal is audited', async t => {
  const { store, port } = await harness(t);
  const answer = await refused(port, headers());
  assert.equal(answer.status, 401);
  assert.match(String(answer.body.error), /names who you are/);
  const [row] = auditRows(store);
  assert.equal(row!.status, 401);
  assert.equal(row!.path, '/exec');
  assert.ok(JSON.parse(row!.body!).address, 'the source address is on the line');
});

test('a stranger path gets 404 even for an operator', async t => {
  const { store, port, secret } = await harness(t);
  const answer = await refused(port, headers(secret), '/nope');
  assert.equal(answer.status, 404);
  assert.equal(auditRows(store)[0]!.status, 404);
});

test('the version gate answers before the bearer is ever asked', async t => {
  const { port } = await harness(t);
  // A client *behind* the host is served by contract; only an ahead one is
  // refused — and refused here with no bearer in sight: the gate is first.
  const answer = await refused(port, { 'x-aivi-client': '99.0.0' });
  assert.equal(answer.status, 403);
  assert.equal(answer.body.code, 'server_version_too_low');
});

test('a person who is not an operator is refused and named in the answer', async t => {
  const { store, port } = await harness(t);
  const stranger = store.createPerson({ name: 'Eve', roles: [] });
  const { secret } = store.mintToken(stranger.id, 'laptop');
  const answer = await refused(port, headers(secret));
  assert.equal(answer.status, 403);
  assert.match(String(answer.body.error), /operator/);
  assert.equal((answer.body.person as { name: string }).name, 'Eve');
});

test('a piped session runs aivi with the bearer in its closed env and keeps stderr apart', async t => {
  process.env.DISCORD_BOT_TOKEN = 'must-never-travel';
  t.after(() => {
    delete process.env.DISCORD_BOT_TOKEN;
  });
  const { store, home, port, secret, children } = await harness(t);
  const done = await connect(port, secret, { t: 'start', argv: ['status'], pty: false });
  await until(() => children.length === 1, 'the door built the pipe child');
  const child = children[0]!;
  assert.equal(child.command, 'aivi', 'the door execs the aivi command, not a shell');
  assert.deepEqual(child.argv, ['status']);
  assert.equal(child.cwd, home, 'the child works in the host’s home');
  assert.equal(child.env.AIVI_OPERATOR_BEARER, secret, 'the child carries this connection’s bearer (D15)');
  assert.equal(child.env.AIVI_HOME, home);
  assert.equal(child.env.TERM, 'xterm-256color');
  assert.equal(child.env.AIVI_EXEC_SESSION, '1', 'the machine fact rides so the child answers its guard lines');
  assert.ok(!('DISCORD_BOT_TOKEN' in child.env), 'the host secrets stayed out of the child env');
  assert.ok(
    done.events.some(event => event.t === 'ready' && event.pid === 4242),
    'ready names the pid',
  );
  child.says('the answer\n');
  child.complains('ooh\n');
  child.died(3);
  await done.exit();
  assert.equal(done.stdout, 'the answer\n');
  const err = done.events.find(event => event.t === 'err');
  assert.equal(Buffer.from(String(err!.b64), 'base64').toString('utf8'), 'ooh\n', 'stderr kept its own channel');
  assert.equal(done.events.find(event => event.t === 'exit')!.code, 3);
  const [row] = auditRows(store);
  assert.equal(row!.status, 101);
  const audited = JSON.parse(row!.body!) as Record<string, unknown>;
  assert.deepEqual(audited.argv, ['status']);
  assert.equal(audited.exitCode, 3);
  assert.equal((audited.person as { name: string }).name, 'Ada');
  done.ws.terminate();
});

test('stdin bytes reach the child and rejoin when a character splits across frames', async t => {
  const { port, secret, children } = await harness(t);
  const done = await connect(port, secret, { t: 'start', argv: ['echo'], pty: false }, [
    Buffer.from('h\xc3', 'binary'),
    Buffer.from('\xa9llo\n', 'binary'),
  ]);
  await until(() => children.length === 1);
  assert.equal(children[0]!.written.join(''), 'héllo\n', 'a utf8 character split mid-frame still reaches the child');
  done.ws.terminate();
});

test('a PTY session runs the CLI on a terminal and reports its exit code', async t => {
  const ptys: FakePty[] = [];
  const { port, secret } = await harness(t, { importPty: async () => ptyLoader(ptys)() });
  const done = await connect(port, secret, { t: 'start', argv: ['jobs', 'list'] });
  await until(() => ptys.length === 1, 'the door built the PTY child');
  const pty = ptys[0]!;
  assert.deepEqual(pty.argv, ['jobs', 'list']);
  assert.equal(pty.options.env?.AIVI_OPERATOR_BEARER, secret, 'the PTY child carries this connection’s bearer');
  assert.ok(
    done.events.some(event => event.t === 'ready' && event.pid === 4243),
    'the PTY child announced itself',
  );
  pty.says('argv:jobs list\r\n');
  pty.exited(3);
  await done.exit();
  assert.equal(done.stdout, 'argv:jobs list\r\n');
  assert.equal(done.events.find(event => event.t === 'exit')!.code, 3);
  done.ws.terminate();
});

test('the start message sizes the terminal', async t => {
  const ptys: FakePty[] = [];
  const { port, secret } = await harness(t, { importPty: async () => ptyLoader(ptys)() });
  const asked = await connect(port, secret, { t: 'start', argv: ['winsize'], cols: 90, rows: 30 });
  await until(() => ptys.length === 1);
  assert.equal(ptys[0]!.options.cols, 90, 'the window the client asked for rides to the PTY');
  assert.equal(ptys[0]!.options.rows, 30);
  // A start without a size gets the sane defaults, not a zero window.
  const sizeless = await connect(port, secret, { t: 'start', argv: ['winsize'] });
  await until(() => ptys.length === 2);
  assert.deepEqual([ptys[1]!.options.cols, ptys[1]!.options.rows], [80, 24], 'defaults for a sizeless start');
  asked.ws.terminate();
  sizeless.ws.terminate();
});

test('a resize mid-session moves the PTY window', async t => {
  const ptys: FakePty[] = [];
  const { port, secret } = await harness(t, { importPty: async () => ptyLoader(ptys)() });
  const done = await connect(port, secret, { t: 'start', argv: ['winsize'] });
  await until(() => ptys.length === 1);
  done.ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 40 }));
  await until(() => ptys[0]!.resizes.length === 1);
  assert.deepEqual(ptys[0]!.resizes[0], [100, 40], 'the window followed the resize');
  done.ws.terminate();
});

test('a disconnect kills the child with the session', async t => {
  const { store, port, secret, children } = await harness(t);
  const done = await connect(port, secret, { t: 'start', argv: ['linger'], pty: false });
  await until(() => children.length === 1);
  done.ws.close(); // the client hangs up; the child must not outlive the session
  await until(() => children[0]!.kills.length === 1);
  assert.deepEqual(children[0]!.kills, ['SIGTERM']);
  await until(
    () => auditRows(store).some(row => JSON.parse(row.body!).reason === 'connection closed'),
    'the close is audited',
  );
});

test('a host whose node-pty cannot load answers exec attempts plainly', async t => {
  const { store, port, secret } = await harness(t, {
    importPty: () => Promise.reject(new Error('no prebuilt binary on this machine')),
  });
  const done = await connect(port, secret, { t: 'start', argv: ['status'] });
  await done.exit();
  assert.match(done.stdout, /remote exec unavailable on this host/);
  assert.equal(done.events.find(event => event.t === 'exit')!.code, 1);
  const [row] = auditRows(store);
  assert.equal(JSON.parse(row!.body!).reason, 'pty unavailable');
  done.ws.terminate();
});

test('a child that cannot spawn degrades the same honest way', async t => {
  const { store, port, secret, children } = await harness(t);
  const done = await connect(port, secret, { t: 'start', argv: ['status'], pty: false });
  await until(() => children.length === 1);
  children[0]!.broke(Object.assign(new Error('spawn aivi ENOENT'), { code: 'ENOENT' }));
  await done.exit();
  assert.match(done.stdout, /remote exec unavailable on this host/);
  assert.equal(done.events.find(event => event.t === 'exit')!.code, 1);
  const [row] = auditRows(store);
  assert.equal(JSON.parse(row!.body!).reason, 'spawn failed');
});

test('a second start on one connection answers an error, not a second child', async t => {
  const { port, secret, children } = await harness(t);
  const done = await connect(port, secret, { t: 'start', argv: ['first'], pty: false });
  done.ws.send(JSON.stringify({ t: 'start', argv: ['second'], pty: false }));
  await until(() => done.events.some(event => event.t === 'error'));
  assert.ok(done.events.some(event => event.t === 'error' && event.message === 'start sent twice'));
  await until(() => children.length === 1);
  assert.equal(done.events.filter(event => event.t === 'ready').length, 1, 'exactly one child ran');
  done.ws.terminate();
});

test('a second start racing the pty import is told, not spawned', async t => {
  // The guard must hold while the first start still awaits the import: the
  // session is owned by the start, not by the child it has not built yet.
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const ptys: FakePty[] = [];
  const { port, secret } = await harness(t, {
    importPty: async () => {
      await gate;
      return ptyLoader(ptys)();
    },
  });
  const done = await connect(port, secret, { t: 'start', argv: ['status'] });
  // Both frames land before the import resolves: the first owns the session.
  done.ws.send(JSON.stringify({ t: 'start', argv: ['status'] }));
  await until(() => done.events.some(event => event.t === 'error'));
  assert.match(String(done.events.find(event => event.t === 'error')!.message), /start sent twice/);
  assert.equal(ptys.length, 0, 'nothing spawned while the import was still in flight');
  release();
  await until(() => done.events.some(event => event.t === 'ready'));
  assert.equal(ptys.length, 1, 'the start that was already in flight spawned exactly one child');
  done.ws.terminate();
});
