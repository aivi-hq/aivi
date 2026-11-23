/** `CdpConnection`: one websocket to one browser. Its one collaborator is the
 *  global `WebSocket`, replaced here by a class that records what is written
 *  and lets a test deliver what the browser would send. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  CdpConnection,
  type CdpConnectionOptions,
  CdpError,
  CdpEvent,
  COMMAND_TIMED_OUT,
  CONNECTION_CLOSED,
  CONNECTION_REFUSED,
  CONNECTION_TIMED_OUT,
  sleep,
} from '../src/index.ts';

const URL = 'ws://127.0.0.1:9222/devtools/browser/abc';

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  sendError: Error | undefined;

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  /** The browser accepts the handshake. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** The browser sends a frame; an object is sent as JSON. */
  receive(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /** The socket is over, for the reason the browser gave. */
  end(reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { reason }));
  }

  /** The commands written so far, as the browser reads them. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map(raw => JSON.parse(raw));
  }

  /** The browser answers the nth command written. */
  answer(n: number, result: unknown): void {
    this.receive({ id: this.frames()[n]?.id, result });
  }

  /** The browser refuses the nth command written. */
  refuse(n: number, error: object): void {
    this.receive({ id: this.frames()[n]?.id, error });
  }
}

/** Start opening a connection; the handshake is left for the test to finish. */
function dial(t: TestContext, options?: CdpConnectionOptions) {
  const sockets: FakeSocket[] = [];
  t.mock.property(
    globalThis,
    'WebSocket',
    class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket,
  );
  const opening = CdpConnection.open(URL, options);
  return { opening, socket: sockets[0]! };
}

async function connect(t: TestContext, options?: CdpConnectionOptions) {
  const { opening, socket } = dial(t, options);
  socket.open();
  return { connection: await opening, socket };
}

