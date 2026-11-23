import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { AudioSource, EngineSpec } from '../src/engine.ts';
import { engineFixture, engineSpec } from './process-fixture.ts';

const audio = (...samples: number[]) => Buffer.from(new Int16Array(samples).buffer);
const frame = (pcm: Buffer) => ({ a: pcm.toString('base64') });
const sent = (inputs: string[]) => inputs.map(line => JSON.parse(line));

test('the engine spawns its command, names its models in the environment and is ready on its marker', async t => {
  const h = engineFixture(t, {
    command: 'python',
    args: ['mlx-engine.py'],
    readyMarker: 'engine ready',
    model: 'org/voxtral',
    diarModel: 'org/diarizer',
  });

  const starting = h.run.start();
  h.children[0]!.stderr.write('loading weights\nengine re');
  h.children[0]!.stderr.write('ady\n');
  await starting;

  const [command, args, options] = h.spawn.mock.calls[0]!.arguments;
  assert.equal(command, 'python');
  assert.deepEqual(args, ['mlx-engine.py']);
  assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options?.env?.VOXTRAL_MODEL, 'org/voxtral');
  assert.equal(options?.env?.DIAR_MODEL, 'org/diarizer');
  assert.equal(h.spawn.mock.callCount(), 1, 'a push engine has no audio source of its own');
});

test('without configured models the engine keeps its own defaults', async t => {
  const h = engineFixture(t);
  await h.start();

  const { env } = h.spawn.mock.calls[0]!.arguments[2]!;

  assert.equal(env?.VOXTRAL_MODEL, process.env.VOXTRAL_MODEL);
  assert.equal(env?.DIAR_MODEL, process.env.DIAR_MODEL);
});

test('pushed audio reaches the engine one frame per line and the ring the fusion slices from', async t => {
  const h = engineFixture(t);
  h.run.write(audio(1, 2));
  assert.equal(h.spawn.mock.callCount(), 0, 'audio before the start goes nowhere');
  await h.start();

  h.run.write(audio(1000, 2000));
  h.run.write(audio(3000, 4000));

  assert.deepEqual(sent(h.children[0]!.inputs), [frame(audio(1000, 2000)), frame(audio(3000, 4000))]);
  assert.deepEqual(
    Array.from(h.run.slice(1 / 16000, 3 / 16000)!),
    [2000, 3000].map(sample => sample / 32768),
  );
  assert.equal(h.run.slice(0, 0) === null, true, 'an empty stretch is nothing to slice');
  assert.equal(h.run.slice(0, 5 / 16000) === null, true, 'audio that was never heard cannot be sliced');
});

test('the ring keeps the last three minutes: older audio is gone, the newest still slices', async t => {
  const h = engineFixture(t);
  await h.start();
  const ring = 180 * 16000;
  const long = Buffer.alloc((ring + 2) * 2);
  long.writeInt16LE(1000, 0);
  long.writeInt16LE(2000, (ring + 1) * 2);

  h.run.write(long);

  assert.equal(h.run.slice(0, 1 / 16000) === null, true, 'the first sample was overwritten');
  assert.deepEqual(Array.from(h.run.slice((ring + 1) / 16000, (ring + 2) / 16000)!), [2000 / 32768]);
  assert.deepEqual(Array.from(h.run.slice(2 / 16000, 3 / 16000)!), [0], 'the oldest sample still held');
});

test('named lanes and finished utterances ride the same stdin, clamped to the wire format', async t => {
  const h = engineFixture(t);
  await h.start();
  const child = h.children[0]!;

  h.run.writeLane('room/1', new Float32Array([0.5, -2, 2]));
  h.run.endLane('room/1');
  const answer = h.run.transcribe(new Float32Array([0.25]));

  assert.deepEqual(sent(child.inputs), [
    { a: audio(16384, -32768, 32767).toString('base64'), lane: 'room/1' },
    { lane: 'room/1', end: true },
    { id: 't1', a: audio(8192).toString('base64') },
  ]);
  child.stdout.write('\n  \n{"id":"t1","text":"heard"}\n');
  assert.equal(await answer, 'heard');
});

