import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServedTool } from '@aivi/core';
import plugin from '../src/index.ts';

type Editor = { namespace(ns: unknown): void; add(tool: RegisteredTool): void };
type RegisteredTool = {
  name: string;
  description: string;
  input: { type: string; required?: string[] };
  options: { namespace: string; permission?: string };
  execute(input: unknown, context: { sessionID: string; messageID?: string }): Promise<{ content: string }>;
};

type AgentLike = { id: string; system?: string | undefined };
type AgentEditorFake = { list(): AgentLike[]; update(id: string, fn: (a: AgentLike) => void): void };

/** A fake agent domain: records the transform callbacks so tests can replay them like the registry does. */
function fakeAgentDomain(agents: Map<string, AgentLike>) {
  const callbacks: ((editor: AgentEditorFake) => void)[] = [];
  return {
    callbacks,
    domain: {
      transform: async (callback: (editor: AgentEditorFake) => void) => {
        const editor: AgentEditorFake = {
          list: () => [...agents.keys()].map(id => ({ id, system: agents.get(id)!.system })),
          update: (id, fn) => {
            const agent = agents.get(id);
            if (agent) fn(agent);
          },
        };
        callbacks.push(callback);
        callback(editor);
        return { dispose: async () => {} };
      },
      /** The watcher calls this; the test calls it too, as the synthetic trigger. */
      reload: async () => {},
    },
  };
}

/** Replay the recorded transform over a rebuilt agent, as a registry rebuild does. */
function rebuild(fake: ReturnType<typeof fakeAgentDomain>, system = 'x') {
  const fresh = new Map<string, AgentLike>([['fresh', { id: 'fresh', system }]]);
  fake.callbacks.at(-1)?.({
    list: () => [...fresh.keys()].map(id => ({ id, system: fresh.get(id)!.system })),
    update: (id, fn) => fn(fresh.get(id)!),
  });
  return fresh.get('fresh')!.system;
}

function setupWith(
  options: Record<string, unknown>,
  onAdd: (tool: RegisteredTool) => void,
  onDispose = () => {},
  agent?: ReturnType<typeof fakeAgentDomain>['domain'],
) {
  return plugin.setup({
    options,
    agent,
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

/** The plugin reads `~/.config/aivi.json` for remote credentials; tests must
 *  never see the machine's own client config. */
async function hermeticXdg(t: { after(fn: () => void): void }) {
  const previous = process.env.XDG_CONFIG_HOME;
  const scratch = await mkdtemp(join(tmpdir(), 'aivi-plugin-xdg-'));
  process.env.XDG_CONFIG_HOME = scratch;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    return rm(scratch, { recursive: true, force: true });
  });
  return scratch;
}

/** A stand-in host: routes map `METHOD /path` to a JSON answer or a handler. */
type Route = (request: {
  body: unknown;
  headers: Record<string, string | undefined>;
}) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;
async function hostServing(t: { after(fn: () => void): void }, routes: Record<string, Route>): Promise<string> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = routes[`${request.method} ${url.pathname}`];
    let body: unknown;
    if (request.method === 'POST') {
      let text = '';
      for await (const chunk of request) text += chunk;
      body = JSON.parse(text);
    }
    response.setHeader('content-type', 'application/json');
    if (!route) {
      response.statusCode = 404;
      response.end('{"error":"Not found"}');
      return;
    }
    const answer = await route({ body, headers: request.headers as Record<string, string | undefined> });
    response.statusCode = answer.status ?? 200;
    response.end(JSON.stringify(answer.json));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

/** A host that answers nothing: the port is closed the moment it opens. */
async function deadPort(t: { after(fn: () => void): void }): Promise<string> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
}

const descriptor = (over: Partial<ServedTool>): ServedTool => ({
  id: 'aivi_status',
  namespace: 'aivi',
  name: 'status',
  description: 'Inspect aivi job counts and capabilities. This does not start work.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  timeoutMs: 10_000,
  ...over,
});

