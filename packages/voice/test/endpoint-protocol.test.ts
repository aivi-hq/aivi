import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { BatchEngineRun } from '../src/batch.ts';
import { TtsRun } from '../src/tts.ts';
import { engineSpec, voiceProcesses } from './process-fixture.ts';

const wav = (sound: string) => Buffer.from(sound).toString('base64');

async function batch(t: TestContext) {
  const h = voiceProcesses(t);
  const warn = t.mock.fn<(message: string, fields?: Record<string, unknown>) => void>();
  const run = new BatchEngineRun(engineSpec, { info: t.mock.fn(), warn });
  t.after(() => run.stop());
  const starting = run.start();
  h.children[0]!.ready();
  await starting;
  return { child: h.children[0]!, run, warn };
}

async function voice(t: TestContext) {
  // The clock is held: a sentence that ends here ended on the reply, not on its timeout.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = voiceProcesses(t);
  const warn = t.mock.fn<(message: string, fields?: Record<string, unknown>) => void>();
  const run = new TtsRun({ ...engineSpec, voice: 'nl_female', stream: true }, { info: t.mock.fn(), warn });
  t.after(() => run.stop());
  const starting = run.start();
  h.children[0]!.ready();
  await starting;
  return { child: h.children[0]!, run, warn };
}

const stray = [null, true, 42, 'not a reply', [], { text: 'no request id' }, { id: 7, text: 'a numeric id' }];

test('a batch endpoint line that is not a reply with a request id is a bad protocol line', async t => {
  const h = await batch(t);
  const pending = h.run.transcribe(new Float32Array([0.25]));
  const request = JSON.parse(await h.child.nextInput());

  for (const value of stray) assert.doesNotThrow(() => h.child.response(value));

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments[0]),
    stray.map(() => 'voice.batch.bad-line'),
  );
  h.child.response({ id: request.id, text: 'still listening' });
  assert.equal(await pending, 'still listening');
});

test('a malformed batch reply settles its utterance as lost instead of returning something that is not text', async t => {
  for (const invalid of [{ text: 42 }, { error: { message: 'bad shape' } }]) {
    await t.test(JSON.stringify(invalid), async t => {
      const h = await batch(t);
      const pending = h.run.transcribe(new Float32Array([0.25]));
      const request = JSON.parse(await h.child.nextInput());

      h.child.response({ id: request.id, ...invalid });

      assert.equal(await pending, null);
      assert.deepEqual(
        h.warn.mock.calls.map(call => call.arguments[0]),
        ['voice.batch.bad-line'],
      );
    });
  }
});

test('a voice line that is not a reply with a request id is a bad protocol line', async t => {
  const h = await voice(t);
  const speech = h.run.chunks('still speaking');
  const chunk = speech.next();
  const request = JSON.parse(await h.child.nextInput());

  for (const value of stray) assert.doesNotThrow(() => h.child.response(value));

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments[0]),
    stray.map(() => 'voice.tts.bad-line'),
  );
  h.child.response({ id: request.id, audio: wav('heard'), final: true });
  assert.equal((await chunk).value?.toString(), 'heard');
  await speech.return(undefined);
});

test('a malformed voice reply ends its sentence at once instead of holding the voice until the timeout', async t => {
  for (const invalid of [{ audio: 42 }, { error: { message: 'bad shape' } }, { audio: wav('chunk'), final: 'false' }]) {
    await t.test(JSON.stringify(invalid), async t => {
      const h = await voice(t);
      const speech = h.run.chunks('never spoken');
      const chunk = speech.next();
      const request = JSON.parse(await h.child.nextInput());

      h.child.response({ id: request.id, ...invalid });

      assert.equal((await chunk).done, true, 'nothing of a malformed reply is spoken');
      assert.deepEqual(
        h.warn.mock.calls.map(call => call.arguments[0]),
        ['voice.tts.bad-line'],
      );
      const next = h.run.chunks('the next sentence');
      const spoken = next.next();
      const following = JSON.parse(await h.child.nextInput());
      h.child.response({ id: following.id, audio: wav('next'), final: true });
      assert.equal((await spoken).value?.toString(), 'next', 'the voice is free for the next sentence');
      await next.return(undefined);
    });
  }
});
