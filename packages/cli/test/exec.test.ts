import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { Writable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { type WebSocket, WebSocketServer } from 'ws';
import { execRemote } from '../src/exec.ts';
import { main } from '../src/main.ts';
import { aiviVersion } from '../src/version.ts';

const collect = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  }) as Writable & { text(): string };
  stream.text = () => Buffer.concat(chunks).toString('utf8');
  return stream;
};

/** A machine that signed in to a host: the client record the relay reads. */
const signIn = async (t: TestContext, config: Record<string, unknown>) => {
  const directory = await mkdtemp(join(tmpdir(), 'aivi-remote-'));
  const file = join(directory, 'aivi.json');
  await writeFile(file, JSON.stringify(config));
  const previous = process.env.AIVI_CONFIG;
  const exitCode = process.exitCode;
  process.env.AIVI_CONFIG = file;
  t.after(() => {
    if (previous === undefined) delete process.env.AIVI_CONFIG;
    else process.env.AIVI_CONFIG = previous;
    process.exitCode = exitCode;
    return rm(directory, { recursive: true, force: true });
  });
  return file;
};

const signedIn = (url: string) => ({ configVersion: 1, url, home: '/somewhere', person: { token: 'aivi-test' } });

/** A host with an exec door; the test scripts what its socket does. */
const host = async (
  t: TestContext,
  behavior: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    accept: (onSocket: (ws: WebSocket) => void) => void,
  ) => void,
) => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    behavior(request, socket, head, onSocket => wss.handleUpgrade(request, socket, head, onSocket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    wss.close();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const refuse = (socket: Duplex, status: number, body: Record<string, unknown>): void => {
  const payload = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
  );
  socket.destroy();
};

const onMessage = (ws: WebSocket, fn: (message: Record<string, unknown>) => void): void => {
  ws.on('message', data => fn(JSON.parse(data.toString('utf8')) as Record<string, unknown>));
};

test('the relay carries argv verbatim, prints the answer, and exits with the server code', async t => {
  let seen: Record<string, unknown> | undefined;
  let headers: IncomingMessage['headers'] | undefined;
  const url = await host(t, (request, _socket, _head, accept) => {
    headers = request.headers;
    accept(ws => {
      onMessage(ws, message => {
        seen = message;
        ws.send(Buffer.from('the server answered', 'utf8')); // binary: stdout bytes
        ws.send(JSON.stringify({ t: 'err', b64: Buffer.from('a warning\n', 'utf8').toString('base64') }));
        ws.send(JSON.stringify({ t: 'exit', code: 3 }));
      });
    });
  });
  await signIn(t, signedIn(url));
  const stdout = collect();
  const stderr = collect();
  await execRemote(['jobs', 'list', '--state', 'done'], { stdout, stderr });
  assert.equal(headers?.['x-aivi-client'], aiviVersion, 'the CLI says its version on the door');
  assert.equal(headers?.authorization, 'Bearer aivi-test', 'the connection presents this machine bearer');
  assert.deepEqual(
    [seen!.t, seen!.argv, seen!.pty],
    ['start', ['jobs', 'list', '--state', 'done'], false],
    'a piped stdout asks for pipes not a PTY (D12), and argv travels verbatim',
  );
  assert.equal(stdout.text(), 'the server answered');
  assert.equal(stderr.text(), 'a warning\n', 'stderr kept its own channel');
  assert.equal(process.exitCode, 3, "the server's exit code is the client's exit code");
});

test('no server configured answers the teaching line and touches no network', async t => {
  await signIn(t, { configVersion: 1 });
  await assert.rejects(() => execRemote(['status'], { stdout: collect(), stderr: collect() }), {
    message: 'no server configured — run aivi configure',
  });
});

test('an unreachable host says so with its address', async t => {
  await signIn(t, signedIn('http://127.0.0.1:9'));
  await assert.rejects(() => execRemote(['status'], { stdout: collect(), stderr: collect() }), {
    message: 'host unreachable at http://127.0.0.1:9',
  });
});

test('a refusal shows the server own words, not the client guess', async t => {
  const url = await host(t, (request, socket, _head, _accept) => {
    refuse(socket, 403, { error: `Only an operator can drive this host remotely (asked for ${request.url})` });
  });
  await signIn(t, signedIn(url));
  await assert.rejects(() => execRemote(['people', 'list'], { stdout: collect(), stderr: collect() }), {
    message: /^Only an operator can drive this host remotely \(asked for \/exec\)$/,
  });
});

test('a connection lost mid-session says so and keeps whatever it had', async t => {
  const url = await host(t, (_request, _socket, _head, accept) => {
    accept(ws => {
      onMessage(ws, () => {
        ws.send(JSON.stringify({ t: 'ready', pid: 1 }));
        ws.close(); // the host died without an exit message
      });
    });
  });
  await signIn(t, signedIn(url));
  await assert.rejects(() => execRemote(['service', 'restart'], { stdout: collect(), stderr: collect() }), {
    message: 'connection lost',
  });
});

test('main strips -r wherever it sits and relays instead of parsing', async t => {
  await signIn(t, { configVersion: 1 }); // no url: the relay's teaching line proves it was reached
  // A local commander parse of ['status', '--json'] would have answered with
  // output, not this line: the flag routed the argv to the relay, whole.
  await assert.rejects(() => main(['status', '-r', '--json']), {
    message: 'no server configured — run aivi configure',
  });
});
