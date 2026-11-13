import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SharedEngine } from '../src/shared.ts';
import { engineSpec, voiceProcesses } from './process-fixture.ts';

test('shared engine shutdown owns the loading process and prevents late readiness', async t => {
  const h = voiceProcesses(t);
  const log = { info: t.mock.fn(), warn: t.mock.fn() };
  const shared = new SharedEngine(engineSpec, log);
  const pending = shared.ready();
  await h.created;
  const process = h.children[0]!;

  await shared.stop();

  assert.equal(process.process.kill.mock.callCount(), 1);
  assert.equal((await pending) === null, true);
  assert.equal((await shared.ready()) === null, true);
  assert.equal(h.spawn.mock.callCount(), 1);
  assert.equal(log.warn.mock.callCount(), 0);
});

test('a ready marker followed immediately by process death cannot cache a dead shared engine', async t => {
  const h = voiceProcesses(t);
  const shared = new SharedEngine(engineSpec, { info: t.mock.fn(), warn: t.mock.fn() });
  const state = t.mock.fn();
  shared.attach({ onEvent() {}, onState: state });
  const pending = shared.ready();
  const process = h.children[0]!;

  process.ready();
  process.exit(3);

  assert.equal((await pending) === null, true, 'a ready answer must not return the process that already exited');
  assert.equal(state.mock.calls.at(-1)!.arguments[0], 'failed');
  const next = shared.ready();
  assert.equal(h.spawn.mock.callCount(), 2);
  h.children[1]!.ready();
  assert.ok(await next);
  await shared.stop();
});

test('normal EOF releases the shared process and its cached diarizer answer without inventing a failure', async t => {
  const h = voiceProcesses(t);
  const log = { info: t.mock.fn(), warn: t.mock.fn() };
  const shared = new SharedEngine(engineSpec, log);
  const state = t.mock.fn();
  shared.attach({ onEvent() {}, onState: state });
  const pending = shared.ready();
  h.children[0]!.ready();
  await pending;
  h.children[0]!.response({ ev: 'diar', on: true });

  h.children[0]!.response({ ev: 'eof' });
  h.children[0]!.exit();

  assert.equal(state.mock.calls.at(-1)!.arguments[0], 'idle');
  const events = t.mock.fn();
  shared.attach({ onEvent: events, onState() {} });
  assert.equal(events.mock.callCount(), 0);
  assert.equal(log.warn.mock.callCount(), 0);
  const next = shared.ready();
  assert.equal(h.spawn.mock.callCount(), 2);
  h.children[1]!.ready();
  assert.ok(await next);
  await shared.stop();
});

test('a loading-state listener may stop the owner before any process is created', async t => {
  const h = voiceProcesses(t);
  const shared = new SharedEngine(engineSpec, { info: t.mock.fn(), warn: t.mock.fn() });
  let closing: Promise<void> | undefined;
  shared.attach({
    onEvent() {},
    onState(state) {
      if (state === 'loading') closing = shared.stop();
    },
  });

  const pending = shared.ready();

  assert.equal(h.spawn.mock.callCount(), 0);
  assert.equal((await pending) === null, true);
  await closing;
});

test('a readiness listener that closes the owner cannot return a stopped process to the requester', async t => {
  const h = voiceProcesses(t);
  const shared = new SharedEngine(engineSpec, { info: t.mock.fn(), warn: t.mock.fn() });
  let closing: Promise<void> | undefined;
  shared.attach({
    onEvent() {},
    onState(state) {
      if (state === 'ready') closing = shared.stop();
    },
  });
  const pending = shared.ready();

  h.children[0]!.ready();

  assert.equal((await pending) === null, true);
  await closing;
  assert.equal(h.children[0]!.process.kill.mock.callCount(), 1);
});

test('buffered pipe events arriving after shutdown cannot revive the diarizer cache or reach rooms', async t => {
  const h = voiceProcesses(t);
  const shared = new SharedEngine(engineSpec, { info: t.mock.fn(), warn: t.mock.fn() });
  const events = t.mock.fn();
  shared.attach({ onEvent: events, onState() {} });
  const pending = shared.ready();
  h.children[0]!.ready();
  await pending;
  h.children[0]!.response({ ev: 'diar', on: true });

  await shared.stop();
  h.children[0]!.response({ ev: 'diar', on: false });
  h.children[0]!.response({ ev: 'delta', text: 'late', pos: 1 });

  assert.equal(events.mock.callCount(), 1);
  const next = t.mock.fn();
  shared.attach({ onEvent: next, onState() {} });
  assert.equal(next.mock.callCount(), 0);
});

test('process death during a readiness notification cannot fulfill the request with that dead process', async t => {
  const h = voiceProcesses(t);
  const shared = new SharedEngine(engineSpec, { info: t.mock.fn(), warn: t.mock.fn() });
  shared.attach({
    onEvent() {},
    onState(state) {
      if (state === 'ready') h.children[0]!.exit(3);
    },
  });
  const pending = shared.ready();

  h.children[0]!.ready();

  assert.equal((await pending) === null, true);
  await shared.stop();
});
