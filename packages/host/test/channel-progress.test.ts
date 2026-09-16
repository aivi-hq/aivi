import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import type { ChannelPlatform } from '../src/channel/contract.ts';
import { ChannelEngine } from '../src/channel/engine.ts';
import {
  DEFAULT_CLOCK,
  describeToolCall,
  formatDuration,
  nextRenderChange,
  type Progress,
  reduceProgress,
  renderProgress,
  startProgress,
} from '../src/channel/progress.ts';
import { ConversationStore } from '../src/channel/store.ts';
import type { SessionEvent, SessionEventListener, SessionEvents } from '../src/events.ts';
import { Store } from '../src/store.ts';

const platform: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
const limits = { resource: 'local-model', maxConcurrent: 1, turnTimeoutMs: 300_000 };
const scheduler = configSchema.parse({ version: 1 }).scheduler;
const S = 'ses_discord_a';
const ev = (type: string, data: Record<string, unknown> = {}): SessionEvent => ({
  type,
  data: { sessionID: S, ...data },
});
const fold = (events: SessionEvent[], from = startProgress(0), at = 1) =>
  events.reduce((state, event) => reduceProgress(state, event, at), from);

test('session.tool.progress names the aivi tools a codemode execute runs and tracks their status; no code parsing needed', () => {
  let state = startProgress(0);
  state = fold([ev('session.tool.input.started', { id: 'c1', name: 'execute' })], state, 100);
  state = fold(
    [ev('session.tool.progress', { id: 'c1', metadata: { toolCalls: [{ tool: 'aivi.context', status: 'running' }] } })],
    state,
    200,
  );
  assert.deepEqual(state.tools, [{ id: 'c1', name: 'aivi.context', state: 'running' }]);
  assert.equal(renderProgress(state, 'status', 200), '🔧 reading the context');
  state = fold(
    [
      ev('session.tool.progress', {
        id: 'c1',
        metadata: {
          toolCalls: [
            { tool: 'aivi.context', status: 'completed' },
            { tool: 'knowledge.search', status: 'running' },
          ],
        },
      }),
    ],
    state,
    300,
  );
  assert.equal(renderProgress(state, 'status', 300), '🔧 searching knowledge');
  state = fold([ev('session.tool.success', { id: 'c1' })], state, 400);
  assert.deepEqual(
    state.tools.map(t => [t.name, t.state]),
    [
      ['aivi.context', 'done'],
      ['knowledge.search', 'done'],
    ],
  );
  assert.equal(state.phase, 'thinking');
});

test('tool names: codemode execute shows the aivi tools its code calls; native tools carry a short detail', () => {
  assert.deepEqual(
    describeToolCall('execute', {
      code: 'const s = await tools.aivi.status();\nreturn tools.knowledge.search({ query: "working agreements", limit: 3 });',
    }),
    [{ name: 'aivi.status' }, { name: 'knowledge.search', detail: '"working agreements"' }],
  );
  assert.deepEqual(describeToolCall('execute', { code: 'return 1 + 1;' }), [{ name: 'execute' }]);
  assert.deepEqual(describeToolCall('execute', { code: 'return await tools.aivi["context"]();' }), [
    { name: 'aivi.context' },
  ]);
  assert.deepEqual(describeToolCall('execute', { code: 'return await tools["knowledge"]["projects"]()' }), [
    { name: 'knowledge.projects' },
  ]);
  assert.deepEqual(
    describeToolCall('execute', {
      code: 'const { aivi, knowledge: k } = tools;\nawait aivi.status();\nreturn k.search({ query: "leave" });',
    }),
    [{ name: 'aivi.status' }, { name: 'knowledge.search', detail: '"leave"' }],
  );
  assert.deepEqual(describeToolCall('execute', {}), [{ name: 'execute' }]);
  assert.deepEqual(describeToolCall('execute', { code: 'await tools.browser.tabs.open({ url: "x" })' }), [
    { name: 'browser.tabs.open' },
  ]);
  assert.deepEqual(describeToolCall('read', { filePath: '/home/k/handbook.md' }), [
    { name: 'read', detail: 'handbook.md' },
  ]);
  assert.deepEqual(describeToolCall('grep', { pattern: 'TODO', path: '/x' }), [{ name: 'grep', detail: 'TODO' }]);
  assert.deepEqual(describeToolCall('glob', { pattern: '**/*.md' }), [{ name: 'glob', detail: '**/*.md' }]);
  assert.deepEqual(describeToolCall('webfetch', { url: 'https://example.com/a/b?c' }), [
    { name: 'webfetch', detail: 'example.com' },
  ]);
  assert.deepEqual(describeToolCall('bash', { command: `${'x'.repeat(50)}\necho` }), [
    { name: 'bash', detail: `${'x'.repeat(39)}…` },
  ]);
  assert.deepEqual(describeToolCall('todowrite', { todos: [] }), [{ name: 'todowrite' }]);
});

