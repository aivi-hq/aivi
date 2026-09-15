import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import plugin from '../src/index.ts';

type Editor = { namespace(ns: unknown): void; add(tool: RegisteredTool): void };
type RegisteredTool = {
  name: string;
  input: { type: string; required?: string[] };
  options: { namespace: string; permission?: string };
  execute(input: unknown, context: { sessionID: string; messageID?: string }): Promise<{ content: string }>;
};

function setupWith(options: Record<string, unknown>, onAdd: (tool: RegisteredTool) => void, onDispose = () => {}) {
  return plugin.setup({
    options,
    tool: {
      transform: async (callback: (editor: Editor) => void) => {
        callback({ namespace() {}, add: onAdd });
        return { dispose: async () => onDispose() };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]);
}

function withToken(t: { after(fn: () => void): void }, value: string | undefined) {
  const previous = process.env.AIVI_TOKEN;
  if (value === undefined) delete process.env.AIVI_TOKEN;
  else process.env.AIVI_TOKEN = value;
  t.after(() => {
    if (previous === undefined) delete process.env.AIVI_TOKEN;
    else process.env.AIVI_TOKEN = previous;
  });
}

test('plugin registers its tools with root object schemas and disposes its registration', async t => {
  withToken(t, 'test-only-token');
  const tools: RegisteredTool[] = [];
  let disposed = false;
  const cleanup = await setupWith(
    {},
    tool => tools.push(tool),
    () => {
      disposed = true;
    },
  );
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['search', 'status', 'sources', 'schedule', 'browser'],
  );
  for (const tool of tools) assert.equal(tool.input.type, 'object', `${tool.name} must declare a root object schema`);
  assert.equal(typeof cleanup, 'function');
  if (typeof cleanup === 'function') await cleanup();
  assert.equal(disposed, true);
});

test('plugin loads without AIVI_TOKEN and reports a clear error when the host rejects a call', async t => {
  withToken(t, undefined);
  const server = createServer((_request, response) => {
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json');
    response.end('{"error":"Unauthorized"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let status: RegisteredTool | undefined;
  await setupWith({ url: `http://127.0.0.1:${address.port}` }, tool => {
    if (tool.name === 'status') status = tool;
  });
  assert.ok(status, 'plugin must still register tools without a token');
  await assert.rejects(status.execute({}, { sessionID: 's' }), /401.*AIVI_TOKEN/);
});

test('browser tool lives under aivi (not OpenCode’s browser namespace) and forwards the runtime session ID', async t => {
  withToken(t, 'test-native-browser-token');
  let received: unknown;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/browser');
    assert.equal(request.headers.authorization, 'Bearer test-native-browser-token');
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    response.end('{"tabs":[]}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let browser: RegisteredTool | undefined;
  const cleanup = await setupWith({ url: `http://127.0.0.1:${address.port}` }, tool => {
    if (tool.name === 'browser') browser = tool;
  });
  assert.ok(browser);
  assert.equal(browser.options.namespace, 'aivi');
  assert.equal(browser.options.permission, undefined, 'permission action is the tool id, aivi_browser');
  assert.deepEqual(await browser.execute({ action: 'tabs' }, { sessionID: 'native-owner' }), {
    content: '{"tabs":[]}',
  });
  assert.deepEqual(received, { sessionId: 'native-owner', request: { action: 'tabs' } });
  if (typeof cleanup === 'function') await cleanup();
});

test('schedule tool forwards the calling session and message so the host can derive agent, directory and authority', async t => {
  withToken(t, 'test-native-schedule-token');
  let received: unknown;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/schedule');
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    response.end('{"summary":"Created","items":[]}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let schedule: RegisteredTool | undefined;
  const cleanup = await setupWith({ url: `http://127.0.0.1:${address.port}` }, tool => {
    if (tool.name === 'schedule') schedule = tool;
  });
  assert.ok(schedule);
  assert.equal(schedule.options.namespace, 'aivi');
  assert.deepEqual(
    await schedule.execute(
      { action: 'create', prompt: 'Summarize', cron: '0 9 * * 1', sessionId: 'spoofed' },
      { sessionID: 'ses_caller', messageID: 'msg_caller' },
    ),
    { content: '{"summary":"Created","items":[]}' },
  );
  assert.deepEqual(received, {
    action: 'create',
    prompt: 'Summarize',
    cron: '0 9 * * 1',
    sessionId: 'ses_caller',
    messageId: 'msg_caller',
  });
  if (typeof cleanup === 'function') await cleanup();
});
