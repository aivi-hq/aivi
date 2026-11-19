import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { stopSwitch } from '../src/channel/stop.ts';

test('the switch aborts its signal, and stops the engine once the module has built one', () => {
  let engine: { stop(): void } | undefined;
  const halt = stopSwitch(new AbortController().signal, () => engine);
  assert.equal(halt.signal.aborted, false);

  halt.stop();
  assert.equal(halt.signal.aborted, true, 'before there is an engine the switch only ends the module’s own work');

  const built = { stop: mock.fn() };
  engine = built;
  halt.stop();
  assert.equal(built.stop.mock.callCount(), 1, 'once there is one, the switch stops it');
});

test('the host’s shutdown throws the switch, and a released switch no longer hears it', () => {
  const engine = { stop: mock.fn() };
  const host = new AbortController();
  const heard = stopSwitch(host.signal, () => engine);
  host.abort();
  assert.equal(heard.signal.aborted, true);
  assert.equal(engine.stop.mock.callCount(), 1);

  const other = new AbortController();
  const released = stopSwitch(other.signal, () => engine);
  released.release();
  other.abort();
  assert.equal(released.signal.aborted, false);
  assert.equal(engine.stop.mock.callCount(), 1, 'the engine was not stopped a second time');
});
