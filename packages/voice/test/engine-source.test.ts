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

test('ending the default decoder ourselves is not reported as a failed source', async t => {
  const h = engineFixture(t, engineSpec, { type: 'mic' });
  await h.start();
  const decoder = h.children[1]!;

  await h.run.stop();

  assert.deepEqual(
    decoder.process.kill.mock.calls.map(call => call.arguments),
    [['SIGKILL']],
  );
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments[0]),
    [],
    'a capture we stopped did not fail',
  );
});

test('a decoder that ends on its own is reported only when it failed', async t => {
  for (const [code, said] of [
    [0, []],
    [1, [['voice.source.exited', { code: 1 }]]],
  ] as const) {
    await t.test(`exit ${code}`, async t => {
      const h = engineFixture(t, engineSpec, { type: 'file', path: '/meeting.wav' });
      await h.start();

      h.children[1]!.exit(code);

      assert.deepEqual(
        h.warn.mock.calls.map(call => call.arguments),
        said,
      );
    });
  }
});
