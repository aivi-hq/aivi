import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { LinearApiError, LinearClient } from '../src/client.ts';

interface Seen {
  path: string;
  authorization: string | undefined;
  body: string;
}

/** A Linear stand-in: hands out numbered tokens and answers GraphQL by script. */
function mockLinear(script: (seen: Seen, tokenNumber: number) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  let tokens = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      const entry: Seen = { path: request.url ?? '', authorization: request.headers.authorization, body };
      seen.push(entry);
      if (entry.path === '/oauth/token') {
        tokens += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: `token-${tokens}`, expires_in: 86_399, scope: 'read' }));
        return;
      }
      const { status, body: out } = script(entry, tokens);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(out));
    });
  });
  return {
    seen,
    async start() {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('the token comes from client credentials once, is shared by concurrent calls and re-fetched on a 401', async t => {
  let rejectFirstBearer = true;
  const linear = mockLinear(seen => {
    if (rejectFirstBearer && seen.authorization === 'Bearer token-1') {
      rejectFirstBearer = false;
      return { status: 401, body: { error: 'expired' } };
    }
    return { status: 200, body: { data: { viewer: { id: 'app-user' } } } };
  });
  const baseUrl = await linear.start();
  t.after(linear.stop);
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl });

  const [a, b] = await Promise.all([client.viewerId(), client.viewerId()]);
  assert.deepEqual([a, b], ['app-user', 'app-user']);
  const tokenRequests = linear.seen.filter(s => s.path === '/oauth/token');
  assert.equal(tokenRequests.length, 2, 'one token for both callers, one more after the 401');
  assert.equal(tokenRequests[0]!.authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(
    new URLSearchParams(tokenRequests[0]!.body).get('scope'),
    'read,write,app:assignable,app:mentionable',
    'the agent scopes are requested by default',
  );
  assert.equal(new URLSearchParams(tokenRequests[0]!.body).get('grant_type'), 'client_credentials');
  const graphql = linear.seen.filter(s => s.path === '/graphql');
  assert.deepEqual(
    graphql.map(s => s.authorization),
    ['Bearer token-1', 'Bearer token-1', 'Bearer token-2'],
    'the rejected call is retried with the new token; the other call had already succeeded',
  );
});

test('GraphQL errors and HTTP failures surface as LinearApiError; mutations check success', async t => {
  let step = 0;
  const linear = mockLinear(() => {
    step += 1;
    if (step === 1) return { status: 200, body: { errors: [{ message: 'Entity not found' }] } };
    if (step === 2) return { status: 500, body: { errors: [{ message: 'boom' }] } };
    if (step === 3)
      return { status: 200, body: { data: { agentActivityCreate: { success: false, agentActivity: { id: 'x' } } } } };
    return {
      status: 200,
      body: {
        data: {
          issue: {
            id: 'i1',
            identifier: 'ENG-1',
            title: 'T',
            description: null,
            branchName: 'me/eng-1-t',
            url: 'https://linear.app/x/issue/ENG-1',
            state: { id: 's', name: 'In Progress', type: 'started' },
            team: { id: 't', key: 'ENG' },
            labels: { nodes: [{ id: 'l', name: 'needs-human' }] },
            delegate: null,
            assignee: null,
          },
        },
      },
    };
  });
  const baseUrl = await linear.start();
  t.after(linear.stop);
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl });
  await assert.rejects(
    client.issue('missing'),
    (e: unknown) => e instanceof LinearApiError && /Entity not found/.test(e.message),
  );
  await assert.rejects(client.issue('x'), (e: unknown) => e instanceof LinearApiError && e.status === 500);
  await assert.rejects(
    client.createActivity({ agentSessionId: 's', content: { type: 'thought', body: 'hi' } }),
    /not successful/,
  );
  const issue = await client.issue('i1');
  assert.deepEqual(issue.labels, [{ id: 'l', name: 'needs-human' }], 'label connection flattened');
  assert.equal(issue.branchName, 'me/eng-1-t');
});