test('a caller-supplied source feeds the engine until it ends, then the engine is told the audio is over', async t => {
  const stream = new PassThrough();
  const stop = t.mock.fn();
  const source = t.mock.fn(() => ({ stream, stop }));
  const h = engineFixture(t, { ...engineSpec, source }, { type: 'file', path: '/unused.wav' });
  assert.equal(source.mock.callCount(), 0);
  await h.start();
  const child = h.children[0]!;

  stream.write(audio(1000, 2000));
  child.backpressure(true);
  stream.write(audio(3000));

  assert.equal(h.spawn.mock.callCount(), 1, 'the caller brought the audio: no decoder is started');
  assert.deepEqual(sent(child.inputs), [frame(audio(1000, 2000)), frame(audio(3000))]);
  assert.deepEqual(
    Array.from(h.run.slice(0, 3 / 16000)!),
    [1000, 2000, 3000].map(sample => sample / 32768),
  );
  assert.equal(stream.isPaused(), true, 'a full engine pipe holds the source back');
  child.backpressure(false);
  child.stdin.emit('drain');
  assert.equal(stream.isPaused(), false);
  const closed = once(child.stdin, 'finish');
  stream.end();
  await closed;
  child.response({ ev: 'eof' });
  child.exit(0);
  assert.deepEqual(h.exited.mock.calls[0]!.arguments, [0]);
  assert.equal(h.run.eof, true);
  await h.run.stop();
  assert.equal(stop.mock.callCount(), 0, 'a source that ended on its own is not ended again');
});

test('a source that fails says so and still ends the audio for the engine', async t => {
  const stream = new PassThrough();
  const h = engineFixture(
    t,
    { ...engineSpec, source: () => ({ stream, stop: () => {} }) },
    { type: 'file', path: '/unused.wav' },
  );
  await h.start();
  const closed = once(h.children[0]!.stdin, 'finish');

  stream.destroy(new Error('decoder died'));
  await closed;

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['voice.source-failed', { error: 'Error: decoder died' }]],
  );
});

test('a file or a microphone is decoded by ffmpeg into the engine, paced like a live room', async t => {
  const cases: Array<[platform: NodeJS.Platform, input: AudioSource, decode: string[]]> = [
    ['darwin', { type: 'file', path: '/meeting.wav' }, ['-re', '-i', '/meeting.wav']],
    ['darwin', { type: 'file', path: '/meeting.wav', paced: false }, ['-i', '/meeting.wav']],
    ['darwin', { type: 'mic' }, ['-f', 'avfoundation', '-i', ':none:default']],
    ['darwin', { type: 'mic', device: 'BlackHole' }, ['-f', 'avfoundation', '-i', ':BlackHole']],
    ['linux', { type: 'mic' }, ['-f', 'alsa', '-i', 'default']],
    ['linux', { type: 'mic', device: 'hw:1' }, ['-f', 'alsa', '-i', 'hw:1']],
  ];
  for (const [platform, input, decode] of cases) {
    await t.test(`${platform} ${JSON.stringify(input)}`, async t => {
      t.mock.property(process, 'platform', platform);
      const h = engineFixture(t, engineSpec, input);
      await h.start();

      const [command, args, options] = h.spawn.mock.calls[1]!.arguments;

      assert.equal(command, 'ffmpeg');
      assert.deepEqual(args, ['-v', 'error', '-nostats', ...decode, '-ar', '16000', '-ac', '1', '-f', 's16le', '-']);
      assert.deepEqual(options?.stdio, ['ignore', 'pipe', 'inherit']);
      h.children[1]!.stdout.write(audio(1000, 2000));
      assert.deepEqual(sent(h.children[0]!.inputs), [frame(audio(1000, 2000))]);
    });
  }
});

test('a decoder that cannot be spawned is reported and leaves the engine running', async t => {
  const h = engineFixture(t, engineSpec, { type: 'mic' });
  await h.start();

  h.children[1]!.process.emit('error', new Error('spawn ffmpeg ENOENT'));

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['voice.source.spawn-failed', { error: 'Error: spawn ffmpeg ENOENT' }]],
  );
  assert.equal(h.children[0]!.process.kill.mock.callCount(), 0);
});

