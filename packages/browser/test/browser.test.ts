import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConfigSchema, browserRequestSchema } from '@aivi/core';
import type { BrowserTransport, McpReply } from '../src/index.ts';
import { chromeArguments, createBrowserService } from '../src/index.ts';
import { createChromeTransport } from '../src/transport.ts';

const config = () => browserConfigSchema.parse({ connection: { mode: 'existing', userDataDir: '/aivi/chrome' } });
function fixture() {
  let next = 1;
  let closed = 0;
  const all = [{ id: next++, url: 'https://human.invalid/private', title: 'Human tab', selected: true }];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const transport: BrowserTransport = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'new_page') {
        for (const p of all) p.selected = false;
        all.push({ id: next++, url: String(args.url), title: 'Blank', selected: true });
      }
      const page = all.find(p => p.id === args.pageId);
      if (name === 'navigate_page') {
        assert.ok(page);
        page.url = String(args.url);
        page.title = 'Owned page';
      }
      if (name === 'close_page') {
        assert.ok(page);
        all.splice(all.indexOf(page), 1);
      }
      if (name === 'take_snapshot')
        return {
          structuredContent: {
            snapshot: { id: '1_0', role: 'RootWebArea', name: page!.title },
            pages: structuredClone(all),
          },
        };
      return { structuredContent: { pages: structuredClone(all) } };
    },
    async close() {
      closed++;
    },
  };
  return { transport, calls, all, closed: () => closed };
}

test('two sessions own separate opaque tabs; page lists and snapshots do not leak other tabs', async () => {
  const fake = fixture();
  const service = createBrowserService(config(), fake.transport);
  const a = (await service.execute('session-a', { action: 'open', url: 'https://a.invalid' })).tab!;
  const b = (await service.execute('session-b', { action: 'open', url: 'https://b.invalid' })).tab!;
  assert.deepEqual((await service.execute('session-a', { action: 'tabs' })).tabs, [a]);
  await assert.rejects(service.execute('session-b', { action: 'click', tabId: a.tabId, uid: '1_0' }), /not owned/);
  await service.execute('session-a', { action: 'click', tabId: a.tabId, uid: '1_0' });
  assert.deepEqual(fake.calls.find(c => c.name === 'click')!.args, { pageId: 2, uid: '1_0' });
  assert.deepEqual(await service.execute('session-a', { action: 'snapshot', tabId: a.tabId }), {
    snapshot: { id: '1_0', role: 'RootWebArea', name: 'Owned page' },
  });
  await service.execute('session-a', { action: 'close', tabId: a.tabId });
  assert.deepEqual((await service.execute('session-b', { action: 'tabs' })).tabs, [b]);
  assert.ok(fake.all.some(p => p.title === 'Human tab'));
  await service.close();
  assert.equal(fake.closed(), 1);
});

test('tab limits are atomic under simultaneous opens; shutdown drains and rejects new work', async () => {
  const fake = fixture();
  const cfg = config();
  cfg.maxTabsPerSession = 1;
  const service = createBrowserService(cfg, fake.transport);
  const first = service.execute('s', { action: 'open', url: 'https://a.invalid' });
  const second = service.execute('s', { action: 'open', url: 'https://b.invalid' });
  await first;
  await assert.rejects(second, /limit/);
  const closing = service.close();
  await assert.rejects(service.execute('s', { action: 'tabs' }), /closing/);
  await closing;
  await service.close();
  assert.equal(fake.closed(), 1);
});

