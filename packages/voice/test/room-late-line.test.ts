import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hearingRoom, pcm } from './room-fixture.ts';

test('a line that lands after its call room closed is dropped with the batch and arms no later flush', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = hearingRoom(t);
  const lane = h.room.lane({ speaker: 'Ada', user: 'u-ada', person: true });
  lane.push(pcm);
  const [id] = await h.joined.next();
  h.engineEvent({ ev: 'delta', text: 'one last thing', pos: 0.4, lane: id });
  const ending = lane.end(); // waits for the engine's tail

  await h.room.stop(); // the room closes first: the wait is settled with what streamed

  assert.equal(await ending, 'one last thing');
  // The host closes its database once the modules have stopped. A flush left
  // armed by the late line would wake up on it.
  h.database.close();
  assert.doesNotThrow(() => t.mock.timers.tick(1500));
  assert.equal(h.said('info').includes('voice.flush'), false, 'nothing is left to become a prompt');
  assert.deepEqual(
    h.info.mock.calls.filter(call => call.arguments[0] === 'voice.batch.dropped').map(call => call.arguments[1].lines),
    [1],
    'the unfinished sentence is said to be dropped, like the rest of a closing batch',
  );
  assert.equal(h.request.mock.callCount(), 0);
});
