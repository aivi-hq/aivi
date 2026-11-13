import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SharedEngine } from '../src/shared.ts';
import { engineSpec, voiceProcesses } from './process-fixture.ts';

test('shared audio starts one engine, flushes buffered frames in order and keeps it warm after a room leaves', async t => {
  const h = voiceProcesses(t);
  const log = { info: t.mock.fn(), warn: t.mock.fn() };
  const shared = new SharedEngine(engineSpec, log);
  const events = t.mock.fn();
  const state = t.mock.fn();
  const sink = { onEvent: events, onState: state };
  shared.attach(sink);
  assert.equal(shared.slice(0, 0.01), null);
  const a = Buffer.from(new Int16Array([1000, 2000]).buffer);
  const b = Buffer.from(new Int16Array([3000, 4000]).buffer);

  shared.push(a);
  shared.push(b);
  const pending = shared.ready();
  const concurrent = shared.ready();
  assert.equal(pending, concurrent);
  assert.equal(h.spawn.mock.callCount(), 1);
  h.children[0]!.ready();
  const engine = await pending;

  assert.ok(engine);
  assert.equal(await shared.ready(), engine);
  assert.deepEqual(
    h.children[0]!.inputs.map(line => Buffer.from(JSON.parse(line).a, 'base64')),
    [a, b],
  );
  assert.deepEqual(
    Array.from(shared.slice(0, 4 / 16000)!),
    [1000, 2000, 3000, 4000].map(value => value / 32768),
  );
  shared.push(a);
  assert.equal(h.children[0]!.inputs.length, 3);
  h.children[0]!.response({ ev: 'diar', on: true });
  const nextEvents = t.mock.fn();
  const nextState = t.mock.fn();
  shared.attach({ onEvent: nextEvents, onState: nextState });
  assert.deepEqual(nextEvents.mock.calls[0]!.arguments, [{ ev: 'diar', on: true }]);
  assert.deepEqual(nextState.mock.calls[0]!.arguments, ['ready']);
  shared.detach(sink);
  h.children[0]!.response({ ev: 'delta', text: 'hello', pos: 1 });
  assert.equal(events.mock.callCount(), 1);
  assert.equal(nextEvents.mock.callCount(), 2);
  assert.equal(h.children[0]!.process.kill.mock.callCount(), 0);
  await shared.stop();
  const notifications = nextState.mock.callCount();
  await shared.stop();
  shared.push(a);
  assert.equal(nextState.mock.callCount(), notifications);
  assert.equal(h.children[0]!.inputs.length, 3);
});

test('buffer pressure discards old queued frames before the engine is ready', async t => {
  const h = voiceProcesses(t);
  const log = { info: t.mock.fn(), warn: t.mock.fn() };
  const shared = new SharedEngine(engineSpec, log);
  const old = Buffer.alloc(1_200_000, 1);
  const latest = Buffer.alloc(1_200_000, 2);

  shared.push(old);
  shared.push(latest);
  const pending = shared.ready();
  h.children[0]!.ready();
  await pending;

  assert.equal(log.warn.mock.calls[0]!.arguments[0], 'voice.engine.dropped');
  assert.equal(h.children[0]!.inputs.length, 1);
  const frame = Buffer.from(JSON.parse(h.children[0]!.inputs[0]!).a, 'base64');
  assert.equal(frame.length, latest.length);
  assert.equal(frame[0], 2);
  await shared.stop();
});

test('shutdown discards a large in-flight audio frame before it can be written to the engine', async t => {
  const h = voiceProcesses(t);
  const shared = new SharedEngine(engineSpec, { info: t.mock.fn(), warn: t.mock.fn() });
  shared.push(Buffer.alloc(2_000_000));
  const pending = shared.ready();

  await shared.stop();

  assert.equal((await pending) === null, true);
  assert.equal(h.children[0]!.inputs.length, 0);
});

test('a failed startup says why, closes its process and retries only on a later request', async t => {
  const h = voiceProcesses(t);
  const log = { info: t.mock.fn(), warn: t.mock.fn() };
  const shared = new SharedEngine(engineSpec, log);
  const state = t.mock.fn();
  shared.attach({ onEvent() {}, onState: state });
  const pending = shared.ready();

  h.children[0]!.process.emit('error', new Error('could not spawn'));

  assert.equal((await pending) === null, true);
  assert.equal(state.mock.calls.at(-1)!.arguments[0], 'failed');
  assert.equal(h.children[0]!.process.kill.mock.callCount(), 1);
  assert.equal(log.warn.mock.calls.at(-1)!.arguments[0], 'voice.engine.start-failed');
  assert.equal(h.spawn.mock.callCount(), 1);
  const next = shared.ready();
  h.children[1]!.ready();
  assert.ok(await next);
  await shared.stop();
});

test('one failed room listener does not prevent state or engine events from reaching the others', async t => {
  const h = voiceProcesses(t);
  const log = { info: t.mock.fn(), warn: t.mock.fn() };
  const shared = new SharedEngine(engineSpec, log);
  const state = t.mock.fn();
  const event = t.mock.fn();
  shared.attach({
    onState(value) {
      if (value === 'loading') throw new Error('state consumer failed');
    },
    onEvent() {
      throw new Error('event consumer failed');
    },
  });
  shared.attach({ onState: state, onEvent: event });
  const pending = shared.ready();
  h.children[0]!.ready();
  await pending;

  h.children[0]!.response({ ev: 'delta', text: 'hello', pos: 1 });

  assert.deepEqual(
    state.mock.calls.map(call => call.arguments[0]),
    ['idle', 'loading', 'ready'],
  );
  assert.equal(event.mock.callCount(), 1);
  assert.equal(log.warn.mock.callCount(), 2);
  assert.ok(log.warn.mock.calls.every(call => call.arguments[0] === 'voice.engine.sink-failed'));
  await shared.stop();
});
