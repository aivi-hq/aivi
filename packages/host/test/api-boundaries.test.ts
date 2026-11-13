import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { configSchema, getLogger, jobSchema, taskSchema } from '@aivi/core';
import type { PublicRouteHandler } from '@aivi/plugin/module';
import { Hono } from 'hono';
import { createApp } from '../src/api/app.ts';
import type { AppEnv } from '../src/api/env.ts';
import { MAX_JOB_BODY, MAX_PUBLIC_BODY } from '../src/api/http.ts';
import { requireOperator, resolvePerson } from '../src/api/person.ts';
import { PublicRoutes, publicDispatch } from '../src/api/public.ts';
import { registerLinks } from '../src/api/routes/links.ts';
import { registerPeople } from '../src/api/routes/people.ts';
import { status } from '../src/api/status.ts';
import { Store } from '../src/store.ts';
import { hostVersion } from '../src/version.ts';

const loaded = { path: '/config.json', config: configSchema.parse({ version: 1 }), projects: [], sources: [] };
const json = { 'content-type': 'application/json' };

function storeFor(t: TestContext): Store {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

test('wake reports whether a dispatcher exists and invokes it once per request', async t => {
  const store = storeFor(t);
  const empty = createApp({ store, loaded });
  const absent = await empty.request('/wake', { method: 'POST', headers: { 'x-aivi-client': hostVersion } });
  assert.equal(absent.status, 200);
  assert.deepEqual(await absent.json(), { woken: false });
  let wakes = 0;
  const app = createApp({ store, loaded, wake: () => wakes++ });
  const response = await app.request('/wake', { method: 'POST', headers: { 'x-aivi-client': hostVersion } });
  assert.deepEqual(await response.json(), { woken: true });
  assert.equal(wakes, 1);
});

test('an unexpected API failure is logged and journaled, but its details are not exposed', async t => {
  const store = storeFor(t);
  const log = getLogger(['aivi', 'test', 'api']);
  const warn = t.mock.method(log, 'warn');
  const error = new Error('private failure details');
  const app = createApp({
    store,
    loaded,
    log,
    wake: () => {
      throw error;
    },
  });
  const response = await app.request('/wake', { method: 'POST', headers: { 'x-aivi-client': hostVersion } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal error' });
  assert.deepEqual(warn.mock.calls[0]!.arguments, ['api.failed', { path: '/wake', error }]);
  assert.equal(store.requests({ path: '/wake' })[0]!.status, 500);
});

test('public route registrations reject reserved and relative paths and stale unregisters keep replacements', t => {
  const routes = new PublicRoutes();
  const first = t.mock.fn<PublicRouteHandler>();
  for (const path of ['relative', '/health', '/version'])
    assert.throws(() => routes.register(path, first), /must be an absolute path/);
  const off = routes.register('/webhook', first);
  assert.throws(() => routes.register('/webhook', first), /registered twice/);
  off();
  const second = t.mock.fn<PublicRouteHandler>();
  const offSecond = routes.register('/webhook', second);
  off();
  assert.equal(routes.get('/webhook'), second);
  offSecond();
  assert.equal(routes.get('/webhook'), undefined);
});

test('public dispatch supplies an empty response body when omitted and keeps handler failures private', async t => {
  const routes = new PublicRoutes();
  routes.register('/empty', async () => ({ status: 202 }));
  const error = new Error('private webhook failure');
  routes.register('/broken', async () => {
    throw error;
  });
  const log = getLogger(['aivi', 'test', 'public']);
  const warn = t.mock.method(log, 'warn');
  const app = new Hono<AppEnv>();
  app.use('*', publicDispatch(routes, log));
  const accepted = await app.request('/empty', { method: 'POST' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {});
  const refused = await app.request('/broken', { method: 'POST' });
  assert.equal(refused.status, 500);
  assert.deepEqual(await refused.json(), { error: 'Internal error' });
  assert.deepEqual(warn.mock.calls[0]!.arguments, ['api.public.failed', { path: '/broken', error }]);
  assert.equal((await app.request('/unknown')).status, 404);
});

test('public dispatch refuses oversized raw bytes without calling the webhook handler', async t => {
  const routes = new PublicRoutes();
  const deliver = t.mock.fn<PublicRouteHandler>();
  routes.register('/webhook', deliver);
  const app = new Hono<AppEnv>();
  app.use('*', publicDispatch(routes, getLogger(['aivi', 'test', 'public'])));
  const response = await app.request('/webhook', { method: 'POST', body: new Uint8Array(MAX_PUBLIC_BODY + 1) });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Body too large' });
  assert.equal(deliver.mock.callCount(), 0);
});

test('person token routes check identity first and refuse wrong, malformed and oversized bodies without minting', async t => {
  const store = storeFor(t);
  const person = store.createPerson({ name: 'Ada', roles: ['operator'] });
  const bearer = store.mintToken(person.id, 'operator').secret;
  const headers = { ...json, authorization: `Bearer ${bearer}` };
  const app = new Hono<AppEnv>();
  app.use('*', resolvePerson(store), requireOperator);
  registerPeople(app, { store });
  const post = (body: string, extra = headers, id = person.id) =>
    app.request(`/people/${id}/tokens`, { method: 'POST', headers: extra, body });
  const before = store.db.prepare('SELECT count(*) AS n FROM tokens').get()!.n;
  assert.equal((await post('{broken', headers, 'unknown')).status, 404);
  assert.equal((await post('{}', { ...headers, 'content-type': 'text/plain' })).status, 415);
  const malformed = await post('{broken');
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /^Invalid token request:/);
  assert.equal((await post('{"label":""}')).status, 400);
  const large = await post(' '.repeat(MAX_JOB_BODY + 1));
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: 'Token request is too large' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tokens').get()!.n, before);
});

test('links list no channels and mint no code when no linkable module is running', async t => {
  const store = storeFor(t);
  const person = store.createPerson({ name: 'Ada' });
  const headers = { ...json, authorization: `Bearer ${store.mintToken(person.id, 'laptop').secret}` };
  const app = new Hono<AppEnv>();
  app.use('*', resolvePerson(store));
  registerLinks(app, { store });
  assert.deepEqual(await (await app.request('/links', { headers })).json(), { channels: [] });
  for (const body of ['null', '{"channel":7}', '{}', '{broken', '{"channel":"discord"}']) {
    const response = await app.request('/links', { method: 'POST', headers, body });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /No channel module/);
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM link_codes').get()!.n, 0);
});

test('linking without a custom hint supplies the default instruction and refuses a second binding', async t => {
  const store = storeFor(t);
  const person = store.createPerson({ name: 'Ada' });
  const headers = { ...json, authorization: `Bearer ${store.mintToken(person.id, 'laptop').secret}` };
  const app = new Hono<AppEnv>();
  app.use('*', resolvePerson(store));
  registerLinks(app, { store, linkable: () => [{ id: 'discord' }] });
  assert.deepEqual(await (await app.request('/links', { headers })).json(), {
    channels: [{ channel: 'discord', linked: false }],
  });
  const response = await app.request('/links', { method: 'POST', headers, body: '{"channel":"discord"}' });
  assert.equal(response.status, 200);
  const minted = await response.json();
  assert.match(minted.code, /^\d{5}$/);
  assert.equal(minted.person, 'Ada');
  assert.equal(minted.next, `Paste \`/link ${minted.code}\` in the discord channel the bot reads.`);
  assert.equal(store.redeemLinkCode(minted.code, 'discord', 'account').reason, 'bound');
  const duplicate = await app.request('/links', { method: 'POST', headers, body: '{"channel":"discord"}' });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'Already linked in the discord channel.' });
});

test('status shows only the next three active occurrences and labels invocation jobs by operation name', t => {
  const store = storeFor(t);
  const now = Date.parse('2026-09-15T07:00:00Z');
  for (let i = 1; i <= 4; i++)
    store.addJob(
      jobSchema.parse({ id: `next-${i}`, at: new Date(now + i * 1000).toISOString(), task: 'system.check' }),
      'operator',
      now,
    );
  store.addJob(
    jobSchema.parse({ id: 'paused', at: new Date(now + 500).toISOString(), task: 'system.check', enabled: false }),
    'operator',
    now,
  );
  const run = store.enqueue(taskSchema.parse({ kind: 'shell', command: ['true'] }), 'default', 'completed', now);
  store.claimRun(run.id, 'host', now);
  store.finish(run.id, 'host', 'succeeded', null, 'done', now + 10);
  const modules = [{ id: 'voice', state: 'running' as const, attempts: 1, lastError: null, nextRetryAt: null }];
  const view = status(store, loaded, now + 100, modules, () => 2);
  assert.deepEqual(
    view.upcoming,
    [1, 2, 3].map(i => ({
      id: `next-${i}`,
      source: 'operator',
      kind: 'system.check',
      title: null,
      nextAt: new Date(now + i * 1000).toISOString(),
    })),
  );
  assert.deepEqual(view.recent, [
    {
      id: run.id,
      jobId: run.jobId,
      kind: 'shell',
      state: 'succeeded',
      finishedAt: new Date(now + 10).toISOString(),
      error: null,
    },
  ]);
  assert.equal(view.leases, 2);
  assert.deepEqual(view.modules, modules);
});
