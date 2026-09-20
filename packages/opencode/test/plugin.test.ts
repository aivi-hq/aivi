import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import plugin from '../src/index.ts';

type Editor = { namespace(ns: unknown): void; add(tool: RegisteredTool): void };
type RegisteredTool = {
  name: string;
  input: { type: string; required?: string[] };
  options: { namespace: string; permission?: string };
  execute(input: unknown, context: { sessionID: string; messageID?: string }): Promise<{ content: string }>;
};

type AgentLike = { id: string; system?: string | undefined };
type AgentEditorFake = { list(): AgentLike[]; update(id: string, fn: (a: AgentLike) => void): void };

/** A fake agent domain: records the transform callbacks so tests can replay them like the registry does. */
function fakeAgentDomain(agents: Map<string, AgentLike>) {
  const callbacks: ((editor: AgentEditorFake) => void)[] = [];
  let reloads = 0;
  return {
    callbacks,
    get reloads() {
      return reloads;
    },
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
      reload: async () => {
        reloads++;
      },
    },
  };
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
    ['search', 'status', 'sources', 'projects', 'context', 'jobs', 'browser'],
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

test('jobs tool forwards the calling session and message so the host can derive agent, directory and authority', async t => {
  withToken(t, 'test-native-jobs-token');
  let received: unknown;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/jobs');
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
  let jobs: RegisteredTool | undefined;
  const cleanup = await setupWith({ url: `http://127.0.0.1:${address.port}` }, tool => {
    if (tool.name === 'jobs') jobs = tool;
  });
  assert.ok(jobs);
  assert.equal(jobs.options.namespace, 'aivi');
  assert.deepEqual(
    await jobs.execute(
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

test('the soul is appended to every agent at each replay, never twice, and an edit invalidates the registry', async t => {
  withToken(t, 'test-soul-token');
  const root = await mkdtemp(join(tmpdir(), 'aivi-soul-'));
  const soulFile = join(root, 'soul.md');
  await writeFile(soulFile, 'I am aivi. I route rather than do.');
  const agents = new Map<string, AgentLike>([
    ['librarian', { id: 'librarian', system: 'base prompt' }],
    ['worker', { id: 'worker' }],
  ]);
  const fake = fakeAgentDomain(agents);
  const cleanup = await setupWith(
    { soul: soulFile },
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

  // The registry replays the transform over a rebuilt (fresh) state: appending stays idempotent.
  const fresh = new Map<string, AgentLike>([['fresh', { id: 'fresh', system: 'x' }]]);
  fake.callbacks.at(-1)?.({
    list: () => [...fresh.keys()].map(id => ({ id, system: fresh.get(id)!.system })),
    update: (id, fn) => {
      const agent = fresh.get(id);
      if (agent) fn(agent);
    },
  });
  assert.equal(fresh.get('fresh')!.system, 'x\n\nI am aivi. I route rather than do.', 'appended once, not twice');

  // A soul.md edit is seen without a restart: the watcher invalidates the registry.
  const reloadsBefore = fake.reloads;
  await writeFile(soulFile, 'I am aivi, renewed.');
  for (let i = 0; i < 100 && fake.reloads === reloadsBefore; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fake.reloads > reloadsBefore, 'the edit triggered agent.reload()');
});

test('the persona name is said from aivi.json, watched like the soul, and read past what the host would accept', async t => {
  withToken(t, 'test-name-token');
  const root = await mkdtemp(join(tmpdir(), 'aivi-name-'));
  const soulFile = join(root, 'soul.md');
  await writeFile(soulFile, 'I route rather than do.');
  await writeFile(join(root, 'aivi.json'), JSON.stringify({ version: 1, identity: { name: 'Clawd' } }));
  const agents = new Map<string, AgentLike>([['librarian', { id: 'librarian', system: 'base prompt' }]]);
  const fake = fakeAgentDomain(agents);
  const cleanup = await setupWith(
    { soul: soulFile },
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

  /** Replay the recorded transform over a fresh agent, as a registry rebuild does. */
  const rebuild = (system: string) => {
    const fresh = new Map<string, AgentLike>([['fresh', { id: 'fresh', system }]]);
    fake.callbacks.at(-1)?.({
      list: () => [...fresh.keys()].map(id => ({ id, system: fresh.get(id)!.system })),
      update: (id, fn) => {
        const agent = fresh.get(id);
        if (agent) fn(agent);
      },
    });
    return fresh.get('fresh')!.system;
  };

  // The name is config, so it changes without a restart: aivi.json is watched too.
  const reloadsBefore = fake.reloads;
  await writeFile(join(root, 'aivi.json'), JSON.stringify({ version: 1, identity: { name: 'Cline' } }));
  for (let i = 0; i < 100 && fake.reloads === reloadsBefore; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fake.reloads > reloadsBefore, 'the edit triggered agent.reload()');
  assert.equal(rebuild('x'), 'x\n\nYour name is Cline.\n\nI route rather than do.');

  // A config the host would refuse still says who aivi is: the plugin reads the
  // one field it states, and validates nothing else.
  await writeFile(join(root, 'aivi.json'), '{"version": 99, "identity": {"name": "Clawd"}}');
  assert.equal(rebuild('x'), 'x\n\nYour name is Clawd.\n\nI route rather than do.');

  // A half-written file costs the name line and nothing else.
  await writeFile(join(root, 'aivi.json'), 'half-written {');
  assert.equal(rebuild('x'), 'x\n\nI route rather than do.', 'the soul lands even when the config cannot be read');
});
