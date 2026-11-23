import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import type { ChannelPlatform } from '@aivi/plugin/channel';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { describeConversation, describeSession } from '../src/channel/context.ts';
import { ConversationStore } from '../src/channel/store.ts';
import { connectOpenCode } from '../src/opencode.ts';
import { Store } from '../src/store.ts';

const platform: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
const loaded = {
  path: '/config.json',
  config: configSchema.parse({ version: 1 }),
  projects: [
    { id: 'demo', directory: '/home/projects/demo' },
    { id: 'old', directory: '/home/projects/old', removed: true as const },
  ],
  sources: [
    { id: 'company', path: '/home/knowledge', kind: 'doc' as const, scope: 'core' as const },
    { id: 'memory', path: '/home/memory', kind: 'memory' as const, scope: 'core' as const },
    {
      id: 'docs',
      path: '/home/projects/demo/docs',
      kind: 'doc' as const,
      scope: 'project' as const,
      projectId: 'demo',
    },
  ],
};
const binding = { agent: 'assistant', directory: '/home' };

// The fixtures mirror the live server's answers (dev home, 2026-09-28): the
// session object carries lifetime cost and tokens, the context response is the
// effective context starting at its compaction, and the plugin list is
// OpenCode's own — built-ins included, which /context must skip.
const sessionData = {
  id: 'ses_x',
  projectID: 'p',
  agent: 'assistant',
  model: { providerID: 'github-copilot', id: 'gpt-5.2', variant: 'high' },
  cost: 0.0012,
  tokens: { input: 3000, output: 700, reasoning: 20, cache: { read: 4000, write: 100 } },
  time: { created: Date.parse('2026-09-15T08:00:00Z'), updated: 1 },
  location: { directory: '/home' },
};
const contextData = [
  {
    type: 'compaction',
    id: 'c1',
    time: { created: 2.5 },
    status: 'completed',
    reason: 'auto',
    summary: 'everything before',
    recent: '',
  },
  { type: 'user', id: 'u2', time: { created: 3 }, text: 'more' },
  {
    type: 'assistant',
    id: 'a2',
    agent: 'assistant',
    model: { providerID: 'github-copilot', id: 'gpt-5.2', variant: 'high' },
    time: { created: 4, completed: 5 },
    content: [{ type: 'text', text: 'sure' }],
    tokens: { input: 800, output: 200, reasoning: 50, cache: { read: 500, write: 0 } },
  },
];
const pluginData = [
  { id: 'opencode.tools', source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } },
  {
    id: 'opencode-attribution',
    source: { type: 'package', target: 'opencode-attribution', version: '0.2.0' },
    features: { server: true },
    state: { status: 'active' },
  },
  {
    id: 'aivi',
    source: { type: 'package', target: 'file:/opt/aivi/packages/opencode', version: '0.3.1' },
    features: { server: true },
    state: { status: 'active' },
  },
  {
    id: 'broken',
    source: { type: 'package', target: 'broken-plugin', version: '9.9.9' },
    features: { server: true },
    state: { status: 'failed', error: 'it exploded' },
  },
];

