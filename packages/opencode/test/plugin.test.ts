import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ServedTool } from '@aivi/core';
import plugin from '../src/index.ts';
import type { EvaluationLike } from '../src/redirect.ts';

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

/** A fake permission domain: records the evaluate hook so tests can fire
 *  evaluations through it like OpenCode does. */
function fakePermission() {
  const evaluates: ((event: never) => Promise<void> | void)[] = [];
  return {
    evaluates,
    domain: {
      hook: async (_name: string, callback: (event: never) => Promise<void> | void) => {
        evaluates.push(callback);
        return { dispose: async () => {} };
      },
    },
  };
}

function setupWith(
  options: Record<string, unknown>,
  onAdd: (tool: RegisteredTool) => void,
  onDispose = () => {},
  agent?: ReturnType<typeof fakeAgentDomain>['domain'],
  permission?: ReturnType<typeof fakePermission>['domain'],
  location?: { directory: string },
) {
  return plugin.setup({
    options,
    agent,
    location,
    permission: permission ?? fakePermission().domain,
    tool: {
      transform: async (callback: (editor: Editor) => void) => {
        callback({ namespace() {}, add: onAdd });
        return { dispose: async () => onDispose() };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]);
}

function withEnv(t: { after(fn: () => void): void }, name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const withToken = (t: { after(fn: () => void): void }, value: string | undefined) => withEnv(t, 'AIVI_TOKEN', value);

/** The plugin reads `~/.config/aivi/config.json` for remote credentials; tests must
 *  never see the machine's own client config. */
async function hermeticXdg(t: { after(fn: () => void): void }) {
  const previous = process.env.XDG_CONFIG_HOME;
  const scratch = await mkdtemp(join(tmpdir(), 'aivi-plugin-xdg-'));
  await mkdir(join(scratch, 'aivi'), { recursive: true }); // the record's directory, as every reader expects it
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
  /** Path and query, for endpoints that answer on a query parameter. */
  url: string;
}) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;
async function hostServing(t: { after(fn: () => void): void }, routes: Record<string, Route>): Promise<string> {
  const respond: RequestListener = async (request, response) => {
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
    const answer = await route({
      body,
      headers: request.headers as Record<string, string | undefined>,
      url: `${url.pathname}${url.search}`,
    });
    response.statusCode = answer.status ?? 200;
    response.end(JSON.stringify(answer.json));
  };
  const server = createServer(respond);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

/** A host that answers nothing: the port is closed the moment it opens. */
async function deadPort(): Promise<string> {
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
  // The load warning is the plugin's mouth to the person (OpenCode's process
  // has no configured aivi logger to speak through): captured here so it
  // neither litters the test output nor goes unasserted.
  const warned = t.mock.method(console, 'error', () => {});
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
  assert.equal(warned.mock.calls.length, 1, 'the refusal is said once at load');
  const said = String(warned.mock.calls[0]!.arguments[0]);
  assert.ok(said.includes(base) && said.includes('401'), `the warning names the host and the refusal: ${said}`);
  assert.match(said, /Reload OpenCode once the host is running/, 'the person is told the way out');
});

test('host down at load: only the connection tool remains and it says the host is not reachable', async t => {
  const warned = t.mock.method(console, 'error', () => {});
  await hermeticXdg(t);
  withToken(t, 'test-offline-token');
  const base = await deadPort();
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
  assert.equal(warned.mock.calls.length, 1, 'the dead host is said once at load');
  const said = String(warned.mock.calls[0]!.arguments[0]);
  assert.ok(said.includes(base) && /not reachable/.test(said), `the warning names the host and the silence: ${said}`);
  assert.match(said, /Reload OpenCode once the host is running/, 'the person is told the way out');
});

test('the connection tool tells a live host its tools were not loaded into this process', async t => {
  const warned = t.mock.method(console, 'error', () => {});
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
  assert.equal(warned.mock.calls.length, 1, 'the missing list is said once at load');
  const said = String(warned.mock.calls[0]!.arguments[0]);
  assert.ok(
    said.includes(base) && said.includes('404'),
    `the warning names the host and the missing endpoint: ${said}`,
  );
  assert.match(said, /Reload OpenCode once the host is running/, 'the person is told the way out');
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
  const token = `aivi-${'f'.repeat(32)}`;
  const server: Server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`, 'the cached person bearer is sent');
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
  // The client config names the port the server took.
  await writeFile(
    join(xdg, 'aivi', 'config.json'),
    JSON.stringify({
      configVersion: 1,
      url: `http://127.0.0.1:${address.port}`,
      person: { token, id: 'person-1', name: 'Ada', roles: ['operator'] },
    }),
  );
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
    join(xdg, 'aivi', 'config.json'),
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
    ['assistant', { id: 'assistant', system: 'base prompt' }],
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
  assert.equal(agents.get('assistant')!.system, 'base prompt\n\nI am aivi. I route rather than do.');
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
  const agents = new Map<string, AgentLike>([['assistant', { id: 'assistant', system: 'base prompt' }]]);
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
  assert.equal(agents.get('assistant')!.system, 'base prompt\n\nYour name is Clawd.\n\nI route rather than do.');

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

test('the redirect hook denies boundary git for aivi’s runs only, asking the host once per session', async t => {
  await hermeticXdg(t);
  const asked: string[] = [];
  const base = await hostServing(t, {
    ...toolsRoute(),
    'GET /run': request => {
      asked.push(new URL(`http://x${request.url}`).searchParams.get('session') ?? '');
      return { json: { run: asked.length === 1 } };
    },
  });
  const permission = fakePermission();
  await setupWith(
    { url: base },
    () => {},
    () => {},
    undefined,
    permission.domain,
  );
  assert.equal(permission.evaluates.length, 1, 'the plugin registers one evaluate hook');
  const evaluate = permission.evaluates[0]! as unknown as (event: EvaluationLike) => Promise<void>;

  const call = (sessionID: string, command: string): EvaluationLike => ({
    sessionID,
    action: 'shell',
    resources: [command],
    effect: 'allow',
  });

  const first = call('ses_run', 'git push origin');
  await evaluate(first);
  assert.equal(first.effect, 'deny', 'the run’s push is refused');
  assert.match(first.message ?? '', /aivi_push/);

  const second = call('ses_run', 'git fetch');
  await evaluate(second);
  assert.equal(second.effect, 'deny', 'and its fetch too');
  assert.deepEqual(asked, ['ses_run'], 'once per session: the answer is cached');

  // A person's session (the host answers run: false for it) is never denied.
  const person = call('ses_person', 'git push origin');
  await evaluate(person);
  assert.equal(person.effect, 'allow', 'the person next door pushes freely');
  assert.deepEqual(asked, ['ses_run', 'ses_person']);
});

/** The same stand-in host as `hostServing`, with no socket: `fetch` is the plugin's only way to it.
 *  A route that throws is a host that does not answer. */
function hostByFetch(t: TestContext, routes: Record<string, Route>) {
  return t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    const answer = route
      ? await route({
          body: undefined,
          headers: Object.fromEntries(new Headers(init?.headers)),
          url: `${url.pathname}${url.search}`,
        })
      : { status: 404, json: { error: 'Not found' } };
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  });
}

