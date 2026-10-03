import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { configSchema, getLogger } from '@aivi/core';
import { createApp, Store, serveApp } from '@aivi/host';
import { WebSocket } from 'ws';
import { attachExec } from '../src/api/exec.ts';
import { hostVersion } from '../src/version.ts';

const log = getLogger(['aivi', 'test']);

/** Async poll until true; these tests watch children, they never assume timing. */
const until = async (probe: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the exec session');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

/** A host with the exec door, a fixture `aivi` on PATH, and one operator. */
const harness = async (
  t: TestContext,
  script: (home: string) => string,
  options: { importPty?: () => Promise<typeof import('node-pty')> } = {},
) => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-exec-'));
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'aivi'), script(home), { mode: 0o755 });
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
  attachExec(http, { store, loaded, log, signal: abort.signal, ...options });
  const operator = store.createPerson({ name: 'Ada', roles: ['operator'] });
  const { secret } = store.mintToken(operator.id, 'laptop');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(async () => {
    abort.abort();
    await new Promise<void>(resolve => http.close(() => resolve()));
    store.close();
    process.env.PATH = path;
    await rm(home, { recursive: true, force: true });
  });
  return { store, home, port, secret };
};

const headers = (bearer?: string) => ({
  'x-aivi-client': hostVersion,
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
});

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

/** One exec session: send `start` (plus bytes), collect frames until `exit`. */
const session = async (
  port: number,
  bearer: string,
  start: Record<string, unknown>,
  bytes: Buffer[] = [],
): Promise<{ stdout: string; events: Record<string, unknown>[]; exit: Record<string, unknown> | null }> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/exec`, { headers: headers(bearer) });
  const events: Record<string, unknown>[] = [];
  let stdout = '';
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) stdout += data.toString('utf8');
    else events.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('error', () => {}); // after the open, a dropped socket is the child's answer
  await opened;
  ws.send(JSON.stringify(start));
  for (const chunk of bytes) ws.send(chunk);
  await until(() => events.some(event => event.t === 'exit') || ws.readyState === ws.CLOSED, 15000);
  const exit = events.find(event => event.t === 'exit') ?? null;
  ws.terminate();
  return { stdout, events, exit };
};

const auditRows = (store: Store) => store.requests({ method: 'EXEC' });

test('the anonymous upgrade is refused 401 and the refusal is audited', async t => {
  const { store, port } = await harness(t, () => '#!/bin/sh\nexit 0\n');
  const answer = await refused(port, headers());
  assert.equal(answer.status, 401);
  assert.match(String(answer.body.error), /names who you are/);
  const [row] = auditRows(store);
  assert.equal(row!.status, 401);
  assert.equal(row!.path, '/exec');
  assert.ok(JSON.parse(row!.body!).address, 'the source address is on the line');
});

test('a stranger path gets 404 even for an operator', async t => {
  const { store, port, secret } = await harness(t, () => '#!/bin/sh\nexit 0\n');
  const answer = await refused(port, headers(secret), '/nope');
  assert.equal(answer.status, 404);
  assert.equal(auditRows(store)[0]!.status, 404);
});

test('the version gate answers before the bearer is ever asked', async t => {
  const { port } = await harness(t, () => '#!/bin/sh\nexit 0\n');
  // A client *behind* the host is served by contract; only an ahead one is
  // refused — and refused here with no bearer in sight: the gate is first.
  const answer = await refused(port, { 'x-aivi-client': '99.0.0' });
  assert.equal(answer.status, 403);
  assert.equal(answer.body.code, 'server_version_too_low');
});

test('a person who is not an operator is refused and named in the answer', async t => {
  const { store, port } = await harness(t, () => '#!/bin/sh\nexit 0\n');
  const stranger = store.createPerson({ name: 'Eve', roles: [] });
  const { secret } = store.mintToken(stranger.id, 'laptop');
  const answer = await refused(port, headers(secret));
  assert.equal(answer.status, 403);
  assert.match(String(answer.body.error), /operator/);
  assert.equal((answer.body.person as { name: string }).name, 'Eve');
});

test('a host whose node-pty cannot load answers exec attempts plainly', async t => {
  const { store, port, secret } = await harness(t, () => '#!/bin/sh\nexit 0\n', {
    importPty: () => Promise.reject(new Error('no prebuilt binary on this machine')),
  });
  const done = await session(port, secret, { t: 'start', argv: ['status'] });
  assert.match(done.stdout, /remote exec unavailable on this host/);
  assert.equal(done.exit!.code, 1);
  const [row] = auditRows(store);
  assert.equal(JSON.parse(row!.body!).reason, 'pty unavailable');
});

test('a second start racing the pty import is told, not spawned', async t => {
  // The guard must hold while the first start still awaits the import: the
  // session is owned by the start, not by the child it has not built yet.
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let spawned = 0;
  const fake = {
    spawn: () => {
      spawned++;
      return {
        pid: 4242,
        onData: (_cb: (data: string) => void) => {},
        onExit: (_cb: ({ exitCode }: { exitCode: number | null }) => void) => {},
        kill: () => {},
        write: () => {},
        resize: () => {},
      };
    },
  };
  const { port, secret } = await harness(t, () => '#!/bin/sh\nexit 0\n', {
    importPty: async () => {
      await gate;
      return fake as unknown as typeof import('node-pty');
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/exec`, { headers: headers(secret) });
  const events: Record<string, unknown>[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) events.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('error', () => {});
  await opened;
  // Both frames land before the import resolves: the first owns the session.
  ws.send(JSON.stringify({ t: 'start', argv: ['status'] }));
  ws.send(JSON.stringify({ t: 'start', argv: ['status'] }));
  await until(() => events.some(event => event.t === 'error'));
  assert.match(String(events.find(event => event.t === 'error')!.message), /start sent twice/);
  assert.equal(spawned, 0, 'nothing spawned while the import was still in flight');
  release();
  await until(() => events.some(event => event.t === 'ready'));
  assert.equal(spawned, 1, 'the start that was already in flight spawned exactly one child');
  ws.terminate();
});