test('navigation failure preserves ownership; uncertain transport failures block later calls without retry', async () => {
  const fake = fixture();
  const original = fake.transport.call;
  fake.transport.call = async (name, args) => (name === 'navigate_page' ? { isError: true } : original(name, args));
  const service = createBrowserService(config(), fake.transport);
  await assert.rejects(service.execute('s', { action: 'open', url: 'https://a.invalid' }), /action failed/);
  assert.equal((await service.execute('s', { action: 'tabs' })).tabs!.length, 1);
  fake.transport.call = async () => {
    throw new Error('connection lost');
  };
  await assert.rejects(service.execute('s', { action: 'tabs' }), /uncertain/);
  fake.transport.call = original;
  const before = fake.calls.length;
  await assert.rejects(service.execute('s', { action: 'tabs' }), /uncertain/);
  assert.equal(fake.calls.length, before);
  await service.close();
});

test('reconnect notices block stale ownership rather than adopting new page IDs', async () => {
  const transport: BrowserTransport = {
    async call() {
      return { structuredContent: { reconnected: true } };
    },
    async close() {},
  };
  const service = createBrowserService(config(), transport);
  await assert.rejects(service.execute('s', { action: 'tabs' }), /uncertain/);
  await service.close();
});

test('bounded queue rejects overflow while preserving accepted operations', async () => {
  let release!: (value: McpReply) => void;
  const cfg = config();
  cfg.maxPending = 1;
  const service = createBrowserService(cfg, {
    call: () =>
      new Promise(resolve => {
        release = resolve;
      }),
    async close() {},
  });
  const first = service.execute('s', { action: 'tabs' });
  await assert.rejects(service.execute('s', { action: 'tabs' }), /queue is full/);
  release({ structuredContent: { pages: [] } });
  await first;
  await service.close();
});

test('configuration preserves profiles, limits attachment to loopback, and rejects arbitrary code/file operations', () => {
  assert.deepEqual(chromeArguments(config()), [
    '--no-usage-statistics',
    '--no-performance-crux',
    '--pageIdRouting=true',
    '--experimentalStructuredContent=true',
    '--userDataDir=/aivi/chrome',
    '--autoConnect',
  ]);
  const launch = browserConfigSchema.parse({ connection: { mode: 'launch', userDataDir: '/aivi/chrome' } });
  assert.ok(chromeArguments(launch).includes('--headless=false'));
  assert.ok(!chromeArguments(launch).includes('--isolated'));
  assert.throws(() =>
    browserConfigSchema.parse({ connection: { mode: 'attach', browserUrl: 'http://outside.invalid:9222' } }),
  );
  assert.throws(() => browserRequestSchema.parse({ action: 'open', url: 'file:///private' }));
  assert.throws(() =>
    browserRequestSchema.parse({ action: 'open', url: 'https://a.invalid', sessionId: 'someone-else' }),
  );
  assert.throws(() => browserRequestSchema.parse({ action: 'evaluate_script', function: '() => 1' }));
});

test('real pinned MCP starts over stdio and advertises explicit page routing without launching Chrome', async () => {
  // Initialize and list tools through the same production handshake; list_pages
  // then fails because this intentionally unoccupied attachment port has no Chrome.
  const cfg = browserConfigSchema.parse({
    connection: { mode: 'attach', browserUrl: 'http://127.0.0.1:1' },
    timeoutMs: 10000,
  });
  const transport = createChromeTransport(cfg);
  try {
    const result = await transport.call('list_pages', {});
    assert.equal(result.isError, true);
  } finally {
    await transport.close();
  }
});

test('refused close retains ownership and unknown popup tabs are never silently claimed', async () => {
  const fake = fixture();
  const original = fake.transport.call;
  const service = createBrowserService(config(), fake.transport);
  const tab = (await service.execute('s', { action: 'open', url: 'https://a.invalid' })).tab!;
  fake.all.push({ id: 999, url: 'https://popup.invalid', title: 'Popup', selected: false });
  fake.transport.call = async (name, args) => original(name === 'close_page' ? 'list_pages' : name, args);
  await assert.rejects(service.execute('s', { action: 'close', tabId: tab.tabId }), /ownership retained/);
  assert.deepEqual((await service.execute('s', { action: 'tabs' })).tabs, [tab]);
  await service.close();
});
