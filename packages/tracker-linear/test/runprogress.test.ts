/** The run progress follower: the worker's OpenCode session folded into one
 *  transient line, posted only when the line actually changes, silent while
 *  parked, and mute forever on a platform that shows no progress. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLogger } from '@aivi/core';
import type { SessionEvent, SessionEventListener, SessionEvents } from '@aivi/plugin/module';
import type { Platform, TrackerProgressLine } from '@aivi/plugin/tracker';
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