const toolsRoute = (...tools: ServedTool[]): Record<string, Route> => ({
  'GET /tools': () => ({ json: { tools } }),
});

test('plugin registers exactly the tools the host serves, beside its own connection tool', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-only-token');
  const base = await hostServing(
    t,
    toolsRoute(
      descriptor({}),
      descriptor({
        id: 'knowledge_search',
        namespace: 'knowledge',
        name: 'search',
        description: 'Search.',
        input: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      }),
    ),
  );
  const tools: RegisteredTool[] = [];
  let disposed = false;
  const cleanup = await setupWith(
    { url: base },
    tool => tools.push(tool),
    () => {
      disposed = true;
    },
  );
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['connection', 'status', 'search'],
    'the connection tool is the plugin own; the rest come from GET /tools',
  );
  for (const tool of tools) assert.equal(tool.input.type, 'object', `${tool.name} must declare a root object schema`);
  assert.equal(typeof cleanup, 'function');
  if (typeof cleanup === 'function') await cleanup();
  assert.equal(disposed, true);
});

test('a host that refuses the plugin still loads, and the connection tool reports the refusal', async t => {
  await hermeticXdg(t);
  withToken(t, undefined);
  const refuse: Route = () => ({ status: 401, json: { error: 'Unauthorized' } });
  const base = await hostServing(t, {
    'GET /tools': refuse,
    'GET /health': refuse,
    'GET /status': refuse,
  });
  const tools: RegisteredTool[] = [];
  const cleanup = await setupWith({ url: base }, tool => tools.push(tool));
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['connection'],
    'a served list the host refuses is no list at all',
  );
  const report = JSON.parse((await tools[0]!.execute({}, { sessionID: 's' })).content);
  assert.equal(report.reachable, false);
  assert.match(report.error, /401.*bearer token that names a person/);
  if (typeof cleanup === 'function') await cleanup();
});

test('host down at load: only the connection tool remains and it says the host is not reachable', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-offline-token');
  const base = await deadPort(t);
  const tools: RegisteredTool[] = [];
  const cleanup = await setupWith({ url: base }, tool => tools.push(tool));
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['connection'],
  );
  const report = JSON.parse((await tools[0]!.execute({}, { sessionID: 's' })).content);
  assert.equal(report.reachable, false);
  assert.match(report.error, /not reachable/);
  assert.deepEqual(report.toolsLoaded, []);
  if (typeof cleanup === 'function') await cleanup();
});

test('the connection tool tells a live host its tools were not loaded into this process', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-late-host-token');
  const base = await hostServing(t, {
    'GET /tools': () => ({ status: 404, json: { error: 'Not found' } }),
    'GET /health': () => ({ json: { ok: true } }),
    'GET /status': () => ({ json: { version: '4.5.6', counts: {} } }),
  });
  const tools: RegisteredTool[] = [];
  const cleanup = await setupWith({ url: base }, tool => tools.push(tool));
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['connection'],
    'the host was not serving tools at load',
  );
  const report = JSON.parse((await tools[0]!.execute({}, { sessionID: 's' })).content);
  assert.equal(report.reachable, true);
  assert.equal(report.version, '4.5.6');
  assert.deepEqual(report.toolsLoaded, []);
  assert.match(report.note, /reload OpenCode/i);
  if (typeof cleanup === 'function') await cleanup();
});

