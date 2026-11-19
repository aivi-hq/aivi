import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { Logger } from '@aivi/core';
import { recorder } from '../../host/test/support.ts';
import { LinearApiError, LinearClient, resolveTeams } from '../src/client.ts';

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
    return { status: 200, body: { data: { viewer: { id: 'app-user', organization: { id: 'org-1' } } } } };
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
            inverseRelations: {
              nodes: [
                {
                  type: 'blocks',
                  issue: { id: 'blk', state: { id: 's0', name: 'In Progress', type: 'started' } },
                },
                {
                  type: 'related',
                  issue: { id: 'rel', state: { id: 's9', name: 'Done', type: 'completed' } },
                },
              ],
            },
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
  assert.deepEqual(
    issue.blockedBy,
    [{ id: 'blk', state: { id: 's0', name: 'In Progress', type: 'started' } }],
    'inverseRelations of type blocks are the blockers; other relation types are dropped',
  );
  assert.equal(issue.branchName, 'me/eng-1-t');
});

test('listTeams asks for the teams this app can see, flattens the states connection and sorts by board order: type group, then position', async t => {
  const linear = mockLinear(seen =>
    seen.body.includes('teams')
      ? {
          status: 200,
          body: {
            data: {
              teams: {
                nodes: [
                  {
                    id: 't-1',
                    key: 'PEC',
                    name: 'Peck Track',
                    states: {
                      nodes: [
                        // The live-test team's shape, out of board order on
                        // purpose: `position` is scoped **per type group**,
                        // so In Review (position 1 of `started`) must beat
                        // Done/Canceled/Duplicate (low positions of their
                        // own groups), not sort after them.
                        { id: 's-3', name: 'Done', type: 'completed', position: 0 },
                        { id: 's-1', name: 'Todo', type: 'unstarted', position: 1 },
                        { id: 's-4', name: 'In Review', type: 'started', position: 1 },
                        { id: 's-2', name: 'In Progress', type: 'started', position: 0 },
                        { id: 's-5', name: 'Canceled', type: 'canceled', position: 0 },
                        { id: 's-6', name: 'Duplicate', type: 'duplicate', position: 0 },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }
      : { status: 200, body: { data: {} } },
  );
  const baseUrl = await linear.start();
  t.after(linear.stop);
  const client = new LinearClient({ clientId: 'cid', clientSecret: 'sec' }, { baseUrl });
  assert.deepEqual(await client.listTeams(), [
    {
      id: 't-1',
      key: 'PEC',
      name: 'Peck Track',
      states: [
        { id: 's-1', name: 'Todo', type: 'unstarted' },
        { id: 's-2', name: 'In Progress', type: 'started' },
        { id: 's-4', name: 'In Review', type: 'started' },
        { id: 's-3', name: 'Done', type: 'completed' },
        { id: 's-5', name: 'Canceled', type: 'canceled' },
        { id: 's-6', name: 'Duplicate', type: 'duplicate' },
      ],
    },
  ]);
  assert.match(linear.seen.find(s => s.path === '/graphql')!.body, /states \{ nodes \{ id name type position \} \}/);
});

test('resolveTeams takes ids and keys alike; an unknown token lists what the app can see', () => {
  const teams = [
    { id: 't-1', key: 'PEC', name: 'Peck Track', states: [] },
    { id: 't-2', key: 'WEB', name: 'Web & Docs', states: [] },
  ];
  assert.deepEqual(
    resolveTeams(teams, ['t-2', 'pec', 'pec']),
    ['t-2', 't-1'],
    'ids match exactly, keys ignore case, duplicates collapse, order is kept',
  );
  assert.throws(
    () => resolveTeams(teams, ['SEC']),
    /SEC is not a team this app can see \(visible: PEC \(Peck Track\), WEB \(Web & Docs\)\)/,
  );
});

/** Linear answered by a function, with no socket: the token is handed out,
 *  and every GraphQL call gets the data of the moment. */
function scripted() {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const now: { data: unknown } = { data: {} };
  const client = new LinearClient(
    { clientId: 'cid', clientSecret: 'sec' },
    {
      fetch: async (url, init) => {
        if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 86_399 });
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({ data: now.data });
      },
    },
  );
  return {
    client,
    answer: (data: unknown) => {
      now.data = data;
    },
    sent: () => calls.at(-1)?.variables,
  };
}

/** An issue as Linear's connections spell it. */
const rawIssue = (id: string, priority: number, createdAt: string) => ({
  id,
  identifier: id.toUpperCase(),
  title: `Ticket ${id}`,
  priority,
  createdAt,
  labels: { nodes: [] },
  inverseRelations: { nodes: [] },
});

test('each mutation sends its variables and refuses an answer that is not a success', async () => {
  const linear = scripted();
  const { client } = linear;
  const plan = [{ content: 'Read the ticket', status: 'completed' }];
  for (const { field, call, variables, refusal } of [
    {
      field: 'issueUpdate',
      call: () => client.transitionIssue('i1', 'state-doing'),
      variables: { id: 'i1', input: { stateId: 'state-doing' } },
      refusal: /issueUpdate was not successful/,
    },
    {
      field: 'issueAddLabel',
      call: () => client.addLabel('i1', 'label-1'),
      variables: { id: 'i1', labelId: 'label-1' },
      refusal: /issueAddLabel was not successful/,
    },
    {
      field: 'issueRemoveLabel',
      call: () => client.removeLabel('i1', 'label-1'),
      variables: { id: 'i1', labelId: 'label-1' },
      refusal: /issueRemoveLabel was not successful/,
    },
    {
      field: 'commentCreate',
      call: () => client.createComment('i1', 'Done.'),
      variables: { input: { issueId: 'i1', body: 'Done.' } },
      refusal: /commentCreate was not successful/,
    },
    {
      field: 'agentSessionUpdate',
      call: () => client.setPlan('as-1', plan),
      variables: { id: 'as-1', input: { plan } },
      refusal: /agentSessionUpdate was not successful/,
    },
    {
      field: 'issueDelete',
      call: () => client.deleteIssue('i1'),
      variables: { id: 'i1' },
      refusal: /issueDelete failed/,
    },
  ]) {
    linear.answer({ [field]: { success: true } });
    await call();
    assert.deepEqual(linear.sent(), variables, field);
    linear.answer({ [field]: { success: false } });
    await assert.rejects(call(), refusal);
  }
});

test('operations that answer with an issue or a session return it, and refuse a failure', async () => {
  const linear = scripted();
  const { client } = linear;
  const { inverseRelations: _, ...fields } = rawIssue('i1', 2, '2026-01-02T00:00:00Z');
  const flat = { ...fields, labels: [], blockedBy: [] };

  linear.answer({ issueUpdate: { success: true, issue: rawIssue('i1', 2, '2026-01-02T00:00:00Z') } });
  assert.deepEqual(await client.issueUpdate('i1', { title: 'New words' }), flat);
  assert.deepEqual(linear.sent(), { id: 'i1', input: { title: 'New words' } });
  linear.answer({ issueUpdate: { success: true, issue: null } });
  await assert.rejects(client.issueUpdate('i1', { title: 'x' }), /issueUpdate was not successful/);
  linear.answer({ issueUpdate: { success: false, issue: null } });
  await assert.rejects(client.issueUpdate('i1', { title: 'x' }), /issueUpdate was not successful/);

  linear.answer({ issueCreate: { success: true, issue: rawIssue('i1', 2, '2026-01-02T00:00:00Z') } });
  assert.deepEqual(await client.createIssue({ teamId: 't-1', title: 'Throwaway' }), flat);
  assert.deepEqual(linear.sent(), { input: { teamId: 't-1', title: 'Throwaway' } });
  linear.answer({ issueCreate: { success: false } });
  await assert.rejects(client.createIssue({ teamId: 't-1', title: 'Throwaway' }), /issueCreate failed/);

  const delegated = {
    success: true,
    issue: { identifier: 'ENG-1', agentSessions: { nodes: [{ id: 'as-1', status: 'pending', startedAt: null }] } },
  };
  linear.answer({ issueUpdate: delegated });
  assert.deepEqual(await client.setDelegate('i1', 'app-1'), delegated, 'the answer carries the agent session');
  assert.deepEqual(linear.sent(), { id: 'i1', input: { delegateId: 'app-1' } });
  linear.answer({ issueUpdate: { success: false } });
  await assert.rejects(client.setDelegate('i1', null), /issueUpdate\(delegateId\) failed/);

  linear.answer({ agentActivityCreate: { success: true, agentActivity: { id: 'activity-1' } } });
  assert.equal(
    await client.createActivity({ agentSessionId: 'as-1', content: { type: 'thought', body: 'hi' } }),
    'activity-1',
  );
});

test('reads return Linear’s facts in the order a person expects, and say when the thing is gone', async () => {
  const linear = scripted();
  const { client } = linear;

  linear.answer({
    issue: {
      comments: {
        nodes: [
          { body: 'second', createdAt: '2026-01-02T00:00:00Z', user: null },
          { body: 'first', createdAt: '2026-01-01T00:00:00Z', user: { name: 'Robin' } },
        ],
      },
      agentSessions: { nodes: [{ id: 'as-1', url: 'https://linear.app/s/as-1' }] },
    },
  });
  assert.deepEqual(await client.issueComments('i1'), [
    { author: 'Robin', body: 'first', at: '2026-01-01T00:00:00Z' },
    { author: null, body: 'second', at: '2026-01-02T00:00:00Z' },
  ]);
  const facts = await client.closingNoteFacts('i1');
  assert.deepEqual(facts.sessions, [{ id: 'as-1', url: 'https://linear.app/s/as-1' }]);
  assert.equal(facts.comments.length, 2);
  linear.answer({ issue: null });
  await assert.rejects(client.issueComments('i1'), /Entity not found: Issue/);
  await assert.rejects(client.closingNoteFacts('i1'), /issue i1 not found/);

  linear.answer({ team: { labels: { nodes: [{ name: 'bug' }, { name: 'needs-human' }] } } });
  assert.deepEqual(await client.teamLabelNames('t-1'), ['bug', 'needs-human']);
  linear.answer({ team: null });
  await assert.rejects(client.teamLabelNames('t-1'), /team t-1 not found/);

  linear.answer({ agentSession: { endedAt: null } });
  assert.equal(await client.agentSessionEnded('as-1'), false);
  linear.answer({ agentSession: { endedAt: '2026-01-02T00:00:00Z' } });
  assert.equal(await client.agentSessionEnded('as-1'), true);

  linear.answer({
    issues: {
      nodes: [
        rawIssue('unranked', 0, '2026-01-01T00:00:00Z'),
        rawIssue('urgent', 1, '2026-01-03T00:00:00Z'),
        rawIssue('high-newer', 2, '2026-01-02T00:00:00Z'),
        rawIssue('high-older', 2, '2026-01-01T00:00:00Z'),
      ],
      pageInfo: { hasNextPage: true },
    },
  });
  const lane = await client.issuesIn('t-1', 'state-todo');
  assert.deepEqual(
    lane.issues.map(issue => issue.id),
    ['urgent', 'high-older', 'high-newer', 'unranked'],
    'Linear’s priority order, oldest first within a rank, unranked last',
  );
  assert.equal(lane.truncated, true, 'more than a page sits in the lane, and the walk is told');
  assert.deepEqual(linear.sent(), { teamId: 't-1', stateId: 'state-todo' });
});

test('a label name resolves to the team’s own label, then the workspace’s, and is created when nobody has it', async () => {
  const linear = scripted();
  const { client } = linear;
  const workspace = { id: 'workspace-label', team: null };
  const foreign = { id: 'other-team-label', team: { id: 't-2' } };

  linear.answer({ issueLabels: { nodes: [workspace, foreign, { id: 'own-label', team: { id: 't-1' } }] } });
  assert.equal(await client.labelIdForTeam('t-1', 'needs-human'), 'own-label');
  linear.answer({ issueLabels: { nodes: [foreign, workspace] } });
  assert.equal(await client.labelIdForTeam('t-1', 'needs-human'), 'workspace-label');

  linear.answer({
    issueLabels: { nodes: [foreign] },
    issueLabelCreate: { success: true, issueLabel: { id: 'new-label' } },
  });
  assert.equal(await client.labelIdForTeam('t-1', 'needs-human'), 'new-label');
  assert.deepEqual(linear.sent(), { input: { name: 'needs-human', teamId: 't-1' } }, 'created on the team');
  linear.answer({ issueLabels: { nodes: [] }, issueLabelCreate: { success: false } });
  await assert.rejects(client.labelIdForTeam('t-1', 'needs-human'), /label "needs-human" was not created/);
});

test('a token request Linear refuses is said with its status and its words', async () => {
  const client = new LinearClient(
    { clientId: 'cid', clientSecret: 'sec' },
    { fetch: async () => new Response('upstream down', { status: 503 }) },
  );
  await assert.rejects(
    client.viewerId(),
    (error: unknown) =>
      error instanceof LinearApiError &&
      error.status === 503 &&
      /Linear token request failed \(503\): upstream down/.test(error.message),
  );
});

/** Linear answered by two functions, no socket: what the token endpoint says and what the API says. */
const answering = (token: () => Response, api: () => Response, log?: Logger) =>
  new LinearClient(
    { clientId: 'cid', clientSecret: 'sec' },
    { fetch: async url => (url.endsWith('/oauth/token') ? token() : api()), log },
  );
const goodToken = () => Response.json({ access_token: 'tok', expires_in: 86_399 });

test('a token answer with no token in it is refused, and so is a GraphQL answer with no data and no errors', async () => {
  await assert.rejects(
    answering(
      () => Response.json({ expires_in: 60 }),
      () => Response.json({}),
    ).viewer(),
    (error: unknown) =>
      error instanceof LinearApiError &&
      error.status === 502 &&
      /Linear token response had no access_token/.test(error.message),
  );
  await assert.rejects(
    answering(goodToken, () => Response.json({})).viewer(),
    (error: unknown) =>
      error instanceof LinearApiError && error.status === 502 && /Linear API returned no data/.test(error.message),
  );
});

test('a token that names no lifetime is good for a day, less the hour kept back for refreshing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const lines = recorder();
  let minted = 0;
  const client = new LinearClient(
    { clientId: 'cid', clientSecret: 'sec' },
    { fetch: async () => Response.json({ access_token: `tok-${++minted}` }), log: lines.log },
  );
  assert.equal(await client.accessToken(), 'tok-1');
  t.mock.timers.setTime(22 * 3_600_000);
  assert.equal(await client.accessToken(), 'tok-1', 'twenty-two hours on it still stands');
  t.mock.timers.setTime(23 * 3_600_000 + 1);
  assert.equal(await client.accessToken(), 'tok-2', 'a day less the hour: it is minted again');
  assert.deepEqual(lines.said('debug')[0], { level: 'debug', event: 'linear.token', expiresIn: null });
});

test('GraphQL errors keep the codes Linear gave them; an error that gave none keeps an empty one', async () => {
  const client = answering(goodToken, () =>
    Response.json({ errors: [{ message: 'bad input', extensions: { code: 'INPUT_ERROR' } }, { message: 'worse' }] }),
  );
  await assert.rejects(
    client.viewer(),
    (error: unknown) =>
      error instanceof LinearApiError &&
      error.message === 'bad input; worse' &&
      error.status === 200 &&
      JSON.stringify(error.codes) === JSON.stringify(['INPUT_ERROR', '']),
  );
});

test('an issue Linear answers with nothing is gone, in the words the closing already knows', async () => {
  const client = answering(goodToken, () => Response.json({ data: { issue: null } }));
  await assert.rejects(client.issue('iss-1'), (error: unknown) => LinearApiError.isGone(error));
});

test('a refusal says what Linear said, in whichever shape it said it: an OAuth error, an empty object, or nothing parseable', async () => {
  const oauth = new LinearClient(
    { clientId: 'cid', clientSecret: 'sec' },
    {
      fetch: async () =>
        new Response(JSON.stringify({ error: 'invalid_client', error_description: 'bad secret' }), { status: 401 }),
    },
  );
  await assert.rejects(oauth.viewer(), /Linear token request failed \(401\): invalid_client: bad secret/);
  await assert.rejects(
    answering(goodToken, () => new Response('{}', { status: 500 })).viewer(),
    /Linear API 500: \{\}/,
    'a shape with nothing in it falls back to the body',
  );
  await assert.rejects(
    answering(goodToken, () => new Response('', { status: 502 })).viewer(),
    /Linear API 502: Unexpected end of JSON input/,
    'no body at all falls back to why it could not be read',
  );
});
