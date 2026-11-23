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
import { override, setEnv } from './process-fixture.ts';

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
  // The upgraded sockets are the ws's now, and `server.close()` waits for them: they end with the test.
  const sockets = new Set<Duplex>();
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    behavior(request, socket, head, onSocket => wss.handleUpgrade(request, socket, head, onSocket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    wss.close();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const refuse = (socket: Duplex, status: number, body: Record<string, unknown> | string): void => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const type = typeof body === 'string' ? 'text/html' : 'application/json';
  socket.write(
    `HTTP/1.1 ${status} Refused\r\ncontent-type: ${type}\r\n` +
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
    message: 'no server configured — run aivi setup',
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

test('a frame the socket cannot read is no answer: the connection is lost and the relay says so', async t => {
  const url = await host(t, (_request, socket, _head, accept) => {
    accept(ws => {
      onMessage(ws, () => {
        socket.write(Buffer.from([0x8f, 0x00])); // a frame with an opcode that does not exist
      });
    });
  });
  await signIn(t, signedIn(url));
  await assert.rejects(() => execRemote(['status'], { stdout: collect(), stderr: collect() }), {
    message: 'connection lost',
  });
});

test('main strips -r wherever it sits and relays instead of parsing', async t => {
  await signIn(t, { configVersion: 1 }); // no url: the relay's teaching line proves it was reached
  // A local commander parse of ['status', '--json'] would have answered with
  // output, not this line: the flag routed the argv to the relay, whole.
  await assert.rejects(() => main(['status', '-r', '--json']), {
    message: 'no server configured — run aivi setup',
  });
});

test('main hands a -r run to the relay without the flag, and is done when the server says exit', async t => {
  let seen: Record<string, unknown> | undefined;
  const url = await host(t, (_request, _socket, _head, accept) => {
    accept(ws => {
      onMessage(ws, message => {
        seen = message;
        ws.send(JSON.stringify({ t: 'exit', code: 2 }));
      });
    });
  });
  await signIn(t, signedIn(url));

  await main(['status', '-r', '--json']);

  assert.deepEqual(seen?.argv, ['status', '--json'], 'the flag came out and everything else travelled');
  assert.equal(process.exitCode, 2);
});

test('a refusal whose body says nothing useful still names the status the door answered with', async t => {
  const refusals: [number, Record<string, unknown> | string, string][] = [
    [502, '<html>Bad gateway</html>', 'the server refused this connection (502)'],
    [500, {}, 'the server refused this connection (500)'],
    [403, { message: 'Not for you' }, 'Not for you'],
  ];
  const file = await signIn(t, { configVersion: 1 });
  for (const [status, body, message] of refusals) {
    const url = await host(t, (_request, socket) => refuse(socket, status, body));
    await writeFile(file, JSON.stringify(signedIn(url)));
    await assert.rejects(() => execRemote(['status'], { stdout: collect(), stderr: collect() }), { message });
  }
});

test('an https address is reached as a secure socket, and when that fails the host is unreachable at that address', async t => {
  const url = (await host(t, () => {})).replace('http:', 'https:'); // a plain server: the handshake cannot succeed
  await signIn(t, signedIn(url));
  await assert.rejects(() => execRemote(['status'], { stdout: collect(), stderr: collect() }), {
    message: `host unreachable at ${url}`,
  });
});

test('frames that are not control messages are the answer, and an exit without a number code is a failure', async t => {
  const url = await host(t, (_request, _socket, _head, accept) => {
    accept(ws => {
      onMessage(ws, () => {
        ws.send('plain words, not a control frame\n');
        ws.send(JSON.stringify({ t: 'error', message: 'the server said no' }));
        ws.send(JSON.stringify({ t: 'ready', pid: 1 })); // a frame the relay has no use for
        ws.send(JSON.stringify({ t: 'exit', code: 'two' }));
        ws.close(); // after the exit: the close that follows is not a second ending
      });
    });
  });
  await signIn(t, signedIn(url));
  const stderr = collect();

  await execRemote(['status'], { stdout: collect(), stderr });

  assert.equal(stderr.text(), 'plain words, not a control frame\nthe server said no\n');
  assert.equal(process.exitCode, 1);
});

const ttyStdout = () => Object.assign(collect(), { isTTY: true });

test('a terminal on stdout alone asks for a PTY of the default size and leaves raw mode out of it', async t => {
  override(t, process.stdin, 'isTTY', false);
  override(t, process.stdout, 'columns', undefined);
  override(t, process.stdout, 'rows', undefined);
  setEnv(t, 'TERM', undefined);
  let start: Record<string, unknown> | undefined;
  const url = await host(t, (_request, _socket, _head, accept) => {
    accept(ws => {
      onMessage(ws, message => {
        start = message;
        ws.send(JSON.stringify({ t: 'exit', code: 0 }));
      });
    });
  });
  await signIn(t, signedIn(url));

  await execRemote(['top'], { stdout: ttyStdout(), stderr: collect() });

  assert.deepEqual(start, { t: 'start', argv: ['top'], term: 'xterm-256color', cols: 80, rows: 24 });
});

test('in a terminal the session carries its size and keys, follows the window, and gives the terminal back', async t => {
  const rawModes: boolean[] = [];
  override(t, process.stdin, 'isTTY', true);
  override(t, process.stdin, 'isRaw', false);
  override(t, process.stdin, 'setRawMode', (mode: boolean) => {
    rawModes.push(mode);
    process.stdin.isRaw = mode;
    return process.stdin;
  });
  override(t, process.stdout, 'columns', 132);
  override(t, process.stdout, 'rows', 43);
  setEnv(t, 'TERM', 'screen');
  const received: unknown[] = [];
  const url = await host(t, (_request, _socket, _head, accept) => {
    accept(ws => {
      ws.on('message', (data, isBinary) => {
        const bytes = (data as Buffer).toString('utf8');
        received.push(isBinary ? bytes : JSON.parse(bytes));
        if (received.length === 1) {
          // The session is live: type a key, and move the window.
          process.stdin.emit('data', Buffer.from('ls\r'));
          process.stdout.emit('resize');
        }
        if (received.length === 3) {
          // The window loses its size (a pipe has none): the relay falls back to 80 by 24.
          Object.assign(process.stdout, { columns: undefined, rows: undefined });
          process.stdout.emit('resize');
        }
        if (received.length === 4) ws.send(JSON.stringify({ t: 'exit', code: 0 }));
      });
    });
  });
  await signIn(t, signedIn(url));

  await execRemote(['top'], { stdout: ttyStdout(), stderr: collect() });

  assert.deepEqual(received, [
    { t: 'start', argv: ['top'], term: 'screen', cols: 132, rows: 43 },
    'ls\r',
    { t: 'resize', cols: 132, rows: 43 },
    { t: 'resize', cols: 80, rows: 24 },
  ]);
  assert.deepEqual(rawModes, [true, false], 'raw mode was on for the session and off after it');
  assert.equal(process.stdout.listenerCount('resize'), 0, 'the resize listener left with the session');
});
