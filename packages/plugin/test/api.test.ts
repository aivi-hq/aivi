/** The aivi host client: what each call asks of the server and what it makes of the answer.
 *  `fetch` is the one thing it reaches, so it is scripted here: no test opens a socket. The
 *  server's own side of the same wire is `host/test/http.test.ts`. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { type TestContext, test } from 'node:test';
import type { HostClient } from '@aivi/core';
import { createHostClient } from '../src/api.ts';

const BASE = 'http://127.0.0.1:4100';
const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** The host answering: a JSON body, or a plain-text one. */
const answering =
  (body: unknown, status = 200) =>
  () =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

/** `fetch` answering as scripted (change it with `fetch.mock.mockImplementation`), and
 *  `AbortSignal.timeout` recording the time each call was given. */
function wire(t: TestContext, reply: () => Promise<Response>) {
  const fetch = t.mock.method(globalThis, 'fetch', (_url: string | URL | Request, _init?: RequestInit) => reply());
  const timeouts = t.mock.method(AbortSignal, 'timeout', (_ms: number) => new AbortController().signal);
  const first = () => fetch.mock.calls[0]!.arguments[1] as RequestInit;
  return {
    fetch,
    asked: () =>
      fetch.mock.calls.map(call => {
        const init = call.arguments[1] as RequestInit;
        return {
          method: init.method ?? 'GET',
          url: String(call.arguments[0]),
          ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        };
      }),
    budgets: () => timeouts.mock.calls.map(call => call.arguments[0]),
    headers: () => first().headers,
    redirect: () => first().redirect,
  };
}

const tool = { id: 'aivi_status', namespace: 'aivi', name: 'status', description: 'Status.', input: {}, timeoutMs: 1 };
const person = { id: 'person-1', name: 'Ada' };

/** One call of the client: what it must ask, within what time, and what it hands back. */
const calls: {
  name: string;
  ask: (client: HostClient) => Promise<unknown>;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  budget: number;
  reply: unknown;
  result?: unknown;
}[] = [
  { name: 'status', ask: c => c.status(), method: 'GET', path: '/status', budget: 10_000, reply: { version } },
  {
    name: 'search across projects, kinds and core',
    ask: c =>
      c.search({ query: 'leave policy', limit: 3, projects: ['a', 'b'], includeCore: false, kinds: ['doc', 'memory'] }),
    method: 'GET',
    path: '/knowledge/search?q=leave+policy&limit=3&project=a&project=b&includeCore=false&kind=doc&kind=memory',
    budget: 10_000,
    reply: [],
  },
  {
    name: 'search with an explicit empty selection means core only',
    ask: c => c.search({ query: 'x', projects: [] }),
    method: 'GET',
    path: '/knowledge/search?q=x&coreOnly=true',
    budget: 10_000,
    reply: [],
  },
  {
    name: 'sources of one project',
    ask: c => c.sources({ projects: ['a'] }),
    method: 'GET',
    path: '/sources?project=a',
    budget: 10_000,
    reply: [],
  },
  {
    name: 'sources with no selection',
    ask: c => c.sources(),
    method: 'GET',
    path: '/sources?',
    budget: 10_000,
    reply: [],
  },
  { name: 'projects', ask: c => c.projects(), method: 'GET', path: '/projects', budget: 10_000, reply: [] },
  {
    name: 'the served tools are the list inside the answer',
    ask: c => c.listTools(),
    method: 'GET',
    path: '/tools',
    budget: 10_000,
    reply: { tools: [tool] },
    result: [tool],
  },
  {
    name: 'a tool call carries its session, message and input, and its own time budget',
    ask: c =>
      c.callTool('aivi_browser', {
        sessionId: 'ses_1',
        messageId: 'msg_1',
        input: { action: 'tabs' },
        timeoutMs: 300_000,
      }),
    method: 'POST',
    path: '/tools',
    body: { tool: 'aivi_browser', sessionId: 'ses_1', messageId: 'msg_1', input: { action: 'tabs' } },
    budget: 300_000,
    reply: { tabs: [] },
  },
  {
    name: 'a tool call without a message or a budget leaves both out',
    ask: c => c.callTool('aivi_status', { sessionId: 'ses_1', input: {} }),
    method: 'POST',
    path: '/tools',
    body: { tool: 'aivi_status', sessionId: 'ses_1', input: {} },
    budget: 10_000,
    reply: {},
  },
  { name: 'health', ask: c => c.health(), method: 'GET', path: '/health', budget: 3_000, reply: { ok: true } },
  {
    name: 'run membership of a session',
    ask: c => c.runMembership('ses_1'),
    method: 'GET',
    path: '/run?session=ses_1',
    budget: 3_000,
    reply: { run: true },
  },
  {
    name: 'context of a session',
    ask: c => c.context('ses_1'),
    method: 'GET',
    path: '/context?session=ses_1',
    budget: 20_000,
    reply: { text: 'Context' },
  },
  { name: 'wake', ask: c => c.wake(), method: 'POST', path: '/wake', budget: 3_000, reply: { woken: true } },
  { name: 'whoami', ask: c => c.whoami(), method: 'GET', path: '/whoami', budget: 10_000, reply: { person } },
  { name: 'people', ask: c => c.people(), method: 'GET', path: '/people', budget: 10_000, reply: [person] },
  {
    name: 'a new person',
    ask: c => c.createPerson({ name: 'Ada', roles: ['operator'] }),
    method: 'POST',
    path: '/people',
    body: { name: 'Ada', roles: ['operator'] },
    budget: 10_000,
    reply: person,
  },
  {
    name: 'a person’s token is minted at a path that carries their id as one segment',
    ask: c => c.createPersonToken('person/1', 'laptop'),
    method: 'POST',
    path: '/people/person%2F1/tokens',
    body: { label: 'laptop' },
    budget: 10_000,
    reply: { secret: 'aivi-x' },
  },
  {
    name: 'a job has the longest budget: the host checks the calling session first',
    ask: c => c.jobs({ action: 'list', sessionId: 'ses_1' }),
    method: 'POST',
    path: '/jobs',
    body: { action: 'list', sessionId: 'ses_1' },
    budget: 30_000,
    reply: { summary: 'None', items: [] },
  },
];

