/** Dreaming as a unit, over a client the test hands in and a temp directory
 *  for the memory and the state: how conversations are paged and told to the
 *  dreamer, and how the run takes what the disk and the agent do to its files. */
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dreamingArgsSchema } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { collectSessions, dream, readCursor, renderTranscript } from '../src/dreaming.ts';
import { Store } from '../src/store.ts';

const T0 = Date.parse('2026-09-14T10:00:00Z');
const row = (id: string, updated: number, aivi?: Record<string, string>) => ({
  id,
  time: { created: updated - 100, updated },
  ...(aivi ? { metadata: { aivi } } : {}),
});
const said = (created: number, text: string) => ({ type: 'user', id: `u${created}`, time: { created }, text });
const reasoned = (created: number) => ({
  type: 'assistant',
  id: `a${created}`,
  agent: 'dreamer',
  time: { created },
  content: [{ type: 'reasoning', text: 'hmm' }],
});
const answered = (created: number, text: string) => ({
  type: 'assistant',
  id: `a${created}`,
  agent: 'dreamer',
  time: { created },
  content: [{ type: 'text', text }],
});

test('sessions and messages are read page by page; the walk ends at the first session older than the cursor', async t => {
  const sessionPages: Record<string, unknown> = {
    first: {
      data: [row('ses_c', T0 + 30, { origin: 'discord', channel: 'c1' }), row('ses_x', T0 + 25)],
      cursor: { next: 'p2' },
    },
    p2: {
      data: [row('ses_b', T0 + 20, { origin: 'discord' }), row('ses_old', T0 - 1, { origin: 'discord' })],
      cursor: { next: 'p3' },
    },
  };
  const messagePages: Record<string, unknown> = {
    ses_b: { data: [reasoned(T0 + 1000), said(T0 + 2000, 'We deploy on Tuesdays.')], cursor: { next: 'm2' } },
    m2: { data: [answered(T0 + 3000, 'Noted.')], cursor: { next: null } },
    ses_c: { data: [said(T0 + 4000, 'Hello.')], cursor: { next: null } },
  };
  const sessions = t.mock.fn(async (query: { cursor?: string }) => sessionPages[query.cursor ?? 'first']);
  const messages = t.mock.fn(
    async (query: { sessionID: string; cursor?: string }) => messagePages[query.cursor ?? query.sessionID],
  );
  const client = { session: { list: sessions }, message: { list: messages } } as unknown as OpenCodeClient;
  const found = await collectSessions(client, T0, ['discord'], 10, AbortSignal.timeout(2_000));
  assert.deepEqual(
    sessions.mock.calls.map(call => call.arguments[0]),
    [
      { limit: 50, order: 'desc' },
      { limit: 50, cursor: 'p2' },
    ],
    'the walk never asked for the page after the first old session',
  );
  assert.deepEqual(
    messages.mock.calls.map(call => call.arguments[0]),
    [
      { sessionID: 'ses_b', limit: 200, order: 'asc' },
      { sessionID: 'ses_b', limit: 200, cursor: 'm2' },
      { sessionID: 'ses_c', limit: 200, order: 'asc' },
    ],
  );
  assert.deepEqual(found, [
    {
      id: 'ses_b',
      origin: 'discord',
      updated: T0 + 20,
      lines: ['**user** 2026-09-14 10:00\nWe deploy on Tuesdays.', '**dreamer** 2026-09-14 10:00\nNoted.'],
    },
    { id: 'ses_c', origin: 'discord', channel: 'c1', updated: T0 + 30, lines: ['**user** 2026-09-14 10:00\nHello.'] },
  ]);
});

