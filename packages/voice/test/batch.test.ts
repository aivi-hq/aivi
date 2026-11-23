import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { BatchEngineRun, samplesToBase64 } from '../src/batch.ts';
import { engineSpec, voiceProcesses } from './process-fixture.ts';

const utterance = new Float32Array([0, 0.5, -0.5]);

/** One batch endpoint over a process-shaped fake, loaded and listening. */
async function batch(t: TestContext, timeoutMs?: number) {
  const h = voiceProcesses(t);
  const info = t.mock.fn();
  const warn = t.mock.fn();
  const run = new BatchEngineRun(engineSpec, { info, warn }, timeoutMs);
  t.after(() => run.stop());
  const starting = run.start();
  const child = h.children[0]!;
  child.ready();
  await starting;
  return { ...h, child, run, warn };
}

test('the wire form clamps loud samples and survives the base64 s16le round trip', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, 2, -2]);
  const bytes = Buffer.from(samplesToBase64(samples), 'base64');

  assert.equal(bytes.length, samples.length * 2);
  assert.deepEqual(
    Array.from({ length: samples.length }, (_, i) => bytes.readInt16LE(i * 2)),
    [0, 16384, -16384, 32767, -32768, 8192, 32767, -32768],
  );
});

test('a batch endpoint spawns its configured command and is ready when the marker appears on stderr', async t => {
  const h = voiceProcesses(t);
  const run = new BatchEngineRun(
    { command: 'python', args: ['mlx-batch.py'], readyMarker: 'engine ready', model: 'org/voxtral' },
    { info: t.mock.fn(), warn: t.mock.fn() },
  );
  t.after(() => run.stop());
  assert.equal(run.alive, false);

  const starting = run.start();
  h.children[0]!.stderr.write('loading weights\nengine re');
  h.children[0]!.stderr.write('ady (batch, voxtral loaded)\n');
  await starting;

  const [command, args, options] = h.spawn.mock.calls[0]!.arguments;
  assert.equal(command, 'python');
  assert.deepEqual(args, ['mlx-batch.py']);
  assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options?.env?.VOXTRAL_MODEL, 'org/voxtral');
  assert.equal(run.alive, true);
});

test('without a configured model the endpoint leaves the engine its own default', async t => {
  const h = await batch(t);

  const { env } = h.spawn.mock.calls[0]!.arguments[2]!;

  assert.equal(env?.VOXTRAL_MODEL, process.env.VOXTRAL_MODEL);
  assert.equal(env?.PATH, process.env.PATH);
});

test('utterances are asked one at a time and answered on their own request id', async t => {
  const h = await batch(t);

  const first = h.run.transcribe(utterance);
  const second = h.run.transcribe(new Float32Array([1]));
  const asked = JSON.parse(await h.child.nextInput());

  assert.deepEqual(asked, { id: 'r1', pcm: samplesToBase64(utterance) });
  assert.equal(h.child.inputs.length, 1, 'one model, one decode: the second utterance waits');
  h.child.stdout.write('\n  \n{"id":"r1",');
  h.child.stdout.write('"text":"split over two reads"}\n');
  assert.equal(await first, 'split over two reads');
  const next = JSON.parse(await h.child.nextInput());
  assert.deepEqual(next, { id: 'r2', pcm: samplesToBase64(new Float32Array([1])) });
  h.child.response({ id: 'r2', text: 'second' });
  assert.equal(await second, 'second');
  assert.equal(h.warn.mock.callCount(), 0);
});

test('an engine error or an empty answer is a lost utterance, and stray lines never answer one', async t => {
  const h = await batch(t);

  const failed = h.run.transcribe(utterance);
  const request = JSON.parse(await h.child.nextInput());
  h.child.response({ id: 'r404', text: 'nobody asked this' });
  h.child.stdout.write(`not json ${'x'.repeat(200)}\n`);
  h.child.response({ id: request.id, error: 'decode failed', text: 'not authoritative' });
  assert.equal(await failed, null);
  const empty = h.run.transcribe(utterance);
  h.child.response({ id: JSON.parse(await h.child.nextInput()).id });
  assert.equal(await empty, null);

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      ['voice.batch.bad-line', { line: `not json ${'x'.repeat(111)}` }],
      ['voice.batch.engine-error', { id: request.id, error: 'decode failed' }],
    ],
  );
});

