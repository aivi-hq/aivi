import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dreamingArgsSchema } from '@aivi/core';
import { collectSessions, dream, readCursor, renderTranscript } from '../src/dreaming.ts';
import { connectOpenCode } from '../src/opencode.ts';
import { createExecutor } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { TaskRegistry } from '../src/tasks.ts';

const T0 = Date.parse('2026-09-14T10:00:00Z');
const sessions = [
  { id: 'ses_new', updated: T0 + 3000, metadata: { aivi: { origin: 'discord', channel: 'c1' } } },
  { id: 'ses_job', updated: T0 + 2500, metadata: { aivi: { origin: 'job', run: 'x' } } },
  { id: 'ses_old_updated', updated: T0 + 2000, metadata: { aivi: { origin: 'discord', channel: 'c2' } } },
  { id: 'ses_human', updated: T0 + 1500 },
  { id: 'ses_ancient', updated: T0 - 1000, metadata: { aivi: { origin: 'discord', channel: 'c3' } } },
];
const messages: Record<string, unknown[]> = {
  ses_new: [
    {
      type: 'user',
      id: 'u1',
      time: { created: T0 + 2900 },
      text: '[Discord message from Bob (user 1)]\nWe deploy on Tuesdays.',
    },
    {
      type: 'assistant',
      id: 'a1',
      agent: 'librarian',
      time: { created: T0 + 2950, completed: T0 + 2999 },
      content: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'Noted: Tuesdays.' },
      ],
    },
    { type: 'idle', id: 'i1', time: { created: T0 + 3000 }, outcome: 'succeeded' },
  ],
  ses_old_updated: [
    { type: 'user', id: 'u0', time: { created: T0 - 5000 }, text: 'old question before cursor' },
    { type: 'user', id: 'u2', time: { created: T0 + 1900 }, text: 'new question' },
    {
      type: 'assistant',
      id: 'a2',
      agent: 'librarian',
      time: { created: T0 + 1950, completed: T0 + 1999 },
      content: [{ type: 'text', text: 'new answer' }],
    },
  ],
};

function mockOpenCode(agent = 'dreamer') {
  const requests: { method: string; path: string; body: Record<string, any> }[] = [];
  let promptId = '';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, 'http://x');
    requests.push({ method: req.method!, path: url.pathname, body });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const sorted = [...sessions]
        .sort((a, b) => b.updated - a.updated)
        .map(s => ({ ...s, time: { created: s.updated - 100, updated: s.updated }, location: { directory: '/lib' } }));
      res.end(JSON.stringify({ data: sorted, cursor: { next: null } }));
      return;
    }
    const m = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (m && req.method === 'GET') {
      res.end(JSON.stringify({ data: messages[m[1]!] ?? [], cursor: { next: null } }));
      return;
    }
    if (url.pathname === '/api/agent')
      return void res.end(JSON.stringify({ data: [{ id: 'librarian', name: 'librarian' }] }));
    if (req.method === 'PATCH' || url.pathname.endsWith('/wait')) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.endsWith('/permission') && req.method === 'GET') {
      res.end('{"data":[]}');
      return;
    }
    if (url.pathname.endsWith('/prompt')) {
      promptId = body.id;
      res.end(JSON.stringify({ data: { id: body.id } }));
      return;
    }
    if (url.pathname.endsWith('/context')) {
      res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: promptId, text: 'q', time: { created: 1 } },
            {
              type: 'assistant',
              id: 'a',
              agent,
              finish: 'stop',
              time: { created: 2, completed: 3 },
              content: [{ type: 'text', text: 'Added 1 fact.' }],
            },
            { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ data: { id: body.id ?? 'ses_aivi_x', agent, location: { directory: '/lib' } } }));
  });
  return { server, requests };
}

async function start(t: { after(fn: () => Promise<void>): void }, mock: ReturnType<typeof mockOpenCode>) {
  await new Promise<void>(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => mock.server.close(() => resolve())));
  const address = mock.server.address();
  assert.ok(address && typeof address !== 'string');
  return connectOpenCode({ url: `http://127.0.0.1:${address.port}`, lifecycle: 'discover' }, {});
}