const rejectedWith = (code: number | string, message: string) => (error: unknown) => {
  assert.ok(error instanceof CdpError, `expected a CdpError, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  return true;
};

test('a connection trouble is a CdpError, and its four codes tell the troubles apart', () => {
  const codes = [CONNECTION_CLOSED, CONNECTION_REFUSED, CONNECTION_TIMED_OUT, COMMAND_TIMED_OUT];
  assert.equal(new Set(codes).size, 4);
  const error = new CdpError('no browser', CONNECTION_REFUSED);
  assert.ok(error instanceof Error);
  assert.deepEqual([error.name, error.code, error.message], ['CdpError', CONNECTION_REFUSED, 'no browser']);
});

test('a command is written as one frame with an id, its method, its params and the tab it addresses', async t => {
  const { connection, socket } = await connect(t);

  const browser = connection.send('Browser.getVersion');
  const tab = connection.send('Runtime.evaluate', { expression: '1 + 1' }, 'session-1');
  const [first, second] = socket.frames();

  assert.deepEqual(first, { id: first?.id, method: 'Browser.getVersion', params: {} });
  assert.deepEqual(second, {
    id: second?.id,
    method: 'Runtime.evaluate',
    params: { expression: '1 + 1' },
    sessionId: 'session-1',
  });
  assert.notEqual(first?.id, second?.id);
  socket.answer(0, {});
  socket.answer(1, {});
  await Promise.all([browser, tab]);
});

test('each answer reaches the command it answers, whatever order the answers come in', async t => {
  const { connection, socket } = await connect(t);

  const first = connection.send('A.first');
  const second = connection.send('B.second');
  socket.answer(1, { which: 'second' });
  socket.answer(0, { which: 'first' });

  assert.deepEqual(await Promise.all([first, second]), [{ which: 'first' }, { which: 'second' }]);
});

test('a protocol error rejects the call with its code, and says which method was called', async t => {
  const { connection, socket } = await connect(t);

  const missing = connection.send('Missing.method');
  socket.refuse(0, { code: -32601, message: "'Missing.method' wasn't found" });
  await assert.rejects(missing, rejectedWith(-32601, "'Missing.method' wasn't found when calling Missing.method"));

  const odd = connection.send('Odd.error');
  socket.refuse(1, {});
  await assert.rejects(odd, rejectedWith(-32000, 'protocol error when calling Odd.error'));
});

test('an event arrives as a CdpEvent with its params and the session it came from', async t => {
  const { connection, socket } = await connect(t);
  const heard: CdpEvent[] = [];
  connection.addEventListener('Page.loadEventFired', event => heard.push(event as CdpEvent));

  socket.receive({ method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: 'session-1' });
  socket.receive({ method: 'Page.loadEventFired' });
  socket.receive({ method: 'Page.frameNavigated', params: {} });

  assert.ok(heard.every(event => event instanceof CdpEvent));
  assert.deepEqual(
    heard.map(event => [event.type, event.params, event.sessionId]),
    [
      ['Page.loadEventFired', { timestamp: 7 }, 'session-1'],
      ['Page.loadEventFired', undefined, undefined],
    ],
  );
  assert.deepEqual(
    [new CdpEvent('Some.event')].map(event => [event.type, event.params, event.sessionId]),
    [['Some.event', undefined, undefined]],
  );
});

test('a frame that is neither an answer nor an event is ignored', async t => {
  const { connection, socket } = await connect(t);
  const pending = connection.send('Browser.getVersion');

  for (const frame of ['not json', '{}', '[]', 'null', '42', '"text"', { id: 999, result: {} }]) socket.receive(frame);

  assert.equal(connection.closed, false);
  socket.answer(0, { product: 'Chrome/141' });
  assert.deepEqual(await pending, { product: 'Chrome/141' });
});

test('a command with no answer is rejected after commandMaxTime, and its late answer changes nothing', async t => {
  const { connection, socket } = await connect(t, { commandMaxTime: 5 });

  await assert.rejects(
    connection.send('Slow.command'),
    rejectedWith(COMMAND_TIMED_OUT, 'no answer for Slow.command within 5 ms'),
  );
  socket.answer(0, { done: 'at last' });
  const next = connection.send('Browser.getVersion');
  socket.answer(1, { product: 'Chrome/141' });

  assert.deepEqual(await next, { product: 'Chrome/141' });
  assert.equal(connection.closed, false);
});

test('by default a handshake gets 10 seconds and a command 30', async t => {
  const timers = t.mock.method(globalThis, 'setTimeout');
  const { connection, socket } = await connect(t);

  const pending = connection.send('Browser.getVersion');
  socket.answer(0, {});
  await pending;

  assert.deepEqual(
    timers.mock.calls.map(call => call.arguments[1]),
    [10_000, 30_000],
  );
});

test('with commandMaxTime 0 no timer is started for a command', async t => {
  const { connection, socket } = await connect(t, { commandMaxTime: 0 });
  const timers = t.mock.method(globalThis, 'setTimeout');

  const pending = connection.send('Browser.getVersion');
  socket.answer(0, { product: 'Chrome/141' });

  assert.equal(timers.mock.callCount(), 0);
  assert.deepEqual(await pending, { product: 'Chrome/141' });
});

test('a handshake that never completes is given up on after connectMaxTime, and the socket is closed', async t => {
  const { opening, socket } = dial(t, { connectMaxTime: 5 });

  await assert.rejects(opening, rejectedWith(CONNECTION_TIMED_OUT, 'socket not opened within 5 ms'));

  assert.equal(socket.closeCalls, 1);
});

test('a browser that cannot be reached is a refused connection, and the socket is closed', async t => {
  const { opening, socket } = dial(t);

  socket.dispatchEvent(new Event('error'));

  await assert.rejects(opening, rejectedWith(CONNECTION_REFUSED, `could not reach the browser at ${URL}`));
  assert.equal(socket.closeCalls, 1);
});

test('a handshake that completes after it was given up on changes nothing', async t => {
  const { opening, socket } = dial(t, { connectMaxTime: 5 });
  await assert.rejects(opening, rejectedWith(CONNECTION_TIMED_OUT, 'socket not opened within 5 ms'));

  socket.open();

  assert.equal(socket.closeCalls, 1);
});

test('an error on the socket after it opened does not touch the connection', async t => {
  const { connection, socket } = await connect(t);

  socket.dispatchEvent(new Event('error'));

  assert.equal(connection.closed, false);
  const pending = connection.send('Browser.getVersion');
  socket.answer(0, { product: 'Chrome/141' });
  assert.deepEqual(await pending, { product: 'Chrome/141' });
});

for (const [reason, message] of [
  ['going away', 'connection closed (going away) when calling Stuck.command'],
  ['', 'connection closed when calling Stuck.command'],
] as const) {
  test(`the browser going away${reason === '' ? '' : ` with a reason`} rejects the waiting calls and is said once`, async t => {
    const { connection, socket } = await connect(t);
    const closes: Event[] = [];
    connection.addEventListener('close', event => closes.push(event));
    const waiting = connection.send('Stuck.command');

    socket.end(reason);

    await assert.rejects(waiting, rejectedWith(CONNECTION_CLOSED, message));
    assert.equal(connection.closed, true);
    assert.equal(closes.length, 1);
    await assert.rejects(
      connection.send('After.close'),
      rejectedWith(CONNECTION_CLOSED, 'connection closed when calling After.close'),
    );
    assert.equal(socket.frames().length, 1, 'nothing is written to a closed socket');
  });
}

test('closing it ourselves rejects the waiting calls, says so once, and is safe to repeat', async t => {
  const { connection, socket } = await connect(t);
  const closes: Event[] = [];
  connection.addEventListener('close', event => closes.push(event));
  const waiting = connection.send('Stuck.command');

  connection.close();

  await assert.rejects(waiting, rejectedWith(CONNECTION_CLOSED, 'connection closed by us when calling Stuck.command'));
  assert.equal(connection.closed, true);
  connection.close();
  socket.end();
  assert.equal(closes.length, 1, 'neither a second close nor the socket closing after us is said again');
  assert.equal(socket.closeCalls, 1);
});

test('a command sent while the socket is closing is refused without being written', async t => {
  const { connection, socket } = await connect(t);

  socket.readyState = 2;

  await assert.rejects(
    connection.send('Page.enable'),
    rejectedWith(CONNECTION_CLOSED, 'connection closed when calling Page.enable'),
  );
  assert.deepEqual(socket.frames(), []);
  assert.equal(connection.closed, false, 'the close event has not come yet');
});

for (const commandMaxTime of [30_000, 0]) {
  test(`a write that fails rejects that command and leaves the connection usable (commandMaxTime ${commandMaxTime})`, async t => {
    const { connection, socket } = await connect(t, { commandMaxTime });

    socket.sendError = new Error('write EPIPE');
    await assert.rejects(
      connection.send('Page.enable'),
      rejectedWith(CONNECTION_CLOSED, 'send failed when calling Page.enable: Error: write EPIPE'),
    );

    socket.sendError = undefined;
    const next = connection.send('Browser.getVersion');
    socket.answer(0, { product: 'Chrome/141' });
    assert.deepEqual(await next, { product: 'Chrome/141' });
  });
}

test('sleep resolves after the time it is given', async () => {
  await sleep(1);
});