test('served tools keep their namespace and dispatch through POST /tools with the runtime session', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-native-browser-token');
  let received: unknown;
  const base = await hostServing(t, {
    ...toolsRoute(
      descriptor({
        id: 'aivi_browser',
        name: 'browser',
        description: 'Drive Chrome.',
        input: { type: 'object', required: ['action'], properties: { action: { type: 'string' } } },
        timeoutMs: 300_000,
      }),
    ),
    'POST /tools': request => {
      received = request.body;
      return { json: { tabs: [] } };
    },
  });
  let browser: RegisteredTool | undefined;
  const cleanup = await setupWith({ url: base }, tool => {
    if (tool.name === 'browser') browser = tool;
  });
  assert.ok(browser);
  assert.equal(browser.options.namespace, 'aivi');
  assert.equal(browser.options.permission, undefined, 'permission action is the tool id, aivi_browser');
  assert.deepEqual(await browser.execute({ action: 'tabs' }, { sessionID: 'native-owner' }), {
    content: '{"tabs":[]}',
  });
  assert.deepEqual(received, {
    tool: 'aivi_browser',
    sessionId: 'native-owner',
    input: { action: 'tabs' },
  });
  if (typeof cleanup === 'function') await cleanup();
});

test('the jobs envelope forwards the calling session and message so the host can derive agent, directory and authority', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-native-jobs-token');
  let received: unknown;
  const base = await hostServing(t, {
    ...toolsRoute(descriptor({ id: 'aivi_jobs', name: 'jobs', description: 'Schedule.', timeoutMs: 30_000 })),
    'POST /tools': request => {
      received = request.body;
      return { json: { summary: 'Created', items: [] } };
    },
  });
  let jobs: RegisteredTool | undefined;
  const cleanup = await setupWith({ url: base }, tool => {
    if (tool.name === 'jobs') jobs = tool;
  });
  assert.ok(jobs);
  assert.equal(jobs.options.namespace, 'aivi');
  assert.deepEqual(
    await jobs.execute(
      { action: 'create', prompt: 'Summarize', cron: '0 9 * * 1' },
      { sessionID: 'ses_caller', messageID: 'msg_caller' },
    ),
    { content: '{"summary":"Created","items":[]}' },
  );
  assert.deepEqual(received, {
    tool: 'aivi_jobs',
    sessionId: 'ses_caller',
    messageId: 'msg_caller',
    input: { action: 'create', prompt: 'Summarize', cron: '0 9 * * 1' },
  });
  if (typeof cleanup === 'function') await cleanup();
});

test('remote mode: url and bearer come from the client config when options say nothing', async t => {
  const xdg = await hermeticXdg(t);
  withToken(t, undefined);
  const url = 'http://127.0.0.1:4321';
  const token = `aivi-${'f'.repeat(32)}`;
  await writeFile(
    join(xdg, 'aivi.json'),
    JSON.stringify({ configVersion: 1, url, person: { token, id: 'person-1', name: 'Ada', roles: ['operator'] } }),
  );
  const server: Server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`, 'the cached person bearer is sent');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/tools') {
      response.end(JSON.stringify({ tools: [descriptor({})] }));
      return;
    }
    response.end('{"counts":{},"version":"1.2.3"}');
  });
  // The client config names this port, so the server must take it.
  await new Promise<void>(resolve => server.listen(4321, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let status: RegisteredTool | undefined;
  const cleanup = await setupWith({}, tool => {
    if (tool.name === 'status') status = tool;
  });
  assert.ok(status, 'the served list arrives over the configured bearer');
  await status.execute({}, { sessionID: 's' });
  if (typeof cleanup === 'function') await cleanup();
});

test('on a server home the cached bearer is ignored: host-originated sessions stay anonymous', async t => {
  const xdg = await hermeticXdg(t);
  withToken(t, undefined);
  const root = await mkdtemp(join(tmpdir(), 'aivi-server-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1 }));
  await writeFile(
    join(xdg, 'aivi.json'),
    JSON.stringify({ configVersion: 1, url: 'http://127.0.0.1:4321', person: { token: 'aivi-cached' } }),
  );
  const server: Server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined, 'no bearer may leak from the operator into host work');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/tools') {
      response.end(JSON.stringify({ tools: [descriptor({})] }));
      return;
    }
    response.end('{"counts":{},"version":"1.2.3"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugins: [{ package: '@aivi/opencode', options: { url: `http://127.0.0.1:${address.port}` } }] }),
  );
  let status: RegisteredTool | undefined;
  const cleanup = await setupWith({ soul: join(root, 'soul.md'), url: `http://127.0.0.1:${address.port}` }, tool => {
    if (tool.name === 'status') status = tool;
  });
  assert.ok(status);
  await status.execute({}, { sessionID: 's' });
  if (typeof cleanup === 'function') await cleanup();
});

