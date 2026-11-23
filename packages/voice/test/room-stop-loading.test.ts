import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceProcesses } from './process-fixture.ts';
import { hearingRoom } from './room-fixture.ts';

const engineStates = (h: ReturnType<typeof hearingRoom>) =>
  h.events.mock.calls
    .map(call => call.arguments[0])
    .filter(event => event.ev === 'engine')
    .map(event => event.state);

test('a room closed while its own engine still loads does not report a failed start', async t => {
  const processes = voiceProcesses(t);
  const h = hearingRoom(t, { init: { engineInput: { type: 'mic' }, streaming: true } });

  await h.room.stop();

  assert.equal(processes.children[0]!.process.kill.mock.callCount(), 1);
  assert.deepEqual(h.said('warn'), [], 'a room that closed did not fail');
  assert.deepEqual(engineStates(h), ['loading']);
});

test('a ready marker that lands after the room closed changes nothing', async t => {
  const processes = voiceProcesses(t);
  const h = hearingRoom(t, { init: { engineInput: { type: 'mic' }, streaming: true } });
  const [engine] = processes.children;
  // The kill is sent; its exit has not been reported yet when stderr drains.
  engine!.process.kill.mock.mockImplementation(() => true);
  await h.room.stop();

  engine!.ready();
  await h.room.stop();

  assert.deepEqual(engineStates(h), ['loading']);
  assert.equal(processes.spawn.mock.callCount(), 1, 'no decoder is started for a closed room');
});