test('an unanswered utterance is lost at its timeout and frees the line for the next one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await batch(t, 2000);
  const lost = h.run.transcribe(utterance);
  const waiting = h.run.transcribe(utterance);
  const request = JSON.parse(await h.child.nextInput());

  t.mock.timers.tick(2000);

  assert.equal(await lost, null);
  assert.deepEqual(h.warn.mock.calls[0]!.arguments, ['voice.batch.timeout', { id: request.id, seconds: 2 }]);
  const retry = JSON.parse(await h.child.nextInput());
  h.child.response({ id: request.id, text: 'too late' });
  h.child.response({ id: retry.id, text: 'in time' });
  assert.equal(await waiting, 'in time');
  t.mock.timers.tick(2000);
  assert.equal(h.warn.mock.callCount(), 1, 'an answered request leaves no clock running');
});

test('a dying endpoint answers what it was asked and what was still waiting with a loss, never a hang', async t => {
  const h = await batch(t);
  const asked = h.run.transcribe(utterance);
  const waiting = h.run.transcribe(utterance);
  await h.child.nextInput();

  h.child.exit(9);

  assert.equal(await asked, null);
  assert.equal(await waiting, null);
  assert.equal(h.child.inputs.length, 1, 'the waiting utterance is never written to a dead process');
  assert.equal(h.run.alive, false);
  assert.equal(await h.run.transcribe(utterance), null);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['voice.batch.exited', { code: 9 }]],
  );
});

test('an endpoint that exits before it is ready fails the start with the last of its stderr', async t => {
  for (const [stderr, tail] of [
    ['traceback\nline one\nline two\nModuleNotFoundError: mlx\n', 'line one | line two | ModuleNotFoundError: mlx'],
    ['', 'no stderr'],
  ] as const) {
    await t.test(tail, async t => {
      const h = voiceProcesses(t);
      const warn = t.mock.fn();
      const run = new BatchEngineRun(engineSpec, { info: t.mock.fn(), warn });
      const starting = run.start();
      if (stderr) h.children[0]!.stderr.write(stderr);

      h.children[0]!.exit(1);

      await assert.rejects(starting, { message: `batch engine exited 1 before ready: ${tail}` });
      assert.equal(run.alive, false);
      assert.equal(warn.mock.callCount(), 0, 'the rejected start is the report');
    });
  }
});

test('a command that cannot be spawned fails the start once and is logged whenever it errors', async t => {
  const h = voiceProcesses(t);
  const warn = t.mock.fn();
  const run = new BatchEngineRun(engineSpec, { info: t.mock.fn(), warn });
  t.after(() => run.stop());
  const starting = run.start();
  const missing = new Error('spawn fake-engine ENOENT');

  h.children[0]!.process.emit('error', missing);

  await assert.rejects(starting, missing);
  h.children[0]!.process.emit('error', new Error('later failure'));
  h.children[0]!.stdin.emit('error', new Error('write EPIPE'));
  assert.deepEqual(
    warn.mock.calls.map(call => call.arguments),
    [
      ['voice.batch.spawn-failed', { error: 'Error: spawn fake-engine ENOENT' }],
      ['voice.batch.spawn-failed', { error: 'Error: later failure' }],
      ['voice.batch.stdin-error', { error: 'Error: write EPIPE' }],
    ],
  );
});

test('stopping ends the process, settles what was pending and is not reported as a crash', async t => {
  const h = await batch(t);
  const pending = h.run.transcribe(utterance);
  await h.child.nextInput();

  await h.run.stop();

  assert.equal(await pending, null);
  assert.deepEqual(
    h.child.process.kill.mock.calls.map(call => call.arguments),
    [['SIGKILL']],
  );
  assert.equal(h.child.stdin.writableEnded, true);
  assert.equal(h.run.alive, false);
  await h.run.stop();
  assert.equal(h.child.process.kill.mock.callCount(), 1, 'a stopped endpoint has nothing left to end');
  assert.equal(await h.run.transcribe(utterance), null);
  assert.equal(h.warn.mock.callCount(), 0);
});
