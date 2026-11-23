/** The run progress follower: the worker's OpenCode session folded into one
 *  line, edited into the ticket only when the line actually changes, coalesced
 *  inside the throttle window, and silent once stopped. Time is mocked: the
 *  follower's only timers are the throttle's trailing edge and the next
 *  instant the line changes by itself. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { Logger } from '@aivi/core';
import type { ProgressClock } from '@aivi/host';
import type { SessionEventListener, SessionEvents } from '@aivi/plugin/module';
import type { Platform, TrackerProgressLine } from '@aivi/plugin/tracker';
import { RunProgress, type RunProgressOptions } from '../src/runprogress.ts';

const START = 1_000_000;
/** Nothing changes on its own: every line a test sees is an event's doing, unless it shrinks these. */
const QUIET: ProgressClock = { longMs: 3_600_000, idleMs: 3_600_000, refreshMs: 3_600_000 };
const LONG_AT_5S: ProgressClock = { ...QUIET, longMs: 5_000 };
/** One turn of the event loop: every promise the follower queued has run. */
const drained = () => new Promise<void>(resolve => setImmediate(resolve));

type Options = Partial<RunProgressOptions> & { surface?: boolean };

/** A follower over a platform that records its edits and an event source the test drives by hand;
 *  `surface: false` is a platform that shows no progress at all. */
function follow(t: TestContext, { surface = true, ...options }: Options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  let listener: SessionEventListener | undefined;
  const unwatch = t.mock.fn();
  const watch = t.mock.fn((_sessionID: string, next: SessionEventListener) => {
    listener = next;
    return unwatch;
  });
  const progress = t.mock.fn(async (_conversation: string, _line: TrackerProgressLine) => {});
  const warn = t.mock.fn();
  const platform = (surface ? { progress } : {}) as unknown as Platform;
  const follower = new RunProgress(platform, 'github:acme/shop#1:c9', 'ses-1', {
    mode: 'tools',
    events: { watch } as SessionEvents,
    log: { warn } as unknown as Logger,
    clock: QUIET,
    ...options,
  });
  return {
    follower,
    progress,
    warn,
    watch,
    unwatch,
    emit: (type: string, data: Record<string, unknown> = {}) => listener!({ type, data }),
    posted: () => progress.mock.calls.map(call => call.arguments[1]),
  };
}

/** A follower that posts every change at once: no throttle window unless the test asks for one. */
const eager = (t: TestContext, options: Options = {}) => follow(t, { throttleMs: 0, ...options });

test('a running tool is offered as a tool with its detail, and the line after it as a plain thought', async t => {
  const { follower, emit, posted } = eager(t);
  follower.start();
  emit('session.tool.input.started', { id: 't1', name: 'read' });
  emit('session.tool.called', { id: 't1', input: { filePath: '/repo/src/index.ts' } });
  emit('session.tool.success', { id: 't1' });
  await drained();
  assert.deepEqual(posted(), [
    { text: '🔧 reading', tool: { name: 'read' } },
    { text: '🔧 reading index.ts', tool: { name: 'read', detail: 'index.ts' } },
    { text: '⏳ thinking…' },
  ]);
  await follower.stop();
});

test('in status mode a running tool stays inside the line and is not offered as a tool', async t => {
  const { follower, emit, posted } = eager(t, { mode: 'status' });
  follower.start();
  emit('session.tool.input.started', { id: 't1', name: 'bash' });
  await drained();
  assert.deepEqual(posted(), [{ text: '🔧 running' }]);
  await follower.stop();
});

test('an event that leaves the line as it was posts nothing', async t => {
  const { follower, emit, posted } = eager(t);
  follower.start();
  emit('session.step.started');
  await drained();
  assert.deepEqual(posted(), []);
  await follower.stop();
});