test('/context describes the bound session from OpenCode: window, plugins, totals, scope, pending work', async t => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/session/ses_x') {
      res.end(JSON.stringify({ data: sessionData }));
      return;
    }
    if (url.pathname === '/api/session/ses_x/context') {
      res.end(JSON.stringify({ data: contextData }));
      return;
    }
    if (url.pathname === '/api/plugin') {
      res.end(JSON.stringify({ data: pluginData }));
      return;
    }
    if (url.pathname === '/api/model') {
      res.end(
        JSON.stringify({
          location: { directory: '/home', project: { id: 'p', directory: '/home', canonical: '/home' } },
          data: [
            {
              id: 'github-copilot/gpt-5.2',
              providerID: 'github-copilot',
              modelID: 'gpt-5.2',
              name: 'GPT 5.2',
              limit: { context: 128_000, output: 16_000 },
              compaction: { mode: 'provider', threshold: 100_000 },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = await connectOpenCode({ url: `http://127.0.0.1:${address.port}`, lifecycle: 'discover' }, {});

  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');

  // Before any session: says what the first message would start, and what is in scope.
  const fresh = await describeConversation(store, 'dm-a', binding, loaded, async () => client);
  assert.match(fresh, /^🧠 \*\*Context\*\* · no session yet\n.*agent `assistant` in `\/home`\./);
  assert.match(fresh, /2 core sources · projects: demo/, 'removed projects are not in scope');
  assert.ok(!fresh.includes('**Plugins**'), 'a session-less conversation shows no plugin claims');

  store.adopt('dm-a', { session: 'ses_x', agent: 'assistant', directory: '/home' });
  store.enqueue({ id: 't1', channel: 'dm-a', user: 'u', name: 'Bob', text: 'later' }, 10);
  const text = await describeConversation(store, 'dm-a', binding, loaded, async () => client);
  // The window is the last call's prompt (input + cache) plus its output: 800 + 500 + 200 = 1,500 of 128,000.
  // The totals come from the session object, not a transcript walk; the context's
  // leading compaction message is what says "compacted".
  assert.deepEqual(text.split('\n'), [
    '🧠 **Context** · `assistant` in `/home`',
    'Model `github-copilot/gpt-5.2 (high)` · window 128,000 tokens',
    'In use 1,500 / 128,000 (1%)',
    '░░░░░░░░░░░░░░░░░░░░░░░░',
    'Headroom 126,500 tokens · compacted',
    'Billed $0.0012',
    'Input 3,000 · Output 700 · Reasoning 20 · Cache read 4,000 / written 100',
    '_Totals are lifetime throughput, not context size: each answer re-sends the window above._',
    '',
    '**Plugins**',
    '- opencode-attribution (v0.2.0)',
    '- aivi (v0.3.1): file:/opt/aivi/packages/opencode',
    '- broken (v9.9.9): broken-plugin — failed: it exploded',
    '',
    '**Knowledge in scope** 2 core sources · projects: demo',
    '1 pending turn here: queued.',
  ]);
});

/** The three reads `/context` makes, answered from the fixtures above unless a test says otherwise. */
const wire = (reads: {
  session?: Record<string, unknown>;
  context?: unknown[];
  plugins?: () => Promise<unknown>;
  models?: () => Promise<unknown>;
}) =>
  ({
    session: {
      get: async () => ({ ...sessionData, ...reads.session }),
      context: async () => reads.context ?? contextData,
    },
    plugin: { list: reads.plugins ?? (async () => ({ data: pluginData })) },
    model: {
      list:
        reads.models ??
        (async () => ({ data: [{ providerID: 'github-copilot', modelID: 'gpt-5.2', limit: { context: 128_000 } }] })),
    },
  }) as unknown as OpenCodeClient;
const answered = (model: Record<string, string>) => [
  {
    type: 'assistant',
    id: 'a1',
    model,
    tokens: { input: 800, output: 200, reasoning: 0, cache: { read: 500, write: 0 } },
  },
];
const linesOf = async (client: OpenCodeClient, scope = loaded) =>
  (await describeSession(client, 'ses_x', scope)).split('\n');

test('the plugin section lists what OpenCode loaded beyond its built-ins, and says so when it cannot tell', async () => {
  const refused = async () => {
    throw new Error('connection refused');
  };
  const builtin = { id: 'opencode.tools', source: { type: 'builtin' }, state: { status: 'active' } };
  const plugins = [
    builtin,
    {
      id: 'checkout',
      source: { type: 'local', path: join(homedir(), 'checkouts', 'aivi') },
      state: { status: 'active' },
    },
    { id: 'plain', source: { type: 'package', target: 'plain' }, state: { status: 'active' } },
    { source: { type: 'package', target: 'nameless', version: '1.0.0' }, state: { status: 'active' } },
  ];
  const section = async (list: () => Promise<unknown>) => {
    const lines = await linesOf(wire({ plugins: list }));
    return lines.slice(lines.indexOf('') + 1, lines.lastIndexOf(''));
  };

  assert.deepEqual(await section(refused), ['**Plugins** · OpenCode did not answer, so nothing here is claimed']);
  assert.deepEqual(await section(async () => ({ data: [builtin] })), [
    '**Plugins** · none beyond OpenCode’s built-ins — no aivi plugin in this OpenCode',
  ]);
  assert.deepEqual(await section(async () => ({ data: plugins })), [
    '**Plugins**',
    '- checkout: ~/checkouts/aivi',
    '- plain',
    '- unknown (v1.0.0): nameless',
  ]);
});

test('the window section reads the last answer against the model’s limit, and says what it cannot know', async () => {
  const model = { providerID: 'github-copilot', id: 'gpt-5.2' };
  const window = async (reads: Parameters<typeof wire>[0]) => {
    const lines = await linesOf(wire({ session: { cost: 0 }, ...reads }));
    return lines.slice(
      0,
      lines.findIndex(line => line.startsWith('Input ')),
    );
  };
  const header = '🧠 **Context** · `assistant` in `/home`';
  const unbilled = 'Billed: no cost reported by the provider';

  assert.deepEqual(await window({ context: [] }), [header, 'Model none yet', unbilled]);
  assert.deepEqual(await window({ context: answered(model) }), [
    header,
    'Model `github-copilot/gpt-5.2` · window 128,000 tokens',
    'In use 1,500 / 128,000 (1%)',
    '░'.repeat(24),
    'Headroom 126,500 tokens',
    unbilled,
  ]);
  const catalogueDown = async () => {
    throw new Error('connection refused');
  };
  assert.deepEqual(await window({ context: answered(model), models: catalogueDown }), [
    header,
    'Model `github-copilot/gpt-5.2` · window size unknown',
    'In use 1,500 tokens at the last call',
    unbilled,
  ]);
});

test('a conversation bound to an agent that has no session yet says which agent its first message starts', async () => {
  const store = {
    sessionOf: () => ({
      session: 'ses_1',
      ready: false,
      agent: 'developer',
      directory: join(homedir(), 'work'),
      model: null,
      project: null,
      issue: null,
    }),
    list: () => [{ state: 'queued' }, { state: 'running' }, { state: 'sent' }, { state: 'discarded' }],
  } as unknown as ConversationStore;
  const scope = { ...loaded, projects: [], sources: loaded.sources.slice(0, 1) };
  const opencode = async () => {
    throw new Error('without a session there is nothing to ask OpenCode');
  };

  assert.deepEqual((await describeConversation(store, 'dm-a', binding, scope, opencode)).split('\n'), [
    '🧠 **Context** · no session yet',
    'The next message starts one with agent `developer` in `~/work`.',
    '',
    '**Knowledge in scope** 1 core source · no projects',
    '2 pending turns here: queued, running.',
  ]);
});
