import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { TtsRun, type TtsSpec } from '../src/tts.ts';
import { voiceProcesses } from './process-fixture.ts';

const spec: TtsSpec = { command: 'fake-tts', args: [], readyMarker: 'tts ready', voice: 'nl_female', stream: true };
const wav = (sound: string) => Buffer.from(sound).toString('base64');
const heard = async (speech: AsyncGenerator<Buffer>): Promise<string[]> => {
  const sounds: string[] = [];
  for await (const chunk of speech) sounds.push(chunk.toString());
  return sounds;
};

/** One voice over a process-shaped fake, loaded and listening. */
async function voice(t: TestContext, options: { spec?: Partial<TtsSpec>; timeoutMs?: number } = {}) {
  const h = voiceProcesses(t);
  const warn = t.mock.fn();
  const run = new TtsRun({ ...spec, ...options.spec }, { info: t.mock.fn(), warn }, options.timeoutMs);
  t.after(() => run.stop());
  const starting = run.start();
  const child = h.children[0]!;
  child.stderr.write('tts ready (voxtral-tts loaded)\n');
  await starting;
  return { ...h, child, run, warn };
}

test('a voice spawns its configured command, names its model in the environment and is ready on its marker', async t => {
  const h = await voice(t, { spec: { command: 'python', args: ['mlx-tts.py'], model: 'org/voxtral-tts' } });

  const [command, args, options] = h.spawn.mock.calls[0]!.arguments;

  assert.equal(command, 'python');
  assert.deepEqual(args, ['mlx-tts.py']);
  assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options?.env?.VOXTRAL_TTS_MODEL, 'org/voxtral-tts');
  assert.equal(h.run.alive, true);
});

test('without a configured model the voice leaves the engine its own default', async t => {
  const h = await voice(t);

  const { env } = h.spawn.mock.calls[0]!.arguments[2]!;

  assert.equal(env?.VOXTRAL_TTS_MODEL, process.env.VOXTRAL_TTS_MODEL);
  assert.equal(env?.PATH, process.env.PATH);
});

test('a streamed sentence lands as wav chunks in order and ends at its final chunk', async t => {
  const h = await voice(t);

  const speech = heard(h.run.chunks('hello there'));
  const request = JSON.parse(await h.child.nextInput());

  assert.deepEqual(request, { id: 't1', text: 'hello there', voice: 'nl_female', stream: true });
  h.child.stdout.write(`\n{"id":"t1","seq":0,"audio":"${wav('one')}",`);
  h.child.stdout.write('"sr":24000,"final":false}\n');
  h.child.response({ id: 't1', seq: 1, audio: wav('two'), sr: 24000, final: false });
  h.child.response({ id: 't1', seq: 2, sr: 24000, final: true });
  assert.deepEqual(await speech, ['one', 'two']);
  assert.equal(h.warn.mock.callCount(), 0);
});

test('a sentence that is not streamed is one reply and its own final chunk', async t => {
  const h = await voice(t, { spec: { stream: false, voice: 'nl_male' } });

  const speech = heard(h.run.chunks('one whole sentence'));
  const request = JSON.parse(await h.child.nextInput());

  assert.deepEqual(request, { id: 't1', text: 'one whole sentence', voice: 'nl_male', stream: false });
  h.child.response({ id: 't1', seq: 0, audio: wav('whole'), sr: 24000 });
  assert.deepEqual(await speech, ['whole']);
});

test('sentences are spoken one at a time, and an abandoned one does not hold the voice', async t => {
  const h = await voice(t);
  const interrupted = h.run.chunks('a long sentence');
  const first = interrupted.next();
  const following = heard(h.run.chunks('the next sentence'));
  const request = JSON.parse(await h.child.nextInput());
  h.child.response({ id: request.id, audio: wav('first'), final: false });
  assert.equal((await first).value?.toString(), 'first');
  assert.equal(h.child.inputs.length, 1, 'one model, one synthesis: the next sentence waits');

  await interrupted.return(undefined);

  const next = JSON.parse(await h.child.nextInput());
  h.child.response({ id: request.id, audio: wav('unheard rest'), final: true });
  h.child.response({ id: next.id, audio: wav('next'), final: true });
  assert.deepEqual(await following, ['next']);
  assert.equal(h.warn.mock.callCount(), 0);
});