test('a ready marker still in the pipe when the engine was stopped starts no audio for it', async t => {
  const source = t.mock.fn<NonNullable<EngineSpec['source']>>();
  const h = engineFixture(t, { ...engineSpec, source }, { type: 'mic' });
  const starting = h.run.start();
  const child = h.children[0]!;
  // The kill is sent; its exit has not been reported yet when stderr drains.
  child.process.kill.mock.mockImplementation(() => true);
  await h.run.stop();

  child.ready();
  await starting;
  child.exit(null, 'SIGKILL');

  assert.equal(source.mock.callCount(), 0);
  assert.equal(h.exited.mock.callCount(), 0, 'a requested exit is not an unexpected one');
});

test('an engine that exits before it is ready fails the start with the last of its stderr', async t => {
  for (const [stderr, tail] of [
    ['one\ntwo\nthree\nfour\n', 'two | three | four'],
    ['', 'no stderr'],
  ] as const) {
    await t.test(tail, async t => {
      const source = t.mock.fn<NonNullable<EngineSpec['source']>>();
      const h = engineFixture(t, { ...engineSpec, source }, { type: 'mic' });
      const starting = h.run.start();
      if (stderr) h.children[0]!.stderr.write(stderr);

      h.children[0]!.exit(1);

      await assert.rejects(starting, { message: `engine exited 1 before ready: ${tail}` });
      assert.equal(h.exited.mock.callCount(), 0, 'the rejected start is the report');
      assert.equal(source.mock.callCount(), 0, 'no audio is started for an engine that never loaded');
    });
  }
});

test('an engine command that cannot be spawned fails the start once and is logged whenever it errors', async t => {
  const h = engineFixture(t);
  const starting = h.run.start();
  const missing = new Error('spawn fake-engine ENOENT');

  h.children[0]!.process.emit('error', missing);

  await assert.rejects(starting, missing);
  h.children[0]!.process.emit('error', new Error('later failure'));
  h.children[0]!.stdin.emit('error', new Error('write EPIPE'));
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      ['voice.engine.spawn-failed', { error: 'Error: spawn fake-engine ENOENT' }],
      ['voice.engine.spawn-failed', { error: 'Error: later failure' }],
      ['voice.engine.stdin-error', { error: 'Error: write EPIPE' }],
    ],
  );
});

test('a dying engine answers every waiting utterance with a loss and tells its owner once', async t => {
  const h = engineFixture(t);
  await h.start();
  const first = h.run.transcribe(new Float32Array([0.25]));
  const second = h.run.transcribe(new Float32Array([0.5]));

  h.children[0]!.exit(3);

  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.deepEqual(
    h.exited.mock.calls.map(call => call.arguments),
    [[3]],
  );
  assert.equal(await h.run.transcribe(new Float32Array([0.25])), null);
  h.run.write(audio(1));
  h.run.writeLane('room/1', new Float32Array([0.5]));
  h.run.endLane('room/1');
  assert.equal(h.children[0]!.inputs.length, 2, 'nothing more is written to a dead engine');
});

test('stopping the engine settles what was waiting, ends the process and is not an unexpected exit', async t => {
  const h = engineFixture(t);
  await h.run.stop();
  await h.start();
  const child = h.children[0]!;
  const pending = h.run.transcribe(new Float32Array([0.25]));

  await h.run.stop();

  assert.equal(await pending, null);
  assert.deepEqual(
    child.process.kill.mock.calls.map(call => call.arguments),
    [['SIGKILL']],
  );
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(h.exited.mock.callCount(), 0);
  h.run.write(audio(1));
  h.run.writeLane('room/1', new Float32Array([0.5]));
  h.run.endLane('room/1');
  assert.equal(await h.run.transcribe(new Float32Array([0.25])), null);
  assert.equal(child.inputs.length, 1, 'a stopped engine is written nothing');
  await h.run.stop();
  assert.equal(child.process.kill.mock.callCount(), 1);
});