test('collectSessions picks aivi sessions by origin updated after the cursor, oldest first, with only new messages', async t => {
  const client = await start(t, mockOpenCode());
  const found = await collectSessions(client, T0, ['discord'], 50, AbortSignal.timeout(5000));
  assert.deepEqual(
    found.map(s => s.id),
    ['ses_old_updated', 'ses_new'],
  );
  assert.equal(found[0]!.lines.length, 2, 'messages before the cursor are skipped');
  assert.match(
    found[1]!.lines[1]!,
    /^\*\*librarian\*\* .*\nNoted: Tuesdays\.$/,
    'reasoning is excluded, agent is named',
  );
  const capped = await collectSessions(client, T0, ['discord'], 1, AbortSignal.timeout(5000));
  assert.deepEqual(
    capped.map(s => s.id),
    ['ses_old_updated'],
    'a cap keeps the oldest so nothing is skipped across runs',
  );
  const transcript = renderTranscript(found, T0);
  assert.match(transcript, /## ses_new \(discord, channel c1\)/);
});

test('dream writes the transcript, allows the same two write targets in the org and every project memory, advances the cursor, and reports changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-dream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, 'knowledge', 'memory');
  const demo = join(memory, 'demo');
  const mock = mockOpenCode();
  const client = await start(t, mock);
  const store = new Store(':memory:');
  t.after(async () => store.close());
  const task = dreamingArgsSchema.parse({ directory: '/lib', memoryDirectory: memory });
  // Simulate the agent writing an org fact and a project fact during its turn.
  const originalPrompt = mock.server.listeners('request')[0] as (...args: unknown[]) => unknown;
  mock.server.removeAllListeners('request');
  mock.server.on('request', async (req, res) => {
    if (req.url!.endsWith('/prompt')) {
      await writeFile(
        join(memory, 'facts.md'),
        '# Facts\n\n## Deployment\n- 2026-09-14 (discord, Bob): deploys on Tuesdays.\n',
      );
      await writeFile(join(demo, 'facts.md'), '# Facts: demo\n\n- 2026-09-14 (discord, Bob): demo uses pnpm.\n');
    }
    return originalPrompt(req, res);
  });
  const deps = {
    store,
    client,
    events: { watch: () => () => {} },
    stateDirectory: join(root, 'state'),
    projects: [{ id: 'demo', memory: demo }],
    signal: AbortSignal.timeout(10000),
    now: () => T0 + 10_000,
  };
  store.migrate('dreaming', [
    'CREATE TABLE dreaming_cursor(key TEXT PRIMARY KEY, since INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  ]);
  store.db.prepare('INSERT INTO dreaming_cursor VALUES(?,?,?)').run(memory, T0, T0);

  const outcome = await dream(task, 'job-1', deps);
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.result.reviewed, 2);
  assert.deepEqual(outcome.result.sessions, ['ses_old_updated', 'ses_new']);
  assert.deepEqual(outcome.result.changed, ['demo/facts.md', 'facts.md']);
  assert.equal(outcome.result.text, 'Added 1 fact.');
  assert.equal(readCursor(store, memory), T0 + 3000, 'cursor advances to the newest reviewed session, not to now');
  assert.match(await readFile(outcome.result.transcript!, 'utf8'), /We deploy on Tuesdays/);

  const create = mock.requests.find(r => r.method === 'POST' && r.path === '/api/session')!;
  assert.equal(create.body.id, 'ses_aivi_job1');
  assert.deepEqual(create.body.metadata, { aivi: { origin: 'dreaming', run: 'job-1' } });
  // Permission resources use canonical paths (tmpdir is a symlink on macOS), as OpenCode matches them.
  const canonical = await realpath(memory);
  const edits = create.body.permissions
    .filter((p: { action: string }) => p.action === 'edit')
    .map((p: { resource: string }) => p.resource);
  assert.deepEqual(edits, [
    `${canonical}/facts.md`,
    `${canonical}/proposals/*`,
    `${canonical}/demo/facts.md`,
    `${canonical}/demo/proposals/*`,
  ]);
  for (const dir of [canonical, `${canonical}/demo`])
    assert.ok(
      create.body.permissions.some(
        (p: { action: string; resource: string }) => p.action === 'external_directory' && p.resource === `${dir}/**`,
      ),
    );
  const prompt = mock.requests.find(r => r.path.endsWith('/prompt'))!;
  assert.match(JSON.stringify(prompt.body), /demo: .*\/demo \(facts about the demo project go here\)/);
  // The agent file is the boundary; the job only adds where memory is and what may be written.
  assert.ok(
    create.body.permissions.every((p: { action: string }) => ['external_directory', 'edit'].includes(p.action)),
    'no deny-all, no tool allow-list',
  );

  const again = await dream(task, 'job-2', deps);
  assert.equal(again.result.reviewed, 0, 'nothing new after the cursor');
  assert.equal(
    mock.requests.filter(r => r.path.endsWith('/prompt')).length,
    1,
    'no model call when there is nothing to review',
  );
});

test('the dreaming operation resolves its args against the home and demands a searchable memory directory', async t => {
  const { loadConfig } = await import('@aivi/core');
  const root = await mkdtemp(join(tmpdir(), 'aivi-dream-cfg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = (memoryDirectory?: string) =>
    writeFile(
      join(root, 'aivi.json'),
      JSON.stringify({
        version: 1,
        knowledge: [{ id: 'k', path: 'knowledge' }],
        jobs: [
          {
            id: 'dreaming',
            cron: '0 3 * * *',
            task: {
              kind: 'invocation',
              name: 'dreaming',
              args: { directory: 'lib', ...(memoryDirectory ? { memoryDirectory } : {}) },
            },
          },
        ],
      }),
    );
  // The claimant parses and resolves its own args; wrong ones fail the run with a readable reason.
  const runDreaming = async (memoryDirectory?: string) => {
    await write(memoryDirectory);
    const loaded = await loadConfig(join(root, 'aivi.json'));
    const store = new Store(':memory:');
    t.after(() => store.close());
    const execute = createExecutor(loaded, {
      store,
      events: { watch: () => () => {} },
      opencode: async () => {
        throw new Error('no OpenCode here');
      },
      tasks: new TaskRegistry(),
    });
    const job = store.enqueue(loaded.config.jobs[0]!.task, 'local-model', `dream:${memoryDirectory ?? 'default'}`);
    return execute(
      { ...job, id: `run:${memoryDirectory ?? 'default'}` },
      { signal: new AbortController().signal, attachSession() {} },
    );
  };
  const outside = await runDreaming('elsewhere/memory');
  assert.equal(outside.state, 'failed');
  assert.match(outside.reason ?? '', /inside a core knowledge source/);
  // Past the check the run reaches for OpenCode; the connection error proves it got that far.
  const inside = await runDreaming('knowledge/memory');
  assert.match(inside.reason ?? '', /no OpenCode here/);
  const fallback = await runDreaming();
  assert.match(fallback.reason ?? '', /no OpenCode here/, '<home>/memory is always a core source');
});
