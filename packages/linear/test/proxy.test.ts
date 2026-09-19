import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LinearClient } from '../src/client.ts';
import { LinearMcpProxy, proxyCredentials } from '../src/proxy.ts';

/** A hosted-MCP stand-in: records what the proxy sent and replies by script. */
function mockUpstream(
  script: (seen: { authorization: string; body: string; session: string }) => {
    status: number;
    headers?: Record<string, string>;
    body: string;
  },
) {
  const seen: { authorization: string; body: string; session: string }[] = [];
  const tokens = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push({
        authorization: request.headers.authorization ?? '',
        body,
        session: (request.headers['mcp-session-id'] as string | undefined) ?? '',
      });
      const { status, headers, body: out } = script(seen.at(-1)!);
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(out);
    });
  });
  let linearTokens = 0;
  const tokenServer: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      linearTokens += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: `token-${linearTokens}`, expires_in: 86_399 }));
    });
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
      Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => tokenServer.close(() => resolve())),
      ]),
  };
}

test('the proxy forwards JSON-RPC with the app token, keeps the session, parses SSE and re-mints on a 401', async t => {
  let refuseToken1 = true;
  const upstream = mockUpstream(seen => {
    if (seen.session === '') {
      // initialize: assign a session, reply inline
      return { status: 200, headers: { 'mcp-session-id': 'sid-1' }, body: '{"jsonrpc":"2.0","id":1,"result":{}}' };
    }
    if (refuseToken1 && seen.authorization === 'Bearer token-1') {
      refuseToken1 = false;
      return { status: 401, body: '{"error":"expired"}' };
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
    };
  });
  const { upstream: url, token } = await upstream.start();
  t.after(upstream.stop);
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl: token });
  const proxy = new LinearMcpProxy(client, url);

  const first = await proxy.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  assert.deepEqual(first, ['{"jsonrpc":"2.0","id":1,"result":{}}'], 'the initialize reply is relayed');
  assert.match(upstream.seen[0]!.authorization, /^Bearer token-1$/);

  const second = await proxy.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.deepEqual(second, ['{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'], 'an SSE reply is parsed to one line');
  assert.equal(upstream.seen[1]!.session, 'sid-1', 'the session id rides along');
  assert.equal(upstream.seen[1]!.authorization, 'Bearer token-1', 'the first attempt carried the minted token');
  assert.equal(upstream.seen.length, 3, 'a 401 was retried once');
  assert.equal(upstream.seen[2]!.authorization, 'Bearer token-2', 'the retry re-minted the token');
});

test('a request the upstream cannot serve becomes a JSON-RPC error; non-JSON stdin is a parse error; notifications may return nothing', async t => {
  const upstream = mockUpstream(() => ({ status: 500, body: 'nope' }));
  const { upstream: url, token } = await upstream.start();
  t.after(upstream.stop);
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl: token });
  const proxy = new LinearMcpProxy(client, url);

  const failing = await proxy.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }));
  assert.match(failing[0]!, /"code":-32603/);
  assert.match(failing[0]!, /"id":7/);

  assert.deepEqual(await proxy.handle('not json'), [
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
  ]);
  assert.deepEqual(await proxy.handle(''), [], 'empty lines are skipped');
});

test('credentials come from the environment, or the aivi home .env when run outside aivi', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'LINEAR_CLIENT_ID="env-cid"\nLINEAR_CLIENT_SECRET=env-sec\n');
  assert.deepEqual(
    proxyCredentials({ LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 'sec', AIVI_HOME: root }),
    { clientId: 'cid', clientSecret: 'sec' },
    'the environment wins',
  );
  assert.deepEqual(proxyCredentials({ AIVI_HOME: root }), { clientId: 'env-cid', clientSecret: 'env-sec' });
  assert.throws(() => proxyCredentials({}), /LINEAR_CLIENT_ID/);
});