test('the reducer follows a turn through thinking, tools and writing; the renderer has two modes and a long-turn suffix', () => {
  let state = startProgress(0);
  assert.equal(renderProgress(state, 'status', 1000), '⏳ thinking…');
  state = fold([ev('session.execution.started'), ev('session.step.started')], state);
  assert.equal(state.phase, 'thinking');
  state = fold([ev('session.tool.input.started', { id: 't1', name: 'execute' })], state, 2000);
  assert.equal(
    renderProgress(state, 'status', 2000),
    '⏳ thinking…',
    'a codemode execute has no name of its own yet; showing "execute" would be the only thing seen before the throttle',
  );
  assert.equal(renderProgress(state, 'tools', 2000), '⏳ thinking…');
  state = fold(
    [
      ev('session.tool.called', {
        id: 't1',
        input: { code: 'return tools.knowledge.search({ query: "leave policy" })' },
      }),
    ],
    state,
    3000,
  );
  assert.deepEqual(state.tools, [{ id: 't1', name: 'knowledge.search', detail: '"leave policy"', state: 'running' }]);
  assert.equal(renderProgress(state, 'status', 3000), '🔧 searching knowledge "leave policy"');
  state = fold(
    [
      ev('session.tool.success', { id: 't1' }),
      ev('session.tool.input.started', { id: 't2', name: 'read' }),
      ev('session.tool.called', { id: 't2', input: { filePath: '/k/handbook.md' } }),
      ev('session.tool.input.started', { id: 't3', name: 'webfetch' }),
      ev('session.tool.called', { id: 't3', input: { url: 'https://example.com/x' } }),
      ev('session.tool.failed', { id: 't3', error: { message: 'boom' } }),
    ],
    state,
    4000,
  );
  assert.equal(state.phase, 'tool', 'read is still running');
  assert.equal(renderProgress(state, 'status', 4000), '🔧 reading handbook.md');
  assert.equal(
    renderProgress(state, 'tools', 4000),
    [
      '🔧 reading handbook.md',
      '✓ knowledge.search "leave policy"',
      '… read handbook.md',
      '✗ webfetch example.com',
    ].join('\n'),
  );
  state = fold([ev('session.text.started'), ev('session.text.delta', { delta: 'x' })], state, 5000);
  assert.equal(state.phase, 'tool', 'text while a tool runs does not mean the answer is being written');
  state = fold([ev('session.tool.success', { id: 't2' }), ev('session.text.started')], state, 6000);
  assert.equal(state.phase, 'writing');
  assert.equal(renderProgress(state, 'status', 6000), '✍️ writing the answer');
  assert.equal(
    renderProgress({ ...state, lastActivityAt: 79_000 }, 'status', 80_000),
    '✍️ writing the answer · 3 tools · 1m 20s',
  );
  assert.equal(renderProgress(startProgress(0), 'status', 25_000), '⏳ thinking… · 25s');
  const one = fold([ev('session.tool.input.started', { id: 'a', name: 'bash' })], startProgress(0), 1);
  assert.equal(renderProgress(one, 'status', 21_000), '🔧 running · 1 tool · 21s');
  // Silence: nothing for 30 s says so, whatever the phase; the list stays in tools mode, capped at eight.
  assert.equal(renderProgress(state, 'status', 6000 + 30_000), '⏳ still working (36s)…');
  const many: Progress = {
    ...startProgress(0),
    tools: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, name: `tool${i}`, state: 'done' as const })),
    lastActivityAt: 0,
  };
  const lines = renderProgress(many, 'tools', 130_000).split('\n');
  assert.equal(lines[0], '⏳ still working (2m 10s)…');
  assert.deepEqual(
    lines.slice(1),
    Array.from({ length: 8 }, (_, i) => `✓ tool${i + 2}`),
  );
  assert.equal(reduceProgress(state, ev('session.usage.updated'), 7000).lastActivityAt, 7000, 'any event is activity');
  assert.equal(formatDuration(3_725_000), '1h 2m');
  assert.equal(formatDuration(120_000), '2m');
  // Without events the text changes at known instants only: the suffix, the idle notice, then each refresh.
  const fresh = { ...startProgress(1000), lastActivityAt: 5000 };
  assert.equal(nextRenderChange(fresh, 5000), 21_000, 'the long-turn suffix');
  assert.equal(nextRenderChange(fresh, 21_000), 31_000, 'the elapsed time refreshes every 30 s from the start');
  assert.equal(nextRenderChange(fresh, 31_000), 35_000, 'the idle notice comes before the next refresh mark');
  assert.equal(nextRenderChange(fresh, 35_000), 61_000);
  assert.equal(nextRenderChange(fresh, 61_000, { ...DEFAULT_CLOCK, refreshMs: 10_000 }), 71_000);
});

