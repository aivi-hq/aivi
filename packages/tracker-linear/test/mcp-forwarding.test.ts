/**
 * What the Linear MCP bridge does at its edges, with no socket: the HTTP server
 * it binds and the upstream it forwards to are fakes that the test drives by
 * hand (`node:http` and `node:https` are replaced through `t.mock.method`).
 * The bridge's full run over loopback servers is `test/mcp.test.ts`'s subject.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { mock, type TestContext, test } from 'node:test';
import type { LinearClient } from '../src/client.ts';
import { LinearMcp } from '../src/mcp.ts';

const client = { accessToken: mock.fn(async (_force?: boolean) => 'tok') } as unknown as LinearClient;

/** The server the bridge binds and the upstream it forwards to, both answered
 *  here: `call` hands the server's listener one request and waits for the
 *  answer the bridge wrote; `sent` is what went upstream, and by which scheme. */
function fakeHttp(t: TestContext) {
  let listener: RequestListener | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen: mock.fn((_port: number, _host: string, ready: () => void) => ready()),
    address: mock.fn(() => ({ port: 4321, address: '127.0.0.1', family: 'IPv4' })),
    close: mock.fn((done: () => void) => done()),
    closeAllConnections: mock.fn(),
  });
  const sent: { scheme: string; options: Record<string, unknown>; body: Buffer | undefined }[] = [];
  const upstream = (scheme: string) => (options: Record<string, unknown>, callback: (response: unknown) => void) =>
    Object.assign(new EventEmitter(), {
      end: (body?: Buffer) => {
        sent.push({ scheme, options, body });
        callback(
          Object.assign(Readable.from([Buffer.from('{"ok":true}')]), {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
  t.mock.method(http, 'createServer', (handler: RequestListener) => {
    listener = handler;
    return server as unknown as Server;
  });
  t.mock.method(http, 'request', upstream('http'));
  t.mock.method(https, 'request', upstream('https'));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const call = async (init: { method: string; url: string; headers?: Record<string, string>; body?: string }) => {
    const request = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
      method: init.method,
      url: init.url,
      headers: init.headers ?? {},
    });
    const written: Buffer[] = [];
    const response = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          written.push(chunk);
          done();
        },
      }),
      { headersSent: false, writeHead: mock.fn() },
    );
    listener!(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    await finished(response);
    return { status: response.writeHead.mock.calls[0]?.arguments[0], text: Buffer.concat(written).toString() };
  };
  return { server, sent, call };
}

test('by default the bridge speaks to Linear’s hosted MCP over https, and a request with no body goes upstream with none', async t => {
  const web = fakeHttp(t);
  const mcp = new LinearMcp(client, { port: 0 });
  await mcp.start();
  const answer = await web.call({
    method: 'GET',
    url: '/mcp?session=7',
    headers: { accept: 'text/event-stream', connection: 'keep-alive', host: '127.0.0.1:4101' },
  });
  assert.deepEqual(answer, { status: 200, text: '{"ok":true}' });
  assert.deepEqual(web.sent, [
    {
      scheme: 'https',
      options: {
        hostname: 'mcp.linear.app',
        port: '',
        path: '/mcp?session=7',
        method: 'GET',
        headers: { accept: 'text/event-stream', authorization: 'Bearer tok', host: 'mcp.linear.app' },
      },
      body: undefined,
    },
  ]);
  await mcp.stop();
});

test('a request with a body goes upstream whole, over the scheme the upstream names', async t => {
  const web = fakeHttp(t);
  const mcp = new LinearMcp(client, { port: 0, upstream: 'http://upstream.test:8080/rpc' });
  await mcp.start();
  await web.call({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"id":1}' });
  assert.deepEqual(
    web.sent.map(call => [call.scheme, call.options.hostname, call.options.port, call.options.path, String(call.body)]),
    [['http', 'upstream.test', '8080', '/rpc', '{"id":1}']],
  );
  await mcp.stop();
});

test('a body over a mebibyte is refused in the protocol’s own shape, and nothing goes upstream', async t => {
  const web = fakeHttp(t);
  const mcp = new LinearMcp(client, { port: 0 });
  await mcp.start();

  const answer = await web.call({ method: 'POST', url: '/mcp', body: 'x'.repeat(1024 * 1024 + 1) });

  assert.equal(answer.status, 413);
  assert.deepEqual(JSON.parse(answer.text), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message: 'Request body over the cap' },
  });
  assert.deepEqual(web.sent, []);
  await mcp.stop();
});

test('the bridge binds loopback only and reports the port it got; stopping it twice, or before it started, is harmless', async t => {
  const web = fakeHttp(t);
  const mcp = new LinearMcp(client, { port: 4101 });
  await mcp.stop();
  assert.equal(web.server.close.mock.callCount(), 0, 'a bridge that never started has no server to close');
  assert.equal(await mcp.start(), 4321);
  assert.deepEqual(web.server.listen.mock.calls[0]!.arguments.slice(0, 2), [4101, '127.0.0.1']);
  await mcp.stop();
  await mcp.stop();
  assert.equal(web.server.closeAllConnections.mock.callCount(), 1);
  assert.equal(web.server.close.mock.callCount(), 1, 'the server is closed once');
});

test('a port that cannot be bound fails the start with the server’s own error', async t => {
  const web = fakeHttp(t);
  web.server.listen.mock.mockImplementationOnce(() => {
    web.server.emit('error', new Error('listen EADDRINUSE: address already in use 127.0.0.1:4101'));
  });
  await assert.rejects(new LinearMcp(client, { port: 4101 }).start(), /EADDRINUSE/);
});
