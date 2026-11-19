import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { SessionEvent, SessionEventListener, SessionEvents } from '@aivi/plugin/module';
import { ProgressPacer } from '../src/channel/pacer.ts';

/** Nothing changes on its own: every delivery in these tests is an event's doing. */
const SLOW_CLOCK = { longMs: 3_600_000, idleMs: 3_600_000, refreshMs: 3_600_000 };
const NOW = 1_000_000;

/** One watched session: `emit` plays an event into the latest listener. */
function session() {
  const unwatch = mock.fn();
  const watch = mock.fn((_session: string, _listener: SessionEventListener) => unwatch);
  const events: SessionEvents = { watch };
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    const event: SessionEvent = { type, data: { sessionID: 'ses_1', ...data } };
    watch.mock.calls.at(-1)!.arguments[1](event);
  };
  return { events, watch, unwatch, emit };
}

test('a changed text is delivered once, with the state it was rendered from, and an unchanged one is not', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { events, emit } = session();
  const delivered: { text: string; running: string[] }[] = [];
  const pacer = new ProgressPacer({ mode: 'status', throttleMs: 0, clock: SLOW_CLOCK }, (text, state) =>
    delivered.push({ text, running: state.tools.filter(tool => tool.state === 'running').map(tool => tool.name) }),
  );
  assert.equal(pacer.text, '⏳ thinking…', 'the text a follower shows first');
  pacer.start(events, 'ses_1');

  emit('session.usage.updated');
  assert.deepEqual(delivered, [], 'an event that leaves the text as it is says nothing');
  emit('session.tool.input.started', { id: 't1', name: 'read' });

  assert.deepEqual(delivered, [{ text: '🔧 reading', running: ['read'] }]);
  assert.equal(pacer.text, '🔧 reading', 'and the pacer now holds that text');
  pacer.stop();
});

test('a text already on show makes the first change wait out the window, and the last state is said once', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { events, emit } = session();
  const texts: string[] = [];
  const pacer = new ProgressPacer(
    { mode: 'status', throttleMs: 2_000, clock: SLOW_CLOCK },
    text => texts.push(text),
    NOW,
  );
  pacer.start(events, 'ses_1');

  emit('session.tool.input.started', { id: 't1', name: 'read' });
  emit('session.tool.success', { id: 't1' });
  emit('session.text.delta');
  assert.deepEqual(texts, [], 'the window is still open');

  t.mock.timers.tick(2_000);
  assert.deepEqual(texts, ['✍️ writing the answer'], 'the window closes on the state the events left');
  pacer.stop();
});

test('start is idempotent; a stopped pacer lets its pending delivery go; start resumes it with its history', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { events, watch, unwatch, emit } = session();
  const texts: string[] = [];
  const pacer = new ProgressPacer(
    { mode: 'tools', throttleMs: 2_000, clock: SLOW_CLOCK },
    text => texts.push(text),
    NOW,
  );
  assert.equal(pacer.running, false);
  pacer.start(events, 'ses_1');
  pacer.start(events, 'ses_1');
  assert.equal(pacer.running, true);
  assert.equal(watch.mock.callCount(), 1, 'one watch, however often it is started');

  emit('session.tool.input.started', { id: 't1', name: 'read' });
  pacer.stop();
  assert.equal(pacer.running, false);
  assert.equal(unwatch.mock.callCount(), 1);
  t.mock.timers.tick(10_000);
  assert.deepEqual(texts, [], 'the delivery that was waiting for its window is not made');

  pacer.start(events, 'ses_1');
  assert.equal(watch.mock.callCount(), 2, 'resumed: the session is watched again');
  emit('session.text.delta');
  assert.equal(texts.length, 1, 'and the first change after the resume is said at once');
  pacer.stop();
});
