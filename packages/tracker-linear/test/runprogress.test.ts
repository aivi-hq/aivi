/** The run progress follower: the worker's OpenCode session folded into one
 *  transient line, posted only when the line actually changes, silent while
 *  parked, and mute forever on a platform that shows no progress. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLogger } from '@aivi/core';
import type { SessionEvent, SessionEventListener, SessionEvents } from '@aivi/plugin/module';
import type { Platform, TrackerProgressLine } from '@aivi/plugin/tracker';
import { recorder } from '../../host/test/support.ts';
import { RunProgress } from '../src/runprogress.ts';

class FakeEvents implements SessionEvents {
  private readonly listeners = new Map<string, SessionEventListener>();
  emit(sessionID: string, event: SessionEvent): void {
    this.listeners.get(sessionID)?.(event);
  }
  watch(sessionID: string, listener: SessionEventListener): () => void {
    this.listeners.set(sessionID, listener);
    return () => {
      if (this.listeners.get(sessionID) === listener) this.listeners.delete(sessionID);
    };
  }
  get watched(): boolean {
    return this.listeners.size > 0;
  }
}

const log = getLogger(['test']);
/** Nothing changes on its own: every posted line in these tests is an event's doing. */
const SLOW_CLOCK = { longMs: 3_600_000, idleMs: 3_600_000, refreshMs: 3_600_000 };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function follow(events: FakeEvents, mode: 'status' | 'tools', lines: TrackerProgressLine[]): RunProgress {
  const platform = {
    async progress(_conversation: string, line: TrackerProgressLine): Promise<void> {
      lines.push(line);
    },
  } as unknown as Platform;
  return new RunProgress(platform, 'dev:as-1', 'ses-1', { mode, events, log, throttleMs: 0, clock: SLOW_CLOCK });
}

test('a running tool is offered as a tool, and the line after it as a plain thought', async () => {
  const events = new FakeEvents();
  const lines: TrackerProgressLine[] = [];
  const follower = follow(events, 'tools', lines);
  follower.start();
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't1', name: 'read' } });
  await settle();
  assert.equal(lines.length, 1, 'the tool opening changes the line once');
  assert.equal(lines[0]!.tool?.name, 'read');
  assert.match(lines[0]!.text, /reading/);
  events.emit('ses-1', { type: 'session.tool.success', data: { id: 't1' } });
  await settle();
  assert.equal(lines.length, 2, 'the tool ending changes it once more');
  assert.equal(lines[1]!.tool, undefined, 'nothing running: a thought line, no tool');
  await follower.stop();
});

test('the stream says each moment once: events that change nothing post nothing', async () => {
  const events = new FakeEvents();
  const lines: TrackerProgressLine[] = [];
  const follower = follow(events, 'status', lines);
  follower.start();
  events.emit('ses-1', { type: 'session.step.started', data: {} });
  await settle();
  assert.equal(lines.length, 0, 'still thinking: the same line, said zero times');
  await follower.stop();
});

test('stop falls silent and start resumes with the history kept', async () => {
  const events = new FakeEvents();
  const lines: TrackerProgressLine[] = [];
  const follower = follow(events, 'tools', lines);
  follower.start();
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't1', name: 'read' } });
  await settle();
  assert.equal(lines.length, 1);
  await follower.stop();
  assert.equal(events.watched, false, 'the parked follower watches nothing');
  events.emit('ses-1', { type: 'session.text.delta', data: {} });
  await settle();
  assert.equal(lines.length, 1, 'nothing is posted while stopped');
  follower.start();
  assert.equal(events.watched, true, 'the answer resumes the same follower');
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't2', name: 'bash' } });
  await settle();
  assert.equal(lines.length, 2, 'and work shows again');
  await follower.stop();
});

test('a platform with no progress surface is never even watched', async () => {
  const events = new FakeEvents();
  const follower = new RunProgress({} as unknown as Platform, 'dev:as-1', 'ses-1', {
    mode: 'tools',
    events,
    log,
    throttleMs: 0,
    clock: SLOW_CLOCK,
  });
  follower.start();
  assert.equal(events.watched, false, 'silence is the contract, not a fallback');
});

