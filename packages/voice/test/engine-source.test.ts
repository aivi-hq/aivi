import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { engineFixture, engineSpec } from './process-fixture.ts';

test('an engine that dies ends the audio source that was feeding it', async t => {
  const audio = new PassThrough();
  const stop = t.mock.fn();
  const h = engineFixture(
    t,
    { ...engineSpec, source: () => ({ stream: audio, stop }) },
    { type: 'file', path: '/audio.wav' },
  );
  await h.start();
  audio.write(Buffer.from(new Int16Array([1000, 2000]).buffer));
  assert.equal(h.children[0]!.inputs.length, 1, 'the source was feeding the engine');

  h.children[0]!.exit(3);

  assert.equal(stop.mock.callCount(), 1, 'nothing is left to hear the audio: its producer ends too');
  assert.deepEqual(h.exited.mock.calls[0]!.arguments, [3]);
  await h.run.stop();
  assert.equal(stop.mock.callCount(), 1, 'the source is ended once');
});
