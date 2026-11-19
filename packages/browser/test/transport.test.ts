/** `createChromeTransport`: the one lazy MCP child, as the service sees it. What it reaches
 *  are the SDK's client and stdio transport, which are module mocks (they are classes: the
 *  transport builds them with `new`), registered before the transport is imported. A test
 *  checks what the transport asked of the SDK, with literal equality, and what it handed back.
 *  Starting the real Chrome MCP child is no unit's subject. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { type BrowserConfig, browserConfigSchema } from '../src/config.ts';

/** What the SDK answers, and what it was asked; the classes below forward to these. */
const sdk = {
  connect: mock.fn(async (_transport: object, _options: object) => {}),
  listTools: mock.fn(async (_params: object, _options: object): Promise<{ tools: object[] }> => ({ tools: [] })),
  callTool: mock.fn(async (_call: object, _schema: unknown, _options: object): Promise<object> => ({})),
  close: mock.fn(async () => {}),
  stderrOn: mock.fn((_event: string, _listener: () => void) => {}),
  transportClose: mock.fn(async () => {}),
};
const built = { transports: [] as { command: string; args: string[]; env: Record<string, string>; stderr: string }[] };
class StdioClientTransport {
  readonly stderr = { on: sdk.stderrOn };
  readonly close = sdk.transportClose;
  constructor(params: (typeof built.transports)[number]) {
    built.transports.push(params);
  }
}
class Client {
  readonly connect = sdk.connect;
  readonly listTools = sdk.listTools;
  readonly callTool = sdk.callTool;
  readonly close = sdk.close;
}
mock.module('@modelcontextprotocol/sdk/client/index.js', { exports: { Client } });
mock.module('@modelcontextprotocol/sdk/client/stdio.js', {
  exports: { getDefaultEnvironment: () => ({ PATH: '/usr/bin' }), StdioClientTransport },
});

const { chromeArguments, createChromeTransport } = await import('../src/transport.ts');

/** The tools a Chrome MCP offers when it routes by page, so the transport may trust it. */
const ROUTED = ['navigate_page', 'take_snapshot', 'click', 'fill', 'press_key', 'handle_dialog'].map(name => ({
  name,
  inputSchema: { required: ['pageId'] },
}));

const attach = browserConfigSchema.parse({ connection: { mode: 'attach', browserUrl: 'http://127.0.0.1:9222' } });

/** A clean SDK that answers as a healthy Chrome MCP does; each test changes what it must. */
function healthy(t: TestContext) {
  for (const fn of Object.values(sdk)) fn.mock.resetCalls();
  built.transports.length = 0;
  sdk.connect.mock.mockImplementation(async () => {});
  sdk.listTools.mock.mockImplementation(async () => ({ tools: ROUTED }));
  sdk.callTool.mock.mockImplementation(async () => ({ structuredContent: { pages: [] } }));
  sdk.close.mock.mockImplementation(async () => {});
  sdk.transportClose.mock.mockImplementation(async () => {});
  t.mock.property(process, 'env', { PATH: '/usr/bin', DISPLAY: ':99' });
}

test('the child starts on the first call, once, and the SDK’s answers are the transport’s answers', async t => {
  healthy(t);
  const transport = createChromeTransport(attach);
  assert.equal(built.transports.length, 0, 'composing it costs nothing');

  await transport.call('click', { pageId: 2, uid: '1_0' });
  const second = await transport.call('list_pages', {});

  assert.deepEqual(second, { structuredContent: { pages: [] } });
  const [child] = built.transports;
  assert.equal(built.transports.length, 1);
  assert.equal(child!.command, process.execPath);
  assert.match(child!.args[0]!, /chrome-devtools-mcp\.js$/);
  assert.deepEqual(child!.args.slice(1), chromeArguments(attach));
  assert.deepEqual(child!.env, {
    PATH: '/usr/bin',
    DISPLAY: ':99',
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
  });
  assert.equal(child!.stderr, 'pipe');
  const [event, consume] = sdk.stderrOn.mock.calls[0]!.arguments;
  assert.equal(event, 'data', 'its diagnostics are consumed, never copied into a log');
  assert.equal(consume(), undefined, 'a diagnostic is drained and dropped: nothing of the page is kept');
  assert.deepEqual(sdk.connect.mock.calls[0]!.arguments[1], { timeout: 30000 });
  assert.deepEqual(
    sdk.listTools.mock.calls.map(call => call.arguments),
    [[{}, { timeout: 30000 }]],
  );
  assert.deepEqual(
    sdk.callTool.mock.calls.map(call => call.arguments),
    [
      [{ name: 'click', arguments: { pageId: 2, uid: '1_0' } }, undefined, { timeout: 30000 }],
      [{ name: 'list_pages', arguments: {} }, undefined, { timeout: 30000 }],
    ],
  );
});

