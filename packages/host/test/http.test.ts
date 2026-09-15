import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '@aivi/core';
import type { LoadedConfig } from '@aivi/core';
import { Store } from '../src/store.ts';
import { createHostServer } from '../src/server.ts';
import { createHostClient } from '../src/client.ts';

test('read API authenticates callers, scopes sources, and exposes no job submission route', async t => {
  const store = new Store(':memory:');
  const loaded: LoadedConfig = {
    path: '/aivi.json', config: configSchema.parse({ version: 1 }),
    projects: [{ id: 'app', directory: '/app', settings: { knowledge: [] } }],
    sources: [
      { id: 'company', path: '/company', kind: 'doc', scope: 'core' },
      { id: 'adrs', path: '/app/docs', kind: 'decision', scope: 'project', projectId: 'app' },
    ],
  };
  const token = 'test-only-token-never-for-deployment';
  const searches: unknown[] = [];
  const server = createHostServer({ store, loaded, auth: { mode: 'token', token }, knowledge: {
    async search(request) { searches.push(request); return []; }, async index() {}, async close() {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = createHostClient(base, { token });
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200, 'liveness is public');
  assert.equal((await client.status()).sources, 2);
  assert.equal((await client.sources({ projects: [] })).length, 1);
  assert.equal((await client.sources({ projects: ['app'], includeCore: false }))[0]!.projectId, 'app');
  assert.deepEqual((await client.sources({ kinds: ['decision'] })).map(s => s.id), ['adrs'], 'kind filter');
  assert.equal((await fetch(`${base}/v1/sources?kind=gossip`, { headers: { authorization: `Bearer ${token}` } })).status, 400);
  await assert.rejects(client.sources({ projects: ['typo'] }), /HTTP 400: Unknown project: typo/);
  assert.equal((await fetch(`${base}/v1/jobs`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 405);
  assert.equal((await fetch(`${base}/v1/sources?includeCore=no`, { headers: { authorization: `Bearer ${token}` } })).status, 400);
  assert.deepEqual(await client.search({ query: 'deployment', projects: [], includeCore: false, limit: 3, kinds: ['memory'] }), []);
  assert.deepEqual(searches, [{ query: 'deployment', projects: [], includeCore: false, limit: 3, kinds: ['memory'] }]);
  await assert.rejects(client.search({ query: 'deployment', projects: ['typo'] }), /HTTP 400: Unknown project/);
  assert.equal(searches.length, 1);
  assert.equal((await fetch(`${base}/v1/knowledge/search?q=deployment`)).status, 401);
});

test('browser API requires authenticated bounded JSON and uses the shared browser service', async t => {
  const store = new Store(':memory:');
  const loaded = { path: '/config', config: configSchema.parse({ version: 1 }), sources: [], projects: [] };
  const token = 'browser-api-test-token-never-for-deployment';
  const calls: unknown[] = [];
  const server = createHostServer({ store, loaded, auth: { mode: 'token', token }, browser: {
    async execute(session, request) { calls.push({ session, request }); return { tabs: [] }; }, async close() {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/browser`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/v1/browser`, { headers })).status, 405);
  assert.equal((await fetch(`${base}/v1/browser`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's', request: { action: 'evaluate_script' } }) })).status, 400);
  assert.equal((await fetch(`${base}/v1/browser`, { method: 'POST', headers, body: JSON.stringify({ large: 'x'.repeat(40000) }) })).status, 413);
  assert.deepEqual(await createHostClient(base, { token }).browser('native-session', { action: 'tabs' }), { tabs: [] });
  assert.deepEqual(calls, [{ session: 'native-session', request: { action: 'tabs' } }]);
});

test('auth mode none serves authenticated routes without a token and resolveHostAuth fails fast', async t => {
  const { resolveHostAuth } = await import('../src/server.ts');
  assert.throws(() => resolveHostAuth('token', undefined), /AIVI_TOKEN is required/);
  assert.throws(() => resolveHostAuth('token', 'short'), /at least 24/);
  assert.deepEqual(resolveHostAuth('none', undefined), { mode: 'none' });
  const store = new Store(':memory:');
  const loaded = { path: '/config', config: configSchema.parse({ version: 1, host: { auth: { mode: 'none' } } }), sources: [], projects: [] };
  const server = createHostServer({ store, loaded, auth: { mode: 'none' } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = createHostClient(`http://127.0.0.1:${address.port}`);
  assert.equal((await client.status()).sources, 0);
});
