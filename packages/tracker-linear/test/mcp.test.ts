import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { LinearClient } from '../src/client.ts';
import { LinearMcp } from '../src/mcp.ts';

interface Seen {
  authorization: string;
  body: string;
  contentType: string | undefined;
  session: string;
}

/** Linear's hosted MCP stand-in: records what the proxy sent and replies by script. */
function mockUpstream(
  script: (seen: Seen, tokenNumber: number) => { status: number; headers?: Record<string, string>; body: string },
) {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      const entry: Seen = {
        authorization: request.headers.authorization ?? '',
        body,
        contentType: request.headers['content-type'],
        session: (request.headers['mcp-session-id'] as string | undefined) ?? '',
      };
      seen.push(entry);
      const { status, headers, body: out } = script(entry, seen.length);
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(out);
    });
  });
  let tokens = 0;
  const tokenServer: Server = createServer((_request, response) => {
    tokens += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: `token-${tokens}`, expires_in: 86_399 }));
  });
  return {
    seen,
    async start() {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      await new Promise<void>(resolve => tokenServer.listen(0, '127.0.0.1', resolve));
      return {
        upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        token: `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`,
      };
    },
    stop: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        tokenServer.closeAllConnections();
        server.close(() => tokenServer.close(() => resolve()));
      }),
  };
}

test('the MCP forwards verbatim with the app token; the session header rides both ways', async t => {
  const upstream = mockUpstream((seen, tokenNumber) => {
    assert.equal(seen.contentType, 'application/json', 'the request arrives as JSON');
    return {
      status: 200,
      headers: tokenNumber === 1 ? { 'mcp-session-id': 'sid-1' } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(seen.body).id, result: { ok: true } }),
    };
  });
  const { upstream: url, token } = await upstream.start();
  t.after(() => upstream.stop());
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl: token });
  const mcp = new LinearMcp(client, { port: 0, upstream: url });
  const port = await mcp.start();
  t.after(() => mcp.stop());

  const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('mcp-session-id'), 'sid-1', 'the session header passes back to the client');
  assert.deepEqual(await first.json(), { jsonrpc: '2.0', id: 1, result: { ok: true } });
  assert.match(upstream.seen[0]!.authorization, /^Bearer token-1$/);

  const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'sid-1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal((await second.json()).id, 2);
  assert.equal(upstream.seen[1]!.session, 'sid-1', 'the session id rides upstream');
  assert.match(upstream.seen[1]!.authorization, /^Bearer token-1$/, 'the same cached token is reused');
});

test('a 401 re-mints once and replays; a dead upstream surfaces as 502', async t => {
  let refused = false;
  const upstream = mockUpstream(seen => {
    if (!refused && seen.authorization.endsWith('token-1')) {
      refused = true;
      return { status: 401, body: '{"error":"expired"}' };
    }
    return { status: 200, body: '{"jsonrpc":"2.0","id":9,"result":{}}' };
  });
  const { upstream: url, token } = await upstream.start();
  t.after(() => upstream.stop());
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl: token });
  const mcp = new LinearMcp(client, { port: 0, upstream: url });
  const port = await mcp.start();
  t.after(() => mcp.stop());

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} }),
  });
  assert.equal(response.status, 200, 'the client sees one clean reply');
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 9, result: {} });
  assert.match(upstream.seen[0]!.authorization, /^Bearer token-1$/);
  assert.match(upstream.seen[1]!.authorization, /^Bearer token-2$/, 'the replay carried a fresh token');

  const stopped = new LinearMcp(client, { port: 0, upstream: 'http://127.0.0.1:1/mcp' });
  const dead = await stopped.start();
  t.after(() => stopped.stop());
  const failed = await fetch(`http://127.0.0.1:${dead}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(failed.status, 502);
  assert.match(await failed.text(), /Upstream unreachable/);
});

test('an SSE reply streams through with its content-type untouched', async t => {
  const upstream = mockUpstream(() => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"part":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"part":2}}\n\n',
  }));
  const { upstream: url, token } = await upstream.start();
  t.after(() => upstream.stop());
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl: token });
  const mcp = new LinearMcp(client, { port: 0, upstream: url });
  const port = await mcp.start();
  t.after(() => mcp.stop());

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} }),
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream', 'the stream is not unwrapped');
  const text = await response.text();
  assert.match(text, /"part":1/);
  assert.match(text, /"part":2/);
});