test('the first change is posted at once, and later ones inside the window coalesce into one trailing post', async t => {
  const { follower, emit, posted } = follow(t, { throttleMs: 1_000 });
  follower.start();
  emit('session.tool.input.started', { id: 't1', name: 'read' });
  await drained();
  assert.equal(posted().length, 1, 'the first change goes at once');

  t.mock.timers.tick(100);
  emit('session.tool.called', { id: 't1', input: { filePath: '/repo/src/index.ts' } });
  emit('session.tool.success', { id: 't1' });
  t.mock.timers.tick(899);
  await drained();
  assert.equal(posted().length, 1, 'inside the window nothing more is posted');

  t.mock.timers.tick(1);
  await drained();
  assert.deepEqual(
    posted().map(line => line.text),
    ['🔧 reading', '⏳ thinking…'],
    'one post for everything since: the latest state, not the one in between',
  );
  await follower.stop();
});

test('by default the follower edits at most once in two seconds', async t => {
  const { follower, emit, posted } = follow(t);
  follower.start();
  emit('session.tool.input.started', { id: 't1', name: 'read' });
  await drained();
  t.mock.timers.tick(1_999);
  emit('session.tool.success', { id: 't1' });
  await drained();
  assert.equal(posted().length, 1, 'inside two seconds of the last edit: held back');

  t.mock.timers.tick(1);
  await drained();
  assert.equal(posted().length, 2, 'two seconds after it: posted');
  await follower.stop();
});

test('the line changes by itself at the long-turn mark: the follower waits for that instant and posts then', async t => {
  const { follower, posted } = eager(t, { clock: LONG_AT_5S });
  follower.start();
  t.mock.timers.tick(4_999);
  await drained();
  assert.deepEqual(posted(), [], 'nothing changed yet, and nobody polled');

  t.mock.timers.tick(1);
  await drained();
  assert.deepEqual(posted(), [{ text: '⏳ thinking… · 5s' }]);
  await follower.stop();
});

test('stopping drops an edit still queued, unwatches, and silences a late event', async t => {
  const { follower, emit, posted, unwatch } = eager(t);
  follower.start();
  emit('session.tool.input.started', { id: 't1', name: 'read' }); // queues the first edit
  await follower.stop(); // before the queued edit ran
  assert.equal(unwatch.mock.callCount(), 1);
  assert.deepEqual(posted(), [], 'the queued edit is dropped, not posted after the stop');

  emit('session.tool.success', { id: 't1' }); // an event already on its way when the stop landed
  await drained();
  assert.deepEqual(posted(), []);
});

test('a stopped follower resumes with its history: the elapsed time keeps counting', async t => {
  const { follower, emit, watch, posted } = eager(t, { clock: LONG_AT_5S });
  follower.start();
  await follower.stop();
  t.mock.timers.tick(7_000); // the worker worked on while nobody followed
  follower.start();
  emit('session.text.delta');
  await drained();
  assert.equal(watch.mock.callCount(), 2);
  assert.deepEqual(posted(), [{ text: '✍️ writing the answer · 7s' }]);
  await follower.stop();
});

test('a failed edit is logged, and the next change is still posted', async t => {
  const failure = new Error('GitHub is down');
  const { follower, emit, progress, warn } = eager(t);
  progress.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  follower.start();
  emit('session.tool.input.started', { id: 't1', name: 'read' });
  emit('session.tool.success', { id: 't1' });
  await drained();
  assert.deepEqual(
    warn.mock.calls.map(call => call.arguments),
    [['progress.edit.failed', { error: failure }]],
  );
  assert.equal(progress.mock.callCount(), 2, 'the stream goes on after a failed edit');
  await follower.stop();
});

test('a follower is started once, and never on a platform with no progress surface', async t => {
  await t.test('starting twice watches once', async t => {
    const { follower, watch } = eager(t);
    follower.start();
    follower.start();
    assert.equal(watch.mock.callCount(), 1);
    await follower.stop();
  });
  await t.test('a platform with no progress surface is never watched', async t => {
    const { follower, watch } = eager(t, { surface: false });
    follower.start();
    assert.equal(watch.mock.callCount(), 0);
  });
});
