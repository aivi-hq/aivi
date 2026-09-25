import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema } from '@aivi/core';
import { createApp, serveApp } from '../src/api/app.ts';
import { PublicRoutes } from '../src/api/public.ts';
import { createHostClient } from '../src/client.ts';
import { JobRefused } from '../src/jobs.ts';
import { Store } from '../src/store.ts';
import { hostVersion } from '../src/version.ts';

/** The header the version gate asks of every request that is not `/health`, `/version` or a webhook. */
const api = { 'x-aivi-client': hostVersion };

test('the read API scopes sources and refuses job operations without a handler; commands are open', async t => {
  const store = new Store(':memory:');
  const loaded: LoadedConfig = {
    path: '/config.json',
    config: configSchema.parse({ version: 1 }),
    projects: [
      { id: 'app', directory: '/app' },
      { id: 'old', directory: '/projects/old', removed: true },
    ],
    sources: [
      { id: 'company', path: '/company', kind: 'doc', scope: 'core' },
      { id: 'adrs', path: '/app/docs', kind: 'decision', scope: 'project', projectId: 'app' },
      { id: 'memory', path: '/memory/old', kind: 'memory', scope: 'project', projectId: 'old' },
    ],
  };
  const searches: unknown[] = [];
  const server = serveApp(
    createApp({
      store,
      loaded,
      knowledge: {
        async search(request) {
          searches.push(request);
          return [];
        },
        async index() {},
        async close() {},
      },
      context: async sessionID => {
        if (sessionID === 'ses_gone') throw new Error('not found');
        return `🧠 **Context** for ${sessionID}`;
      },
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = createHostClient(base);
  assert.equal((await fetch(`${base}/status`, { headers: api })).status, 200, 'commands are open');
  assert.equal((await fetch(`${base}/health`)).status, 200, 'liveness is public');
  assert.equal((await client.status()).sources, 3);
  assert.equal((await client.sources({ projects: [] })).length, 1);
  assert.equal((await client.sources({ projects: ['app'], includeCore: false }))[0]!.projectId, 'app');
  assert.deepEqual(
    (await client.sources({ kinds: ['decision'] })).map(s => s.id),
    ['adrs'],
    'kind filter',
  );
  assert.equal((await fetch(`${base}/sources?kind=gossip`, { headers: api })).status, 400);
  await assert.rejects(client.sources({ projects: ['typo'] }), /HTTP 400: Unknown project: typo/);
  assert.deepEqual(await client.context('ses_x'), { text: '🧠 **Context** for ses_x' });
  await assert.rejects(client.context('ses_gone'), /HTTP 502: Could not read that session/);
  assert.equal((await fetch(`${base}/context`, { headers: api })).status, 400);
  assert.deepEqual(await client.projects(), [
    { id: 'app', sources: [{ id: 'adrs', kind: 'decision' }] },
    { id: 'old', removed: true, sources: [{ id: 'memory', kind: 'memory' }] },
  ]);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', headers: api })).status, 503);
  assert.equal((await fetch(`${base}/sources?includeCore=no`, { headers: api })).status, 400);
  assert.deepEqual(
    await client.search({ query: 'deployment', projects: [], includeCore: false, limit: 3, kinds: ['memory'] }),
    [],
  );
  assert.deepEqual(searches, [{ query: 'deployment', projects: [], includeCore: false, limit: 3, kinds: ['memory'] }]);
  await assert.rejects(client.search({ query: 'deployment', projects: ['typo'] }), /HTTP 400: Unknown project/);
  assert.equal(searches.length, 1);
  assert.equal(
    (await fetch(`${base}/status`, { headers: { ...api, authorization: 'Bearer aivi-not-a-real-token' } })).status,
    200,
    'an unknown bearer is accepted, anonymous',
  );
});

test('commands are open: anonymous and unknown bearers are accepted; a known bearer names its person', async t => {
  const { bearerPerson } = await import('../src/api/person.ts');
  const store = new Store(':memory:');
  const nemo = store.createPerson({ name: 'Nemo' });
  const { secret } = store.mintToken(nemo.id, 'laptop');
  const loaded = {
    path: '/config',
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  const server = serveApp(createApp({ store, loaded }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await createHostClient(base).status()).sources, 0, 'anonymous is served');
  assert.equal(
    (await fetch(`${base}/status`, { headers: { ...api, authorization: 'Bearer aivi-unknown' } })).status,
    200,
    'an unknown bearer is accepted, anonymous',
  );
  assert.equal(
    (await fetch(`${base}/status`, { headers: { ...api, authorization: `Bearer ${secret}` } })).status,
    200,
    'a person token is served too',
  );
  assert.deepEqual(bearerPerson(store, `Bearer ${secret}`), nemo);
  assert.deepEqual(bearerPerson(store, 'Bearer aivi-unknown'), null);
  assert.deepEqual(bearerPerson(store, undefined), null);
  assert.deepEqual(bearerPerson(store, ''), null);
});

test('people management creates, lists and mints tokens over the API', async t => {
  const store = new Store(':memory:');
  const loaded = {
    path: '/config',
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  const server = serveApp(createApp({ store, loaded }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  // Fixed instants in the past: people() ordering is created_at,id, and the
  // assertion must never depend on the wall clock or a UUID tiebreak.
  const now = 1_700_000_000_000;
  const anonymous = createHostClient(base);
  await assert.rejects(anonymous.createPerson({ name: 'Nemo' }), /401.*names who you are/);
  await assert.rejects(anonymous.people(), /401.*names who you are/);

  const member = store.createPerson({ name: 'Member' }, now + 1000);
  const memberToken = store.mintToken(member.id, 'laptop').secret;
  const memberClient = createHostClient(base, { token: memberToken });
  await assert.rejects(memberClient.createPerson({ name: 'Nemo' }), /403.*Only an operator/);
  await assert.rejects(memberClient.people(), /403.*Only an operator/);

  const operator = store.createPerson({ name: 'Ada', roles: ['operator'] }, now);
  const operatorToken = store.mintToken(operator.id, 'laptop').secret;
  const client = createHostClient(base, { token: operatorToken });
  const nemo = await client.createPerson({ name: 'Nemo', email: 'nemo@example.com' });
  assert.match(nemo.id, /^person-[0-9a-f]{8}$/);
  assert.deepEqual(nemo.roles, ['member'], 'new people are members unless the operator says otherwise');
  assert.deepEqual(await client.people(), [operator, member, nemo]);
  const minted = await client.createPersonToken(nemo.id, 'laptop');
  assert.match(minted.secret, /^aivi-[0-9a-f]{32}$/);
  assert.deepEqual(store.personForToken(minted.secret)!.person.id, nemo.id);
  await assert.rejects(client.createPersonToken('person-none', 'x'), /HTTP 404: Unknown person/);
  await assert.rejects(client.createPerson({ name: '' }), /HTTP 400: Invalid person/);
  const promoted = await client.createPerson({ name: 'Ada2', roles: ['operator'] });
  assert.deepEqual(promoted.roles, ['operator']);
});

test('whoami names the caller and refuses to guess', async t => {
  const store = new Store(':memory:');
  const nemo = store.createPerson({ name: 'Nemo', roles: ['operator'] });
  const { secret } = store.mintToken(nemo.id, 'laptop');
  const loaded = {
    path: '/config',
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  const server = serveApp(createApp({ store, loaded }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/whoami`, { headers: api })).status, 401, 'anonymous cannot be named');
  assert.equal(
    (await fetch(`${base}/whoami`, { headers: { ...api, authorization: 'Bearer aivi-unknown' } })).status,
    401,
    'an unknown token cannot be named',
  );
  assert.deepEqual(await createHostClient(base, { token: secret }).whoami(), {
    person: { id: nemo.id, name: 'Nemo' },
    roles: ['operator'],
  });
  await assert.rejects(createHostClient(base).whoami(), /401.*whoami names a person/);
});

test('a link code is minted over HTTP with the bearer and names where to spend it', async t => {
  const store = new Store(':memory:');
  const ada = store.createPerson({ name: 'Ada', roles: ['operator'] });
  const { secret } = store.mintToken(ada.id, 'laptop');
  const loaded = {
    path: '/config',
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  const server = serveApp(
    createApp({
      store,
      loaded,
      linkable: () => [{ id: 'discord', hint: 'In Discord, DM the bot: /link <code>.' }],
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { ...api, authorization: `Bearer ${secret}` };
  assert.equal(
    (await fetch(`${base}/links`, { method: 'POST', headers: api })).status,
    401,
    'anonymous has no person to bind',
  );
  // GET lists the running channels with this person's binding state.
  const listed = (await (await fetch(`${base}/links`, { headers: auth })).json()) as {
    channels: { channel: string; hint?: string; linked: boolean }[];
  };
  assert.deepEqual(listed.channels, [
    { channel: 'discord', hint: 'In Discord, DM the bot: /link <code>.', linked: false },
  ]);
  // The mint names its channel: a bodyless POST is malformed, an unknown
  // channel is refused with nothing minted.
  assert.equal(
    (await fetch(`${base}/links`, { method: 'POST', headers: auth })).status,
    415,
    'the mint request is malformed without a JSON channel',
  );
  const nowhere = await fetch(`${base}/links`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'teams' }),
  });
  assert.equal(nowhere.status, 404);
  // A real mint: the instruction carries the code, the channel is named back.
  const minted = await fetch(`${base}/links`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'discord' }),
  });
  const body = (await minted.json()) as { code: string; expiresAt: string; person: string; next: string };
  assert.equal(minted.status, 200);
  assert.match(body.code, /^\d{5}$/);
  assert.equal(body.person, 'Ada');
  assert.match(body.next, new RegExp(`/link ${body.code}`), 'the one instruction names the code');
  // The code the HTTP route minted redeems in the store: one hash, no plaintext.
  const outcome = store.redeemLinkCode(body.code, 'discord', 'u1');
  assert.equal(outcome.reason, 'bound');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM link_codes').get()!.n, 0, 'one-time use');
  // The binding exists, so GET says linked — and a second mint is refused
  // without consuming anything: one binding per channel per person.
  const relisted = (await (await fetch(`${base}/links`, { headers: auth })).json()) as {
    channels: { channel: string; linked: boolean }[];
  };
  assert.equal(relisted.channels[0]!.linked, true);
  const again = await fetch(`${base}/links`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'discord' }),
  });
  assert.equal(again.status, 409);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM link_codes').get()!.n, 0, 'the refusal minted nothing');
});

test('jobs API validates the body, maps refusals to their status, and status lists upcoming and recent work', async t => {
  const store = new Store(':memory:');
  const loaded: LoadedConfig = {
    path: '/config.json',
    config: configSchema.parse({
      version: 1,
      jobs: [
        {
          id: 'nightly',
          title: 'Nightly check',
          cron: '0 3 * * *',
          task: { kind: 'invocation', name: 'system.check' },
        },
      ],
    }),
    projects: [],
    sources: [],
  };
  store.syncJobs(loaded.config.jobs, [], Date.now());
  const done = store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', 'done');
  const claimed = store.claim('host', 1, { 'local-model': 1 })!;
  store.finish(claimed.id, 'host', 'failed', null, 'boom');
  const requests: unknown[] = [];
  const server = serveApp(
    createApp({
      store,
      loaded,
      jobs: async request => {
        requests.push(request);
        if (request.action === 'run') throw new JobRefused('Jobs do not create jobs', 403);
        if (request.action === 'remove') throw new Error('sqlite exploded');
        return { summary: `ok ${request.action}`, items: [] };
      },
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = createHostClient(base);
  const status = await client.status();
  assert.deepEqual(
    status.upcoming.map(u => [u.id, u.source, u.kind, u.title]),
    [['nightly', 'config', 'system.check', 'Nightly check']],
  );
  assert.deepEqual(
    status.recent.map(r => [r.id, r.jobId, r.state, r.error]),
    [[done.id, done.jobId, 'failed', 'boom']],
  );

  const post = (body: unknown, type = 'application/json') =>
    fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { ...api, 'content-type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  assert.equal((await fetch(`${base}/jobs`, { headers: api })).status, 405);
  assert.equal((await post('x', 'text/plain')).status, 415);
  assert.equal((await post({ action: 'create' })).status, 400, 'sessionId is required');
  assert.equal((await post({ action: 'create', sessionId: 's', prompt: 'p', at: '1h', bogus: 1 })).status, 400);
  assert.deepEqual(await client.jobs({ action: 'list', sessionId: 's' }), { summary: 'ok list', items: [] });
  await assert.rejects(client.jobs({ action: 'run', sessionId: 's', id: 'x' }), /HTTP 403: Jobs do not create jobs/);
  await assert.rejects(
    client.jobs({ action: 'remove', sessionId: 's', id: 'x' }),
    /HTTP 500: The job operation failed on the host/,
  );
  assert.deepEqual(
    requests[0] as { action: string; sessionId: string },
    { action: 'list', sessionId: 's' },
    'defaults are applied by the schema before the handler sees the request',
  );
  const created = (await post({ action: 'create', sessionId: 's', prompt: 'p', at: '1h' })).status;
  assert.equal(created, 200);
  assert.deepEqual((requests.at(-1) as { report: string; on: string }).report, 'session');
  assert.deepEqual((requests.at(-1) as { report: string; on: string }).on, 'always');
});

test('public routes bypass bearer auth, see the raw body, and are owned by one handler', async t => {
  const store = new Store(':memory:');
  const routes = new PublicRoutes();
  const seen: { method: string; body: string; header: string | undefined }[] = [];
  const unregister = routes.register('/linear/webhooks/dev', async request => {
    seen.push({
      method: request.method,
      body: request.body.toString('utf8'),
      header: String(request.headers['linear-signature']),
    });
    return { status: 202, body: { accepted: true } };
  });
  assert.throws(() => routes.register('/linear/webhooks/dev', async () => ({ status: 200 })), /registered twice/);
  assert.throws(() => routes.register('hooks', async () => ({ status: 200 })), /absolute path/);
  assert.throws(() => routes.register('/health', async () => ({ status: 200 })), /never \/health or \/version/);
  const server = serveApp(
    createApp({
      store,
      loaded: { path: '/config.json', config: configSchema.parse({ version: 1 }), projects: [], sources: [] },
      routes,
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const raw = '{"a":1,  "b": "spacing kept"}';
  const response = await fetch(`${base}/linear/webhooks/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'linear-signature': 'abc' },
    body: raw,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(seen, [{ method: 'POST', body: raw, header: 'abc' }], 'the body arrives byte for byte');
  assert.equal(
    (await fetch(`${base}/linear/webhooks/other`, { method: 'POST', headers: api })).status,
    405,
    'unknown POST paths never reach a route',
  );
  unregister();
  assert.equal(
    (await fetch(`${base}/linear/webhooks/dev`, { method: 'POST', headers: api })).status,
    405,
    'unregistered is gone',
  );
});

test('the gate as plumbing: exempt paths answer, the shipped client passes, silence does not', async t => {
  const store = new Store(':memory:');
  const server = serveApp(
    createApp({
      store,
      loaded: { path: '/config.json', config: configSchema.parse({ version: 1 }), projects: [], sources: [] },
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  // Liveness and the negotiation's own answer need no header at all.
  assert.equal((await fetch(`${base}/health`)).status, 200, 'liveness is exempt');
  assert.deepEqual(await (await fetch(`${base}/version`)).json(), { version: hostVersion });
  // The rule itself is unit-tested in gate.test.ts against fixed versions;
  // here only the wiring: the client that ships with this host always
  // passes, and names this host's own version; silence gets the refusal.
  assert.equal((await createHostClient(base).status()).version, hostVersion);
  const silent = await fetch(`${base}/status`);
  assert.equal(silent.status, 403, 'silence is not a pass');
  assert.equal((await silent.json()).code, 'client_version_unsupported');
});