/** A platform whose every line is kept, and `arrival()` the moment the next one lands. */
function recording() {
  const lines: TrackerProgressLine[] = [];
  const waiting: PromiseWithResolvers<void>[] = [];
  const platform = {
    async progress(_conversation: string, line: TrackerProgressLine): Promise<void> {
      lines.push(line);
      waiting.shift()?.resolve();
    },
  } as unknown as Platform;
  const arrival = () => {
    const next = Promise.withResolvers<void>();
    waiting.push(next);
    return next.promise;
  };
  return { lines, platform, arrival };
}

test('a line that changes inside the throttle window waits for the window’s end, and says the last state once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const events = new FakeEvents();
  const { lines, platform, arrival } = recording();
  const follower = new RunProgress(platform, 'dev:as-1', 'ses-1', { mode: 'tools', events, log, clock: SLOW_CLOCK });
  follower.start();
  const first = arrival();
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't1', name: 'read' } });
  await first;
  events.emit('ses-1', { type: 'session.tool.success', data: { id: 't1' } });
  events.emit('ses-1', { type: 'session.text.delta', data: {} });
  assert.equal(lines.length, 1, 'the first line went at once; the rest wait for the window to close');
  const second = arrival();
  t.mock.timers.tick(2_000);
  await second;
  assert.deepEqual(lines, [{ text: '🔧 reading', tool: { name: 'read' } }, { text: '✍️ writing the answer' }]);
  await follower.stop();
});

test('a long turn’s line changes by itself when it crosses its threshold, with no event to say so', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { lines, platform, arrival } = recording();
  const follower = new RunProgress(platform, 'dev:as-1', 'ses-1', {
    mode: 'status',
    events: new FakeEvents(),
    log,
    throttleMs: 0,
    clock: { longMs: 1_000, idleMs: 3_600_000, refreshMs: 3_600_000 },
  });
  follower.start();
  const posted = arrival();
  t.mock.timers.tick(1_000);
  await posted;
  assert.deepEqual(lines, [{ text: '⏳ thinking… · 1s' }]);
  await follower.stop();
});

test('a status-mode follower keeps a running tool inside its one line; a tool with a detail offers it as a tool', async () => {
  const status = recording();
  const events = new FakeEvents();
  const follower = new RunProgress(status.platform, 'dev:as-1', 'ses-1', {
    mode: 'status',
    events,
    log,
    throttleMs: 0,
    clock: SLOW_CLOCK,
  });
  follower.start();
  let landed = status.arrival();
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't1', name: 'read' } });
  await landed;
  await follower.stop();
  assert.deepEqual(status.lines, [{ text: '🔧 reading' }]);

  const tools = recording();
  const toolEvents = new FakeEvents();
  const detailed = new RunProgress(tools.platform, 'dev:as-1', 'ses-1', {
    mode: 'tools',
    events: toolEvents,
    log,
    throttleMs: 0,
    clock: SLOW_CLOCK,
  });
  detailed.start();
  landed = tools.arrival();
  toolEvents.emit('ses-1', {
    type: 'session.tool.called',
    data: { id: 't1', name: 'read', input: { filePath: '/src/header.ts' } },
  });
  await landed;
  await detailed.stop();
  assert.deepEqual(tools.lines, [{ text: '🔧 reading header.ts', tool: { name: 'read', detail: 'header.ts' } }]);
});

test('an activity the platform refuses is logged and never reaches the worker; one the stop overtakes is never posted', async () => {
  const logged = recorder();
  const events = new FakeEvents();
  const refusing = new RunProgress(
    {
      progress: async () => {
        throw new Error('502');
      },
    } as unknown as Platform,
    'dev:as-1',
    'ses-1',
    { mode: 'tools', events, log: logged.log, throttleMs: 0, clock: SLOW_CLOCK },
  );
  refusing.start();
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't1', name: 'read' } });
  await logged.next('progress.activity.failed');
  await refusing.stop();
  const { lines, platform } = recording();
  const overtaken = new RunProgress(platform, 'dev:as-1', 'ses-1', {
    mode: 'tools',
    events,
    log,
    throttleMs: 0,
    clock: SLOW_CLOCK,
  });
  overtaken.start();
  events.emit('ses-1', { type: 'session.tool.input.started', data: { id: 't2', name: 'bash' } });
  await overtaken.stop();
  assert.deepEqual(lines, [], 'the closing is the last word: nothing is said after the stop');
});