test('an engine error leaves the sentence unspoken and garbage on the wire is said, not spoken', async t => {
  const h = await voice(t);

  const speech = heard(h.run.chunks('this will fail'));
  const request = JSON.parse(await h.child.nextInput());
  h.child.stdout.write(`not json ${'x'.repeat(200)}\n`);
  h.child.response({ id: request.id, error: 'no such voice' });

  assert.deepEqual(await speech, []);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      ['voice.tts.bad-line', { line: `not json ${'x'.repeat(111)}` }],
      ['voice.tts.engine-error', { id: request.id, error: 'no such voice' }],
    ],
  );
});

test('a voice that goes quiet loses the sentence at its timeout, before or between chunks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await voice(t, { timeoutMs: 3000 });
  const silent = heard(h.run.chunks('never answered'));
  const first = JSON.parse(await h.child.nextInput());

  t.mock.timers.tick(3000);

  assert.deepEqual(await silent, []);
  const stalled = h.run.chunks('stalls after one chunk');
  const chunk = stalled.next();
  const second = JSON.parse(await h.child.nextInput());
  h.child.response({ id: first.id, audio: wav('too late'), final: true });
  t.mock.timers.tick(2999);
  h.child.response({ id: second.id, audio: wav('one'), final: false });
  assert.equal((await chunk).value?.toString(), 'one');
  const rest = stalled.next();
  t.mock.timers.tick(2999);
  assert.equal(h.warn.mock.callCount(), 1, 'every chunk restarts the clock');
  t.mock.timers.tick(1);
  assert.equal((await rest).done, true);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      ['voice.tts.timeout', { id: first.id, seconds: 3 }],
      ['voice.tts.timeout', { id: second.id, seconds: 3 }],
    ],
  );
});

test('a dying voice ends the sentence on the air and the one still waiting, and speaks nothing after', async t => {
  const h = await voice(t);
  const onAir = heard(h.run.chunks('on the air'));
  const waiting = heard(h.run.chunks('still waiting'));
  await h.child.nextInput();

  h.child.exit(7);

  assert.deepEqual(await onAir, []);
  assert.deepEqual(await waiting, []);
  assert.equal(h.child.inputs.length, 1, 'the waiting sentence is never written to a dead process');
  assert.equal(h.run.alive, false);
  assert.deepEqual(await heard(h.run.chunks('after the crash')), []);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['voice.tts.exited', { code: 7 }]],
  );
});

test('a voice that exits before it is ready fails the start with the last of its stderr', async t => {
  for (const [stderr, tail] of [
    ['one\ntwo\nthree\nfour\n', 'two | three | four'],
    ['', 'no stderr'],
  ] as const) {
    await t.test(tail, async t => {
      const h = voiceProcesses(t);
      const warn = t.mock.fn();
      const run = new TtsRun(spec, { info: t.mock.fn(), warn });
      const starting = run.start();
      if (stderr) h.children[0]!.stderr.write(stderr);

      h.children[0]!.exit(1);

      await assert.rejects(starting, { message: `tts engine exited 1 before ready: ${tail}` });
      assert.equal(warn.mock.callCount(), 0, 'the rejected start is the report');
    });
  }
});

test('a voice command that cannot be spawned fails the start once and is logged whenever it errors', async t => {
  const h = voiceProcesses(t);
  const warn = t.mock.fn();
  const run = new TtsRun(spec, { info: t.mock.fn(), warn });
  t.after(() => run.stop());
  const starting = run.start();
  const missing = new Error('spawn fake-tts ENOENT');

  h.children[0]!.process.emit('error', missing);

  await assert.rejects(starting, missing);
  h.children[0]!.process.emit('error', new Error('later failure'));
  h.children[0]!.stdin.emit('error', new Error('write EPIPE'));
  assert.deepEqual(
    warn.mock.calls.map(call => call.arguments),
    [
      ['voice.tts.spawn-failed', { error: 'Error: spawn fake-tts ENOENT' }],
      ['voice.tts.spawn-failed', { error: 'Error: later failure' }],
      ['voice.tts.stdin-error', { error: 'Error: write EPIPE' }],
    ],
  );
});

test('stopping a voice ends its process and the sentence on the air without calling it a crash', async t => {
  const h = await voice(t);
  const onAir = heard(h.run.chunks('cut short'));
  await h.child.nextInput();

  await h.run.stop();

  assert.deepEqual(await onAir, []);
  assert.deepEqual(
    h.child.process.kill.mock.calls.map(call => call.arguments),
    [['SIGKILL']],
  );
  assert.equal(h.child.stdin.writableEnded, true);
  await h.run.stop();
  assert.equal(h.child.process.kill.mock.callCount(), 1, 'a stopped voice has nothing left to end');
  assert.deepEqual(await heard(h.run.chunks('after the stop')), []);
  assert.equal(h.warn.mock.callCount(), 0);
});
