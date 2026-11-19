import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { LoadedConfig, Logger } from '@aivi/core';
import { configSchema, getLogger } from '@aivi/core';
import { createApp, serveApp } from '../src/api/app.ts';
import { MAX_DIARY_BODY } from '../src/api/diary.ts';
import { PublicRoutes } from '../src/api/public.ts';
import { Store } from '../src/store.ts';
import { hostVersion } from '../src/version.ts';

/** The header the version gate asks of every request that is not `/health`, `/version` or a webhook. */
const api = { 'x-aivi-client': hostVersion };

/** A real listening app over a fresh store; `routes` mounts public webhooks. */
async function harness(t: TestContext, routes?: PublicRoutes) {
  const store = new Store(':memory:');
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  const server = serveApp(createApp({ store, loaded, ...(routes ? { routes } : {}) }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { store, base: `http://127.0.0.1:${address.port}` };
}

test('every arrival is journaled: an unknown path keeps its body and its answer', async t => {
  const { store, base } = await harness(t);
  assert.equal((await fetch(`${base}/nowhere`, { headers: api })).status, 404);
  assert.equal(
    (await fetch(`${base}/nowhere`, { method: 'POST', body: '{"hello":"world"}', headers: api })).status,
    405,
  );
  const rows = store.requests();
  assert.deepEqual(
    rows.map(r => [r.method, r.path, r.status]),
    [
      ['GET', '/nowhere', 404],
      ['POST', '/nowhere', 405],
    ],
    'one row per arrival, in arrival order',
  );
  assert.equal(rows[1]!.body, '{"hello":"world"}');
  assert.equal(rows[1]!.truncated, false);
  assert.ok('content-type' in rows[1]!.headers, 'the headers that arrived are recorded');
});

test('a credential header is journaled as present, never as its value', async t => {
  const { store, base } = await harness(t);
  assert.equal(
    (await fetch(`${base}/health`, { headers: { authorization: 'Bearer super-secret-token' } })).status,
    200,
  );
  const row = store.requests()[0]!;
  assert.equal(row.status, 200, 'liveness answers the way it always did');
  assert.equal(row.headers.authorization, '[present]');
  assert.ok(!JSON.stringify(store.requests()).includes('super-secret-token'), 'the value is nowhere in the diary');
});

test('a body past the cap is stored capped and says so', async t => {
  const { store, base } = await harness(t);
  const flood = 'x'.repeat(MAX_DIARY_BODY + 4096);
  assert.equal((await fetch(`${base}/nowhere`, { method: 'POST', body: flood, headers: api })).status, 405);
  const row = store.requests()[0]!;
  assert.equal(row.truncated, true);
  assert.equal(Buffer.byteLength(row.body ?? ''), MAX_DIARY_BODY, 'the first bytes of the flood, no more');
});

test('the diary does not starve webhooks: the public route signs over the full bytes', async t => {
  const routes = new PublicRoutes();
  routes.register('/hook', async request => ({ status: 200, body: { bytes: request.body.length } }));
  const { store, base } = await harness(t, routes);
  const payload = 'p'.repeat(MAX_DIARY_BODY + 2048);
  const answered = await fetch(`${base}/hook`, { method: 'POST', body: payload });
  assert.deepEqual(await answered.json(), { bytes: payload.length }, 'the signature leg got every byte');
  const row = store.requests()[0]!;
  assert.equal(row.status, 200);
  assert.equal(row.truncated, true, 'the diary kept its own cap');
});

/** The real chain with no socket: the diary is the unit, `Request`s go straight in. */
function appOver(store: Store, log: Logger) {
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1 }),
    sources: [],
    projects: [],
  };
  return createApp({ store, loaded, log });
}

test('a diary row that cannot be written is logged and never costs the request', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const log = getLogger(['aivi', 'test', 'diary']);
  const warn = t.mock.method(log, 'warn');
  const failure = new Error('the disk is full');
  t.mock.method(store, 'logRequest', () => {
    throw failure;
  });
  const response = await appOver(store, log).request('/health');
  assert.equal(response.status, 200, 'the request is answered as if the diary were fine');
  assert.deepEqual(warn.mock.calls[0]!.arguments, ['api.diary.failed', { path: '/health', error: failure }]);
});

test('a request whose body was already read is journaled without a body and still answered', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const request = new Request('http://host.test/nowhere', { method: 'POST', body: 'spent', headers: api });
  await request.text();
  const response = await appOver(store, getLogger(['aivi', 'test', 'diary'])).request(request);
  assert.equal(response.status, 405, 'the chain went on as for any unknown path');
  const [row] = store.requests();
  assert.deepEqual([row!.path, row!.status, row!.body, row!.truncated], ['/nowhere', 405, null, false]);
});
