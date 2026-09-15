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
  path: '/aivi.json',
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
  assert.match(fresh, /^No session yet; the next message starts one with agent librarian in \/home\./m);
  assert.match(fresh, /2 core source\(s\), projects demo\./, 'removed projects are not in scope');

  store.adopt('dm-a', { session: 'ses_x', agent: 'librarian', directory: '/home' });
  store.enqueue({ id: 't1', channel: 'dm-a', user: 'u', name: 'Bob', text: 'later' }, 10);
  const text = await describeConversation(store, 'dm-a', binding, loaded, async () => client);
  assert.deepEqual(text.split('\n'), [
    'Session ses_x since 2026-09-15 08:00 UTC, agent librarian in /home.',
    'Model: github-copilot/gpt-5.2 (high).',
    '2 message(s) from people, 2 answer(s); 2,550 tokens (2,000 in, 500 out, 50 reasoning; cache 1,000 read / 500 written), $0.0012.',
    'Knowledge in scope: 2 core source(s), projects demo.',
    '1 pending turn(s): queued.',
  ]);
});
