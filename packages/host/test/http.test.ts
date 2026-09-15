import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema } from '@aivi/core';
import { createHostClient } from '../src/client.ts';
import { JobRefused } from '../src/jobs.ts';
import { createHostServer } from '../src/server.ts';
import { Store } from '../src/store.ts';

test('read API authenticates callers, scopes sources, and refuses job operations without a handler', async t => {
  const store = new Store(':memory:');
  const loaded: LoadedConfig = {
    path: '/aivi.json',
    config: configSchema.parse({ version: 1 }),
    projects: [{ id: 'app', directory: '/app', settings: { knowledge: [] } }],
    sources: [
      { id: 'company', path: '/company', kind: 'doc', scope: 'core' },
      { id: 'adrs', path: '/app/docs', kind: 'decision', scope: 'project', projectId: 'app' },
    ],
  };
  const token = 'test-only-token-never-for-deployment';
  const searches: unknown[] = [];
  const server = createHostServer({
    store,
    loaded,
    auth: { mode: 'token', token },
    knowledge: {
      async search(request) {
        searches.push(request);
        return [];
      },
      async index() {},
      async close() {},
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = createHostClient(base, { token });
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200, 'liveness is public');
  assert.equal((await client.status()).sources, 2);
  assert.equal((await client.sources({ projects: [] })).length, 1);
  assert.equal((await client.sources({ projects: ['app'], includeCore: false }))[0]!.projectId, 'app');
  assert.deepEqual(
    (await client.sources({ kinds: ['decision'] })).map(s => s.id),
    ['adrs'],
    'kind filter',
  );
  assert.equal(
    (await fetch(`${base}/v1/sources?kind=gossip`, { headers: { authorization: `Bearer ${token}` } })).status,
    400,
  );
  await assert.rejects(client.sources({ projects: ['typo'] }), /HTTP 400: Unknown project: typo/);
  assert.equal(
    (await fetch(`${base}/v1/jobs`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status,
    503,
  );
  assert.equal(
    (await fetch(`${base}/v1/sources?includeCore=no`, { headers: { authorization: `Bearer ${token}` } })).status,
    400,
  );
  assert.deepEqual(
    await client.search({ query: 'deployment', projects: [], includeCore: false, limit: 3, kinds: ['memory'] }),
    [],
  );
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
  const server = createHostServer({
    store,
    loaded,
    auth: { mode: 'token', token },
    browser: {
      async execute(session, request) {
        calls.push({ session, request });
        return { tabs: [] };
      },
      async close() {},
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/browser`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/v1/browser`, { headers })).status, 405);
  assert.equal(
    (
      await fetch(`${base}/v1/browser`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 's', request: { action: 'evaluate_script' } }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/v1/browser`, { method: 'POST', headers, body: JSON.stringify({ large: 'x'.repeat(40000) }) }))
      .status,
    413,
  );
  assert.deepEqual(await createHostClient(base, { token }).browser('native-session', { action: 'tabs' }), { tabs: [] });
  assert.deepEqual(calls, [{ session: 'native-session', request: { action: 'tabs' } }]);
});

test('auth mode none serves authenticated routes without a token and resolveHostAuth fails fast', async t => {
  const { resolveHostAuth } = await import('../src/server.ts');
  assert.throws(() => resolveHostAuth('token', undefined), /AIVI_TOKEN is required/);
  assert.throws(() => resolveHostAuth('token', 'short'), /at least 24/);
  assert.deepEqual(resolveHostAuth('none', undefined), { mode: 'none' });
  const store = new Store(':memory:');
  const loaded = {
    path: '/config',
    config: configSchema.parse({ version: 1, host: { auth: { mode: 'none' } } }),
    sources: [],
    projects: [],
  };
  const server = createHostServer({ store, loaded, auth: { mode: 'none' } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = createHostClient(`http://127.0.0.1:${address.port}`);
  assert.equal((await client.status()).sources, 0);
});

test('jobs API validates the body, maps refusals to their status, and status lists upcoming and recent work', async t => {
  const store = new Store(':memory:');
  const loaded: LoadedConfig = {
    path: '/aivi.json',
    config: configSchema.parse({
      version: 1,
      jobs: [{ id: 'nightly', title: 'Nightly check', cron: '0 3 * * *', task: { kind: 'system.check' } }],
    }),
    projects: [],
    sources: [],
  };
  store.syncJobs(loaded.config.jobs, [], Date.now());
  const done = store.enqueue({ kind: 'system.check' }, 'local-model', 'done');
  const claimed = store.claim('host', 1, { 'local-model': 1 })!;
  store.finish(claimed.id, 'host', 'failed', null, 'boom');
  const token = 'test-only-token-never-for-deployment';
  const requests: unknown[] = [];
  const server = createHostServer({
    store,
    loaded,
    auth: { mode: 'token', token },
    jobs: async request => {
      requests.push(request);
      if (request.action === 'run') throw new JobRefused('Jobs do not create jobs', 403);
      if (request.action === 'remove') throw new Error('sqlite exploded');
      return { summary: `ok ${request.action}`, items: [] };
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = createHostClient(base, { token });
  const status = await client.status();
  assert.deepEqual(
    status.upcoming.map(u => [u.id, u.source, u.kind, u.title]),
    [['nightly', 'config', 'system.check', 'Nightly check']],
  );
  assert.deepEqual(
    status.recent.map(r => [r.id, r.jobId, r.state, r.error]),
    [[done.id, done.jobId, 'failed', 'boom']],
  );

  assert.equal((await fetch(`${base}/v1/jobs`, { method: 'POST' })).status, 401);
  const post = (body: unknown, type = 'application/json') =>
    fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  assert.equal((await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
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
