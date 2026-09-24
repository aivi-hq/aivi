import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema } from '@aivi/core';
import { createHostClient } from '../src/client.ts';
import { ConfigurationError } from '../src/modules.ts';
import { createHostServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { ToolError, ToolRegistry } from '../src/tools.ts';

const loaded: LoadedConfig = {
  path: '/config.json',
  config: configSchema.parse({ version: 1 }),
  projects: [],
  sources: [{ id: 'company', path: '/company', kind: 'doc', scope: 'core' }],
};

const descriptor = { namespace: 'aivi' as const, name: 'ping', description: 'Say pong.', input: {} };

test('the tool registry claims each id exactly once; the same owner replacing is fine', () => {
  const registry = new ToolRegistry();
  registry.claim('host', descriptor, async () => 'pong');
  assert.throws(
    () => registry.claim('browser', descriptor, async () => 'other'),
    ConfigurationError,
    'a second owner must not silently lose its tool',
  );
  registry.claim('host', { ...descriptor, description: 'Say pong again.' }, async () => 'pong2');
  assert.equal(registry.list()[0]!.description, 'Say pong again.', 'the re-claim replaced');
  registry.release('host', 'aivi_ping');
  assert.equal(registry.get('aivi_ping'), undefined);
});

test('a module door bakes its own id in: it cannot claim or release under another owner', () => {
  const registry = new ToolRegistry();
  const door = registry.forModule('browser');
  door.claim(descriptor, async () => 'tab');
  assert.equal(registry.claimed()[0]!.owner, 'browser');
  door.release('aivi_ping');
  assert.equal(registry.get('aivi_ping'), undefined);
  registry.claim('host', descriptor, async () => 'pong');
  door.release('aivi_ping');
  assert.ok(registry.get('aivi_ping'), 'a module cannot release the host claim');
});

test('GET /v1/tools serves the host tools id-sorted, and a module claim lands beside them', async t => {
  const store = new Store(':memory:');
  const seen: { sessionId: string; action: string }[] = [];
  const registry = new ToolRegistry();
  const server = createHostServer({ store, loaded, tools: registry });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = createHostClient(`http://127.0.0.1:${address.port}`);

  // The host's own always-present tools; no context or jobs without those options.
  assert.deepEqual(
    (await client.listTools()).map(tool => tool.id),
    ['aivi_sources', 'aivi_status', 'knowledge_projects'],
  );

  // A module claims its tool at its own door — as the browser module claims
  // `aivi_browser` — and it sorts into the same list keeping its 300 s budget.
  registry
    .forModule('browser')
    .claim(
      { namespace: 'aivi', name: 'browse', description: 'Drive Chrome.', input: {}, timeoutMs: 300_000 },
      async call => {
        seen.push({ sessionId: call.sessionId, action: String((call.input as { action?: string }).action) });
        return { tabs: [] };
      },
    );
  const served = await client.listTools();
  assert.deepEqual(
    served.map(tool => tool.id),
    ['aivi_browse', 'aivi_sources', 'aivi_status', 'knowledge_projects'],
    'a module tool sorts in beside the host tools',
  );
  assert.equal(served.find(tool => tool.id === 'aivi_browse')!.timeoutMs, 300_000, 'its own budget survives');

  // A second module claim shows up live too: the plugin reads whatever is offered now.
  registry
    .forModule('dreaming')
    .claim({ namespace: 'knowledge', name: 'dream', description: 'Dream.', input: {} }, async () => 42);
  assert.deepEqual(
    (await client.listTools()).map(tool => tool.id),
    ['aivi_browse', 'aivi_sources', 'aivi_status', 'knowledge_dream', 'knowledge_projects'],
  );

  const status = (await client.callTool('aivi_status', { sessionId: 'ses_one', input: {} })) as { sources: number };
  assert.equal(status.sources, 1);

  // The envelope session is the owner: it reaches the handler untouched by the input.
  await client.callTool('aivi_browse', { sessionId: 'ses_owner', input: { action: 'tabs' } });
  assert.deepEqual(seen, [{ sessionId: 'ses_owner', action: 'tabs' }]);
});

test('POST /v1/tools answers for every claimed name and fails loudly for every one that is not', async t => {
  const store = new Store(':memory:');
  const registry = new ToolRegistry();
  registry
    .forModule('browser')
    .claim({ namespace: 'aivi', name: 'flaky', description: 'Refuse.', input: {} }, async () => {
      throw new ToolError(409, 'Inspect the owned tabs before retrying.');
    });
  registry
    .forModule('browser')
    .claim({ namespace: 'aivi', name: 'broken', description: 'Crash.', input: {} }, async () => {
      throw new Error('bug');
    });
  const server = createHostServer({ store, loaded, tools: registry });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown) =>
    fetch(`${base}/v1/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const refused = await post({ tool: 'aivi_flaky', sessionId: 'ses_one', input: {} });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Inspect the owned tabs/);

  const crashed = await post({ tool: 'aivi_broken', sessionId: 'ses_one', input: {} });
  assert.equal(crashed.status, 500);
  assert.match((await crashed.json()).error, /check its log/);

  const missing = await post({ tool: 'aivi_absent', sessionId: 'ses_one', input: {} });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /aivi_absent/, 'an unclaimed name fails with the name in the reason');

  assert.equal(
    (await post({ tool: 'aivi_status', sessionId: '', input: {} })).status,
    400,
    'the envelope is validated',
  );
  assert.equal((await fetch(`${base}/v1/tools`, { method: 'PUT' })).status, 405);
});

test('a host without a tool registry serves an empty list, not a failure', async t => {
  const store = new Store(':memory:');
  const server = createHostServer({ store, loaded });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = createHostClient(`http://127.0.0.1:${address.port}`);
  assert.deepEqual(await client.listTools(), []);
  await assert.rejects(
    client.callTool('aivi_status', { sessionId: 'ses_one', input: {} }),
    /aivi_status/,
    'a call of an unoffered name fails with the name in the reason',
  );
});