test('every call asks the host what it means to, within the time it is allowed, and returns what the host answered', async t => {
  for (const { name, ask, method, path, body, budget, reply, result } of calls) {
    await t.test(name, async s => {
      const server = wire(s, answering(reply));

      const got = await ask(createHostClient(BASE));

      assert.deepEqual(server.asked(), [{ method, url: `${BASE}${path}`, ...(body === undefined ? {} : { body }) }]);
      assert.deepEqual(server.budgets(), [budget]);
      assert.deepEqual(got, result ?? reply);
    });
  }
});

test('every request says which client it is, never follows a redirect, and carries the bearer when there is one', async t => {
  const server = wire(t, answering({ ok: true }));

  await createHostClient(BASE).health();
  assert.deepEqual(server.headers(), { 'x-aivi-client': version });
  assert.equal(server.redirect(), 'error', 'a host that redirects is a host to refuse, not to follow');

  server.fetch.mock.resetCalls();
  await createHostClient(`${BASE}/`, { token: 'aivi-secret' }).health();
  assert.deepEqual(server.headers(), { 'x-aivi-client': version, authorization: 'Bearer aivi-secret' });
});

test('a body goes out as JSON, beside the headers every request carries', async t => {
  const server = wire(t, answering(person));

  await createHostClient(BASE).createPerson({ name: 'Ada' });

  assert.deepEqual(server.headers(), { 'x-aivi-client': version, 'content-type': 'application/json' });
});

test('a host URL that is not plain HTTP(S), or that carries credentials, is refused before anything is sent', () => {
  for (const url of [
    'ftp://127.0.0.1',
    'file:///etc/hosts',
    'http://user:secret@127.0.0.1:4100',
    'http://user@127.0.0.1',
  ])
    assert.throws(() => createHostClient(url), /Expected an HTTP host URL without embedded credentials/, url);
  assert.doesNotThrow(() => createHostClient('https://aivi.example'));
});

test('a host that does not answer is said to be down, naming where and why; a timeout stays a timeout', async t => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
  const server = wire(t, () => Promise.reject(refused));
  await assert.rejects(createHostClient(BASE).status(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `aivi is not reachable at ${BASE}. Is \`aivi serve\` running?`);
    assert.equal(error.cause, refused);
    return true;
  });

  const slow = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  server.fetch.mock.mockImplementation(() => Promise.reject(slow));
  await assert.rejects(createHostClient(BASE).status(), error => error === slow);
});

test('a refusal is said with the status and the reason the host gave, when it gave one', async t => {
  const server = wire(t, answering({}));
  const bearer = 'This endpoint needs a bearer token that names a person.';
  for (const [reply, status, said] of [
    [{ error: 'Unknown tool' }, 404, 'aivi host returned HTTP 404: Unknown tool'],
    ['<html>Bad Gateway</html>', 502, 'aivi host returned HTTP 502'],
    [{ error: { code: 7 } }, 500, 'aivi host returned HTTP 500'],
    [{ error: 'whoami names a person' }, 401, `aivi host rejected the request (401): whoami names a person. ${bearer}`],
    [{}, 401, `aivi host rejected the request (401). ${bearer}`],
  ] as const) {
    server.fetch.mock.mockImplementation(answering(reply, status));

    await assert.rejects(createHostClient(BASE).status(), error => (error as Error).message === said, said);
  }
});