test('the soul is appended to every agent at each replay, never twice, and an edit invalidates the registry', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-soul-token');
  const root = await mkdtemp(join(tmpdir(), 'aivi-soul-'));
  const soulFile = join(root, 'soul.md');
  await writeFile(soulFile, 'I am aivi. I route rather than do.');
  const base = await hostServing(t, toolsRoute());
  const agents = new Map<string, AgentLike>([
    ['librarian', { id: 'librarian', system: 'base prompt' }],
    ['worker', { id: 'worker' }],
  ]);
  const fake = fakeAgentDomain(agents);
  const cleanup = await setupWith(
    { soul: soulFile, url: base },
    () => {},
    () => {},
    fake.domain,
  );
  t.after(async () => {
    if (typeof cleanup === 'function') await cleanup();
    await rm(root, { recursive: true, force: true });
  });

  // The transform ran once; both agents carry the soul, however their prompt was written.
  assert.equal(agents.get('librarian')!.system, 'base prompt\n\nI am aivi. I route rather than do.');
  assert.equal(agents.get('worker')!.system, 'I am aivi. I route rather than do.');

  // The registry replays the transform over a rebuilt state: appending stays idempotent.
  assert.equal(rebuild(fake), 'x\n\nI am aivi. I route rather than do.', 'appended once, not twice');

  // A soul.md edit reaches the agents without a restart: the plugin's watcher
  // calls agent.reload(), and the registry replay reads the file fresh. The
  // watcher is Node's, not ours — the test triggers the reload synthetically
  // and owns only the behavior when it fires.
  await writeFile(soulFile, 'I am aivi, renewed.');
  await fake.domain.reload();
  assert.equal(rebuild(fake), 'x\n\nI am aivi, renewed.', 'the reload carried the edit');
});

test('the persona name is said from config.json, watched like the soul, and read past what the host would accept', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-name-token');
  const root = await mkdtemp(join(tmpdir(), 'aivi-name-'));
  const soulFile = join(root, 'soul.md');
  await writeFile(soulFile, 'I route rather than do.');
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, identity: { name: 'Clawd' } }));
  const base = await hostServing(t, toolsRoute());
  const agents = new Map<string, AgentLike>([['librarian', { id: 'librarian', system: 'base prompt' }]]);
  const fake = fakeAgentDomain(agents);
  const cleanup = await setupWith(
    { soul: soulFile, url: base },
    () => {},
    () => {},
    fake.domain,
  );
  t.after(async () => {
    if (typeof cleanup === 'function') await cleanup();
    await rm(root, { recursive: true, force: true });
  });

  // One place states the name: the config, so soul.md never repeats it.
  assert.equal(agents.get('librarian')!.system, 'base prompt\n\nYour name is Clawd.\n\nI route rather than do.');

  // The name is config, so it changes without a restart: config.json is watched like the soul.
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, identity: { name: 'Cline' } }));
  await fake.domain.reload();
  assert.equal(rebuild(fake), 'x\n\nYour name is Cline.\n\nI route rather than do.');

  // A config the host would refuse still says who aivi is: the plugin reads the
  // one field it states, and validates nothing else.
  await writeFile(join(root, 'config.json'), '{"version": 99, "identity": {"name": "Clawd"}}');
  assert.equal(rebuild(fake), 'x\n\nYour name is Clawd.\n\nI route rather than do.');

  // A half-written file costs the name line and nothing else.
  await writeFile(join(root, 'config.json'), 'half-written {');
  assert.equal(rebuild(fake), 'x\n\nI route rather than do.', 'the soul lands even when the config cannot be read');
});
