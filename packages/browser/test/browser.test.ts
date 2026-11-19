import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConfigSchema, browserRequestSchema } from '../src/config.ts';
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
  const binary = browserConfigSchema.parse({
    connection: { mode: 'launch', userDataDir: '/aivi/chrome', executablePath: '/opt/chrome/chrome' },
  });
  assert.ok(chromeArguments(binary).includes('--executablePath=/opt/chrome/chrome'));
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

test('a launched profile is branded once and never overrides a colour the person chose', async t => {
  const { mkdtemp, readFile, rm, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { brandProfile } = await import('../src/transport.ts');
  const root = await mkdtemp(join(tmpdir(), 'aivi-brand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const read = async (dir: string) => JSON.parse(await readFile(join(dir, 'Default', 'Preferences'), 'utf8'));

  const fresh = join(root, 'fresh');
  await brandProfile(fresh);
  const seeded = await read(fresh);
  assert.equal(seeded.profile.name, 'aivi');
  assert.equal(seeded.browser.theme.user_color, 0xffffb300 - 0x100000000);
  assert.equal(seeded.browser.theme.follows_system_colors, false);

  const custom = join(root, 'custom');
  await mkdir(join(custom, 'Default'), { recursive: true });
  await writeFile(
    join(custom, 'Default', 'Preferences'),
    JSON.stringify({ browser: { theme: { user_color: 42 } }, profile: { name: 'mine' }, other: true }),
  );
  await brandProfile(custom);
  assert.deepEqual(await read(custom), {
    browser: { theme: { user_color: 42 } },
    profile: { name: 'mine' },
    other: true,
  });

  const partial = join(root, 'partial');
  await mkdir(join(partial, 'Default'), { recursive: true });
  await writeFile(join(partial, 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'kept' } }));
  await brandProfile(partial);
  const merged = await read(partial);
  assert.equal(merged.profile.name, 'kept');
  assert.equal(merged.browser.theme.color_variant, 3, 'missing theme values are filled in');
});

/** The human's own tab: what every page list shows before the service has opened anything. */
const human = { id: 1, url: 'https://human.invalid/private', title: 'Human tab', selected: false };
const blank = (id: number, over: Partial<typeof human> = {}) => ({
  id,
  url: 'about:blank',
  title: 'Blank',
  selected: true,
  ...over,
});
/** A transport that lists the human's tab, and answers a new_page with `answer`. */
const opening = (answer: object): BrowserTransport => ({
  call: async name => (name === 'new_page' ? answer : { structuredContent: { pages: [human] } }),
  close: async () => {},
});
const showing = (pages: unknown) => opening({ structuredContent: { pages } });

test('each page action asks Chrome for what it means, on the tab the session owns', async () => {
  const fake = fixture();
  const service = createBrowserService(config(), fake.transport);
  const tab = (await service.execute('s', { action: 'open', url: 'https://a.invalid' })).tab!;
  const pageId = 2;
  for (const [request, asked] of [
    [
      { action: 'navigate', url: 'https://b.invalid' },
      { name: 'navigate_page', args: { pageId, type: 'url', url: 'https://b.invalid', timeout: 30000 } },
    ],
    [
      { action: 'fill', uid: '1_2', value: 'hello' },
      { name: 'fill', args: { pageId, uid: '1_2', value: 'hello' } },
    ],
    [
      { action: 'press', key: 'Enter' },
      { name: 'press_key', args: { pageId, key: 'Enter' } },
    ],
    [{ action: 'focus' }, { name: 'select_page', args: { pageId, bringToFront: true } }],
    [
      { action: 'dialog', response: 'accept' },
      { name: 'handle_dialog', args: { pageId, action: 'accept' } },
    ],
  ] as const) {
    const done = await service.execute('s', { ...request, tabId: tab.tabId });

    assert.deepEqual(done, { completed: true }, request.action);
    assert.deepEqual(fake.calls.at(-1), asked, request.action);
  }
});

test('a page list that is no list of pages is an invalid answer, not something to work with', async () => {
  for (const pages of [
    'nope',
    [null],
    [{ ...human, id: 1.5 }],
    [{ ...human, url: 5 }],
    [{ ...human, title: 5 }],
    [{ ...human, selected: 'yes' }],
  ]) {
    const service = createBrowserService(config(), {
      call: async () => ({ structuredContent: { pages } }),
      close: async () => {},
    });

    await assert.rejects(service.execute('s', { action: 'tabs' }), /Invalid Chrome MCP page response/);
  }
});

test('an answer that lists no pages means there are none', async () => {
  const service = createBrowserService(config(), { call: async () => ({}), close: async () => {} });

  assert.deepEqual(await service.execute('s', { action: 'tabs' }), { tabs: [] });
});

test('a new_page that fails or answers wrongly leaves the connection uncertain, for that call and every later one', async () => {
  for (const [why, transport] of [
    ['Chrome reports an error', opening({ isError: true })],
    ['the answer is no page list', showing('nope')],
    ['no page was added', showing([human])],
    ['the added page is not blank', showing([human, blank(2, { url: 'https://x.invalid' })])],
    ['the added page is not selected', showing([human, blank(2, { selected: false })])],
    ['two pages were added and selected', showing([human, blank(2), blank(3)])],
  ] as const) {
    const service = createBrowserService(config(), transport);

    await assert.rejects(service.execute('s', { action: 'open', url: 'https://a.invalid' }), /uncertain/, why);
    await assert.rejects(service.execute('s', { action: 'tabs' }), /uncertain/, `${why}: later calls too`);
  }
});

test('a page that is gone when it is listed after opening is no longer open, and is forgotten by the next call', async () => {
  const fake = fixture();
  const original = fake.transport.call;
  fake.transport.call = async (name, args) => {
    const reply = await original(name, args);
    if (name === 'navigate_page') fake.all.pop();
    return reply;
  };
  const service = createBrowserService(config(), fake.transport);

  await assert.rejects(service.execute('s', { action: 'open', url: 'https://a.invalid' }), /Tab is no longer open/);

  assert.deepEqual(await service.execute('s', { action: 'tabs' }), { tabs: [] });
});

test('a snapshot that comes back empty is an error, and what Chrome said about a failed action is the first line, cut short', async () => {
  const fake = fixture();
  const original = fake.transport.call;
  const service = createBrowserService(config(), fake.transport);
  const tab = (await service.execute('s', { action: 'open', url: 'https://a.invalid' })).tab!;
  fake.transport.call = async (name, args) =>
    name === 'take_snapshot' ? { structuredContent: { pages: [] } } : original(name, args);
  await assert.rejects(service.execute('s', { action: 'snapshot', tabId: tab.tabId }), /returned no snapshot/);

  for (const [content, said] of [
    [
      [{ type: 'text', text: '\n  \nTimeout waiting for navigation\nat page.goto' }],
      ': Timeout waiting for navigation',
    ],
    [[{ type: 'text', text: 'x'.repeat(300) }], `: ${'x'.repeat(200)}`],
    [[{ type: 'image' }], ''],
    [undefined, ''],
  ] as const) {
    fake.transport.call = async () => ({ isError: true, ...(content ? { content: [...content] } : {}) });

    await assert.rejects(
      service.execute('s', { action: 'tabs' }),
      error => (error as Error).message === `Browser action failed${said}; inspect the tab before retrying`,
    );
  }
});
