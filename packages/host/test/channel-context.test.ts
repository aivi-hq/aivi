import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import { describeConversation } from '../src/channel/context.ts';
import type { ChannelPlatform } from '../src/channel/contract.ts';
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
const binding = { agent: 'librarian', directory: '/home' };

test('/context describes the bound session from OpenCode: agent, model, counts, tokens, scope, pending work', async t => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/session/ses_x') {
      res.end(
        JSON.stringify({
          data: {
            id: 'ses_x',
            agent: 'librarian',
            location: { directory: '/home' },
            time: { created: Date.parse('2026-09-15T08:00:00Z'), updated: 1 },
          },
        }),
      );
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
    if (url.pathname === '/api/session/ses_x/message') {
      res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: 'u1', time: { created: 1 }, text: 'hi' },
            {
              type: 'assistant',
              id: 'a1',
              agent: 'librarian',
              model: { providerID: 'github-copilot', id: 'gemini-3.8-flash' },
              time: { created: 2 },
              content: [{ type: 'text', text: 'hello' }],
              tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 1000, write: 0 } },
              cost: 0.0012,
            },
            {
              type: 'compaction',
              id: 'c1',
              time: { created: 2.5 },
              status: 'completed',
              reason: 'auto',
              summary: '',
              recent: '',
            },
            { type: 'user', id: 'u2', time: { created: 3 }, text: 'more' },
            {
              type: 'assistant',
              id: 'a2',
              agent: 'librarian',
              model: { providerID: 'github-copilot', id: 'gpt-5.2', variant: 'high' },
              time: { created: 4 },
              content: [{ type: 'text', text: 'sure' }],
              tokens: { input: 800, output: 200, reasoning: 50, cache: { read: 0, write: 500 } },
            },
          ],
          cursor: { next: null },
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
  assert.match(fresh, /^🧠 \*\*Context\*\* · no session yet\n.*agent `librarian` in `\/home`\./);
  assert.match(fresh, /2 core sources · projects: demo/, 'removed projects are not in scope');

  store.adopt('dm-a', { session: 'ses_x', agent: 'librarian', directory: '/home' });
  store.enqueue({ id: 't1', channel: 'dm-a', user: 'u', name: 'Bob', text: 'later' }, 10);
  const text = await describeConversation(store, 'dm-a', binding, loaded, async () => client);
  // The window is the last call's prompt (input + cache) plus its output: 800 + 500 + 200 = 1,500 of 128,000.
  assert.deepEqual(text.split('\n'), [
    '🧠 **Context** · `librarian` in `/home`',
    'Model `github-copilot/gpt-5.2 (high)` · window 128,000 tokens',
    'In use 1,500 / 128,000 (1%)',
    '░░░░░░░░░░░░░░░░░░░░░░░░',
    'Headroom 126,500 tokens · 1 compaction',
    '',
    '**This session** since 2026-09-15 08:00 UTC · `ses_x`',
    '2 messages · 2 answers',
    'Input 2,000 · Output 500 · Reasoning 50 · Cache read 1,000 / written 500',
    'Billed $0.0012',
    '_Totals are throughput, not context size: each answer re-sends the window above._',
    '',
    '**Knowledge in scope** 2 core sources · projects: demo',
    '1 pending turn here: queued.',
  ]);
});