test('calls made while the child is still starting share its one start', async t => {
  healthy(t);
  const transport = createChromeTransport(attach);

  await Promise.all([transport.call('list_pages', {}), transport.call('list_pages', {})]);

  assert.equal(built.transports.length, 1);
  assert.equal(sdk.connect.mock.callCount(), 1);
  assert.equal(sdk.callTool.mock.callCount(), 2);
});

test('a launched Chrome has its profile branded before the child starts, and is handed its executable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  healthy(t);
  const launch: BrowserConfig = browserConfigSchema.parse({
    connection: { mode: 'launch', userDataDir: root, executablePath: '/opt/chrome/chrome' },
  });

  await createChromeTransport(launch).call('list_pages', {});

  const prefs = JSON.parse(await readFile(join(root, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.profile.name, 'aivi');
  assert.ok(built.transports[0]!.args.includes('--executablePath=/opt/chrome/chrome'));
});

test('a Chrome MCP that cannot start, or does not route by page, is refused and its half-started client closed', async t => {
  const refusal = new Error('spawn failed');
  const throwing = (fn: typeof sdk.connect | typeof sdk.listTools) => () =>
    fn.mock.mockImplementation(async () => {
      throw refusal;
    });
  const listing = (tools: object[]) => () => sdk.listTools.mock.mockImplementation(async () => ({ tools }));
  const unrouted = ROUTED.map(tool => (tool.name === 'click' ? { ...tool, inputSchema: { required: [] } } : tool));
  for (const [why, break_, said] of [
    ['the child will not connect', throwing(sdk.connect), 'spawn failed'],
    ['it cannot list its tools', throwing(sdk.listTools), 'spawn failed'],
    ['a tool is not routed by page', listing(unrouted), 'Chrome MCP lacks required page routing: click'],
    ['a tool is missing', listing([]), 'Chrome MCP lacks required page routing: navigate_page'],
  ] as const) {
    await t.test(why, async s => {
      healthy(s);
      break_();

      await assert.rejects(
        createChromeTransport(attach).call('list_pages', {}),
        error => (error as Error).message === said,
      );

      assert.equal(sdk.close.mock.callCount(), 1, 'the half-started client is closed');
      assert.equal(sdk.callTool.mock.callCount(), 0, 'nothing was asked of it');
    });
  }
});

test('closing ends a started child; one never started has nothing to end; either refuses calls afterwards', async t => {
  healthy(t);
  const started = createChromeTransport(attach);
  await started.call('list_pages', {});

  await started.close();

  assert.equal(sdk.close.mock.callCount(), 1, 'the client is closed');
  assert.equal(sdk.transportClose.mock.callCount(), 1, 'and so is its child');
  await assert.rejects(started.call('list_pages', {}), /Browser transport is closed/);

  const unstarted = createChromeTransport(attach);
  await unstarted.close();
  await assert.rejects(unstarted.call('list_pages', {}), /Browser transport is closed/);
  assert.equal(sdk.transportClose.mock.callCount(), 1, 'nothing more was closed');
  assert.equal(built.transports.length, 1, 'and no child was started');
});

test('closing after a start that failed still ends the child that start made', async t => {
  healthy(t);
  sdk.listTools.mock.mockImplementation(async () => {
    throw new Error('cannot list');
  });
  const transport = createChromeTransport(attach);
  await assert.rejects(transport.call('list_pages', {}), /cannot list/);

  await transport.close();

  assert.equal(sdk.transportClose.mock.callCount(), 1, 'a failed startup still owns its child');
});