/** `fs.watch` without the file system: what the plugin asked it to watch, the listener it gave, and
 *  what it closed. `fail` is a directory that cannot be watched. */
function watching(t: TestContext, fail?: Error) {
  const close = t.mock.fn();
  const watch = t.mock.method(fs, 'watch', (() => {
    if (fail) throw fail;
    return { close };
  }) as never);
  syncBuiltinESMExports();
  t.after(() => {
    watch.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    close,
    watched: () => watch.mock.calls.map(call => call.arguments[0]),
    heard: (event: string, filename: string | null) =>
      (watch.mock.calls[0]!.arguments[1] as unknown as (event: string, filename: string | null) => void)(
        event,
        filename,
      ),
  };
}

/** A directory with these files in it, gone when the test ends. */
async function scratchHome(t: TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aivi-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

const withBasePrompt = () => new Map<string, AgentLike>([['assistant', { id: 'assistant', system: 'base prompt' }]]);

/**
 * The plugin set up as OpenCode would over a home holding `files`: a host that serves no tools, the
 * home's watch in `watcher` (`watcherFails` is a home that cannot be watched), an agent that has only
 * its base prompt, and a `reload` that counts. `via` is how the plugin is told where the home is.
 */
async function overHome(
  t: TestContext,
  files: Record<string, string>,
  via: 'soul' | 'env' | 'location' = 'soul',
  watcherFails?: Error,
) {
  await hermeticXdg(t);
  withToken(t, 'test-home-token');
  const home = await scratchHome(t, files);
  withEnv(t, 'AIVI_HOME', via === 'env' ? home : undefined);
  hostByFetch(t, toolsRoute());
  const watcher = watching(t, watcherFails);
  const agents = withBasePrompt();
  const fake = fakeAgentDomain(agents);
  const reload = t.mock.fn(fake.domain.reload);
  const cleanup = await setupWith(
    via === 'soul' ? { soul: join(home, 'soul.md') } : {},
    () => {},
    () => {},
    { ...fake.domain, reload },
    undefined,
    via === 'location' ? { directory: home } : undefined,
  );
  return {
    home,
    watcher,
    agents,
    reload,
    stop: async () => {
      if (typeof cleanup === 'function') await cleanup();
    },
  };
}

test('the aivi home is the soul option’s directory, else AIVI_HOME, else where OpenCode runs', async t => {
  for (const [from, via] of [
    ['the soul option', 'soul'],
    ['AIVI_HOME', 'env'],
    ['the OpenCode location', 'location'],
  ] as const) {
    await t.test(from, async s => {
      const over = await overHome(s, { 'soul.md': `I am aivi, said from ${from}.` }, via);

      assert.equal(over.agents.get('assistant')!.system, `base prompt\n\nI am aivi, said from ${from}.`);
      assert.deepEqual(over.watcher.watched(), [over.home], 'and that directory is the one it keeps watching');
      await over.stop();
    });
  }
});

test('an identity with no usable name says no name: the soul stands alone', async t => {
  for (const identity of [undefined, {}, { name: 5 }, { name: '   ' }]) {
    await t.test(`identity ${JSON.stringify(identity) ?? 'left out'}`, async s => {
      const over = await overHome(s, {
        'soul.md': 'I route rather than do.',
        'config.json': JSON.stringify({ version: 1, identity }),
      });

      assert.equal(over.agents.get('assistant')!.system, 'base prompt\n\nI route rather than do.');
    });
  }
});

test('with no soul to say, the agents are left as they are, and the home is still watched for one', async t => {
  for (const [why, files] of [
    ['there is no soul.md yet', {}],
    ['soul.md is blank and no name is configured', { 'soul.md': ' \n' }],
  ] as const) {
    await t.test(why, async s => {
      const over = await overHome(s, files);

      assert.equal(over.agents.get('assistant')!.system, 'base prompt');
      assert.deepEqual(over.watcher.watched(), [over.home], 'a soul written later is picked up');
    });
  }
});

test('a change to soul.md or config.json reloads the agents once the changes settle; other files are no business of theirs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const over = await overHome(t, { 'soul.md': 'I route rather than do.' });
  const heard = over.watcher.heard;

  heard('change', 'notes.txt');
  t.mock.timers.tick(100);
  assert.equal(over.reload.mock.callCount(), 0, 'a file the plugin does not read changes nothing');

  heard('change', 'soul.md');
  heard('rename', 'config.json');
  t.mock.timers.tick(99);
  assert.equal(over.reload.mock.callCount(), 0, 'not before the changes have settled');
  t.mock.timers.tick(1);
  assert.equal(over.reload.mock.callCount(), 1, 'two changes in one window are one reload');

  heard('change', null);
  t.mock.timers.tick(100);
  assert.equal(over.reload.mock.callCount(), 2, 'a change that names no file might be either');

  heard('change', 'soul.md');
  await over.stop();
  t.mock.timers.tick(100);
  assert.equal(over.reload.mock.callCount(), 2, 'a reload still pending when the plugin is disposed never happens');
  assert.equal(over.watcher.close.mock.callCount(), 1, 'and the watch is closed');
});

test('a home that cannot be watched costs only the live reload: the soul is still read at load', async t => {
  const over = await overHome(
    t,
    { 'soul.md': 'I route rather than do.' },
    'soul',
    new Error('ENOENT: no such file or directory, watch'),
  );

  assert.equal(over.agents.get('assistant')!.system, 'base prompt\n\nI route rather than do.');
  await over.stop();
  assert.equal(over.watcher.close.mock.callCount(), 0, 'there was no watch to close');
});

test('a client config that names neither a host nor a person leaves the default host, asked anonymously', async t => {
  const xdg = await hermeticXdg(t);
  withToken(t, undefined);
  withEnv(t, 'AIVI_HOME', undefined);
  await writeFile(join(xdg, 'aivi', 'config.json'), JSON.stringify({ configVersion: 1, url: 5, person: { token: 7 } }));
  const host = hostByFetch(t, toolsRoute());

  await setupWith({}, () => {});

  const [url, init] = host.mock.calls[0]!.arguments;
  assert.equal(String(url), 'http://127.0.0.1:4100/tools');
  assert.equal(new Headers(init?.headers).get('authorization'), null);
});

test('a host that cannot say whether a session is a run is taken to say no, and is asked again next time', async t => {
  await hermeticXdg(t);
  const answers: (boolean | Error)[] = [new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), true];
  hostByFetch(t, {
    ...toolsRoute(),
    'GET /run': () => {
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return { json: { run: answer } };
    },
  });
  const permission = fakePermission();
  await setupWith(
    { url: 'http://127.0.0.1:4100' },
    () => {},
    () => {},
    undefined,
    permission.domain,
  );
  const evaluate = permission.evaluates[0]! as unknown as (event: EvaluationLike) => Promise<void>;
  const push = (): EvaluationLike => ({
    sessionID: 'ses_run',
    action: 'shell',
    resources: ['git push origin'],
    effect: 'allow',
  });

  const unreachable = [push(), push()];
  for (const event of unreachable) await evaluate(event);
  assert.deepEqual(
    unreachable.map(event => event.effect),
    ['allow', 'allow'],
    'the wall is the safety, so the signpost fails open',
  );

  const reachable = push();
  await evaluate(reachable);
  assert.equal(reachable.effect, 'deny', 'once the host answers, the run is known and refused');
  assert.equal(answers.length, 0, 'every unanswered question was asked again');
});

test('the connection tool names the tools this process loaded, and a status the host cannot give costs only the version', async t => {
  await hermeticXdg(t);
  withToken(t, 'test-connection-token');
  hostByFetch(t, {
    ...toolsRoute(descriptor({}), descriptor({ id: 'knowledge_search', namespace: 'knowledge', name: 'search' })),
    'GET /health': () => ({ json: { ok: true } }),
    'GET /status': () => ({ status: 500, json: { error: 'Internal' } }),
  });
  const tools: RegisteredTool[] = [];
  await setupWith({ url: 'http://127.0.0.1:4100' }, tool => tools.push(tool));

  const report = JSON.parse((await tools[0]!.execute({}, { sessionID: 's' })).content);

  assert.deepEqual(report, {
    reachable: true,
    host: 'http://127.0.0.1:4100',
    toolsLoaded: ['aivi_status', 'knowledge_search'],
  });
});