test('a page with nothing on it ends the walk, whatever page it says comes next', async t => {
  const empty = { data: [], cursor: { next: 'again' } };
  const sessions = t.mock.fn(async () => empty);
  const client = {
    session: { list: sessions },
    message: { list: t.mock.fn(async () => empty) },
  } as unknown as OpenCodeClient;
  assert.deepEqual(await collectSessions(client, T0, ['discord'], 10, AbortSignal.timeout(2_000)), []);
  assert.equal(sessions.mock.callCount(), 1);
  const lonely = {
    session: {
      list: t.mock.fn(async () => ({ data: [row('ses_b', T0 + 20, { origin: 'discord' })], cursor: { next: null } })),
    },
    message: { list: t.mock.fn(async () => empty) },
  } as unknown as OpenCodeClient;
  assert.deepEqual(await collectSessions(lonely, T0, ['discord'], 10, AbortSignal.timeout(2_000)), []);
  assert.equal((lonely.message.list as unknown as { mock: { callCount(): number } }).mock.callCount(), 1);
});

test('a transcript names the channel of a session only when it has one, and the beginning when there is no cursor yet', () => {
  const text = renderTranscript([{ id: 'ses_b', origin: 'discord', updated: T0, lines: ['**user** 10:00\nhello'] }], 0);
  assert.match(text, /^# Conversations since the beginning\n/);
  assert.match(text, /\n## ses_b \(discord\) last updated 2026-09-14T10:00:00\.000Z\n\n\*\*user\*\* 10:00\nhello\n$/);
});

test('the dreamer is told which conversation to review, and the run survives an unreadable folder and a transcript the agent already removed', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aivi-dreaming-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, 'memory');
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = dreamingArgsSchema.parse({ directory: root, memoryDirectory: memory, origins: ['discord'] });
  const prompt = t.mock.fn(async ({ text }: { text: string }) => {
    const transcript = /Review the conversation in (\S+\.md):/.exec(text)![1]!;
    await writeFile(join(memory, 'facts.md'), '# Facts\n\n- deploys on Tuesdays\n');
    await writeFile(join(memory, 'proposals', 'idea.md'), 'an idea');
    await rm(transcript);
  });
  const client = {
    session: {
      list: async () => ({ data: [row('ses_b', T0 + 20, { origin: 'discord' })], cursor: { next: null } }),
      get: async () => ({ agent: 'dreamer', location: { directory: root } }),
      update: async () => undefined,
      prompt,
      wait: async () => undefined,
      context: async () => [
        { type: 'user', id: 'msg_aivi_job1-1', time: { created: 1 }, text: 'q' },
        {
          type: 'assistant',
          id: 'a',
          agent: 'dreamer',
          finish: 'stop',
          time: { created: 2, completed: 3 },
          content: [{ type: 'text', text: 'Recorded one fact.' }],
        },
        { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } },
      ],
    },
    message: {
      list: async () => ({
        data: [said(T0 + 2000, 'We deploy on Tuesdays.'), answered(T0 + 3000, 'Noted.')],
        cursor: { next: null },
      }),
    },
    permission: { list: async () => [] },
  } as unknown as OpenCodeClient;
  // The proposals folder cannot be listed; everything else is read as it is.
  const listed = fsPromises.readdir;
  const readdir = t.mock.method(fsPromises, 'readdir', ((path: string, options: never) =>
    String(path).endsWith('/proposals')
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : listed(path, options)) as unknown as typeof fsPromises.readdir);
  syncBuiltinESMExports();
  t.after(() => {
    readdir.mock.restore();
    syncBuiltinESMExports();
  });

  const outcome = await dream(task, 'job-1', {
    store,
    client,
    events: { watch: () => () => {} },
    sessionId: 'ses_aivi_job1',
    stateDirectory: join(root, 'state'),
    signal: AbortSignal.timeout(5_000),
    now: () => T0 + 10_000,
  });
  assert.equal(outcome.state, 'succeeded');
  assert.deepEqual(outcome.result.sessions, ['ses_b']);
  assert.deepEqual(outcome.result.changed, ['facts.md'], 'the folder that could not be read is left out, not fatal');
  assert.match(prompt.mock.calls[0]!.arguments[0].text, /: session ses_b \(discord\), 2 new message\(s\)\./);
  assert.equal(readCursor(store, memory), T0 + 20, 'the cursor stands at the session that was digested');
  assert.deepEqual(await listed(join(root, 'state', 'dreaming')), [], 'the transcript is gone either way');
});