function fakeEvents() {
  const listeners = new Map<string, Set<SessionEventListener>>();
  const events: SessionEvents = {
    watch(sessionID, listener) {
      const set = listeners.get(sessionID) ?? new Set();
      listeners.set(sessionID, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
  };
  return {
    events,
    emit: (event: SessionEvent) => {
      for (const listener of listeners.get(event.data!.sessionID!) ?? []) listener(event);
    },
    watching: (sessionID: string) => (listeners.get(sessionID)?.size ?? 0) > 0,
  };
}
/** A platform that can edit and delete; `log` records every call in order. */
function fakeDelivery(options: { editable?: boolean; deletable?: boolean; failSend?: boolean } = {}) {
  const log: string[] = [];
  let n = 0;
  return {
    log,
    delivery: {
      async send(_conversation: string, text: string) {
        if (options.failSend) throw new Error('send failed');
        log.push(`send:${text}`);
        return `m${++n}`;
      },
      ...(options.editable === false
        ? {}
        : {
            async edit(_c: string, id: string, text: string) {
              log.push(`edit:${id}:${text}`);
            },
          }),
      ...(options.deletable === false
        ? {}
        : {
            async delete(_c: string, id: string) {
              log.push(`delete:${id}`);
            },
          }),
    },
  };
}
const tickAsync = () => new Promise(r => setTimeout(r, 5));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const enqueue = (store: ConversationStore, id: string, channel = 'dm') => {
  store.enqueue({ id, channel, user: 'u', name: 'N', text: 'q' }, 10);
  return store.list().find(t => t.id === id)!.session;
};

test('progress: a placeholder is posted, edited at most once per window, and replaced by the reply; silent posts none', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  const session = enqueue(store, 'one');
  const { events, emit, watching } = fakeEvents();
  const { delivery, log } = fakeDelivery();
  let release!: () => void;
  const answer = new Promise<string>(resolve => {
    release = () => resolve('The answer');
  });
  const engine = new ChannelEngine(store, limits, scheduler, () => answer, delivery, {
    progress: { mode: 'tools', events, throttleMs: 100 },
  });
  engine.tick();
  await tickAsync();
  assert.deepEqual(log, ['send:⏳ thinking…'], 'the placeholder is posted when the turn starts');
  assert.ok(watching(session), 'the turn watches its session');
  const e = (type: string, data: Record<string, unknown> = {}) => emit({ type, data: { sessionID: session, ...data } });
  // The placeholder opens the first window: a burst right after it coalesces into one trailing edit …
  e('session.tool.input.started', { id: 't1', name: 'read' });
  e('session.tool.called', { id: 't1', input: { filePath: '/k/handbook.md' } });
  e('session.tool.success', { id: 't1' });
  e('session.tool.input.started', { id: 't2', name: 'execute' });
  e('session.tool.called', { id: 't2', input: { code: 'return await tools.aivi.status();' } });
  await tickAsync();
  assert.equal(log.length, 1, 'no edit inside the window');
  await sleep(150);
  assert.equal(log.length, 2, 'one trailing edit carries the whole burst');
  assert.equal(log[1], 'edit:m1:🔧 checking status\n✓ read handbook.md\n… aivi.status');
  // … and once the window has passed, the next event is shown at once (leading edge).
  await sleep(120);
  e('session.tool.success', { id: 't2' });
  e('session.text.started');
  await tickAsync();
  assert.equal(log[2], 'edit:m1:⏳ thinking…\n✓ read handbook.md\n✓ aivi.status');
  await sleep(150);
  assert.equal(log[3], 'edit:m1:✍️ writing the answer\n✓ read handbook.md\n✓ aivi.status');
  release();
  await engine.drain();
  assert.deepEqual(log.slice(4), ['send:The answer', 'delete:m1'], 'the reply is posted, then the placeholder goes');
  assert.ok(!watching(session), 'the watch is released');
  assert.equal(store.list()[0]!.state, 'sent');

  // Without delete the placeholder becomes the first chunk; the rest follows as new messages.
  const noDelete = fakeDelivery({ deletable: false });
  const session2 = enqueue(store, 'two');
  const engine2 = new ChannelEngine(
    store,
    { ...limits, turnTimeoutMs: 1000 },
    scheduler,
    async () => `${'a'.repeat(1900)}tail`,
    noDelete.delivery,
    { progress: { mode: 'status', events, throttleMs: 100 } },
  );
  engine2.tick();
  await engine2.drain();
  assert.deepEqual(noDelete.log, ['send:⏳ thinking…', `edit:m1:${'a'.repeat(1900)}`, 'send:tail']);
  assert.ok(!watching(session2));

  // Silent, or a platform without edit, is today's behaviour: the reply and nothing else.
  for (const [mode, options] of [
    ['silent', {}],
    ['status', { editable: false }],
  ] as const) {
    const plain = fakeDelivery(options);
    enqueue(store, `plain-${mode}`);
    const engine3 = new ChannelEngine(store, limits, scheduler, async () => 'Reply', plain.delivery, {
      progress: { mode, events },
    });
    engine3.tick();
    await engine3.drain();
    assert.deepEqual(plain.log, ['send:Reply'], mode);
  }
});

test('progress: a turn that cannot finish edits the placeholder into the notice instead of posting another message', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  enqueue(store, 'one');
  const { events } = fakeEvents();
  const { delivery, log } = fakeDelivery();
  const engine = new ChannelEngine(
    store,
    limits,
    scheduler,
    async () => {
      throw new Error('lost after prompt');
    },
    delivery,
    { progress: { mode: 'status', events } },
  );
  engine.tick();
  await engine.drain();
  assert.equal(log.length, 2);
  assert.equal(log[0], 'send:⏳ thinking…');
  assert.match(log[1]!, /^edit:m1:Something went wrong \(/);
  assert.equal(store.list()[0]!.state, 'discarded', 'a chat turn that cannot finish fails and is told');

  // Without any event the text still moves at the known instants: the suffix, then the idle notice.
  const slow = fakeDelivery();
  enqueue(store, 'two', 'dm-b');
  // The failed first turn released its capacity and the channel is free; nothing to resolve.
  let release!: () => void;
  const answer = new Promise<string>(resolve => {
    release = () => resolve('done');
  });
  const engine2 = new ChannelEngine(store, limits, scheduler, () => answer, slow.delivery, {
    progress: { mode: 'status', events, throttleMs: 10, clock: { longMs: 60, idleMs: 200, refreshMs: 60 } },
  });
  engine2.tick();
  await sleep(120);
  assert.match(slow.log.at(-1)!, /^edit:m1:⏳ thinking… · \ds$/);
  await sleep(200);
  assert.match(slow.log.at(-1)!, /^edit:m1:⏳ still working \(\ds\)…$/);
  release();
  await engine2.drain();
  assert.deepEqual(slow.log.slice(-2), ['send:done', 'delete:m1']);
});
