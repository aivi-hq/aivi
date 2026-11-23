import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BatchEngineRun } from '../src/batch.ts';
import type { TtsRun } from '../src/tts.ts';
import { voiceModule } from './module-fixture.ts';
import { voiceProcesses } from './process-fixture.ts';

/** The module's lazy owners over the real endpoint clients: only the spawn
 *  boundary is faked, so a death is the process ending, not a stubbed flag. */
function endpoints(t: Parameters<typeof voiceModule>[0]) {
  const processes = voiceProcesses(t);
  const h = voiceModule(t, {
    stt: { command: 'fake-stt' },
    tts: { command: 'fake-tts', readyMarker: 'engine ready' },
  });
  for (const stub of [h.batchStart, h.batchStop, h.batchAlive, h.ttsStart, h.ttsStop, h.ttsAlive]) stub.mock.restore();
  return { ...h, processes };
}

test('a batch endpoint that dies after loading is replaced on the next request', async t => {
  const h = endpoints(t);
  await h.start();
  const { getStt } = h.room().deps;
  const hear = async (run: BatchEngineRun, child: (typeof h.processes.children)[number], text: string) => {
    const heard = run.transcribe(new Float32Array([0.25]));
    const request = JSON.parse(await child.nextInput());
    child.response({ id: request.id, text });
    return await heard;
  };
  const loading = getStt();
  h.processes.children[0]!.ready();
  const first = (await loading) as BatchEngineRun;
  assert.equal(await hear(first, h.processes.children[0]!, 'before the crash'), 'before the crash');

  h.processes.children[0]!.exit(3);
  const reloading = getStt();

  assert.equal(h.processes.spawn.mock.callCount(), 2, 'the dead endpoint is not handed out again');
  h.processes.children[1]!.ready();
  const second = (await reloading) as BatchEngineRun;
  assert.equal(second === first, false);
  assert.equal(await hear(second, h.processes.children[1]!, 'after the reload'), 'after the reload');
  assert.equal((await getStt()) === second, true, 'the live replacement stays warm');
  assert.equal(h.processes.spawn.mock.callCount(), 2);
});

test('a voice endpoint that dies after loading is replaced on the next answer', async t => {
  const h = endpoints(t);
  await h.start();
  const { getTts } = h.room().deps;
  const say = async (run: TtsRun, child: (typeof h.processes.children)[number], audio: string) => {
    const speech = run.chunks('hello');
    const chunk = speech.next();
    const request = JSON.parse(await child.nextInput());
    child.response({ id: request.id, audio: Buffer.from(audio).toString('base64'), final: true });
    const spoken = (await chunk).value?.toString();
    await speech.return(undefined);
    return spoken;
  };
  const loading = getTts();
  h.processes.children[0]!.ready();
  const first = (await loading)!;
  assert.equal(await say(first, h.processes.children[0]!, 'before the crash'), 'before the crash');

  h.processes.children[0]!.exit(3);
  const reloading = getTts();

  assert.equal(h.processes.spawn.mock.callCount(), 2, 'the dead voice is not handed out again');
  h.processes.children[1]!.ready();
  const second = (await reloading)!;
  assert.equal(second === first, false);
  assert.equal(await say(second, h.processes.children[1]!, 'after the reload'), 'after the reload');
  assert.equal((await getTts()) === second, true, 'the live replacement stays warm');
  assert.equal(h.processes.spawn.mock.callCount(), 2);
});

test('an endpoint that dies in the same turn as its ready marker is not cached as loaded', async t => {
  const h = endpoints(t);
  await h.start();
  const { getStt } = h.room().deps;
  const loading = getStt();

  h.processes.children[0]!.ready();
  h.processes.children[0]!.exit(3);

  assert.equal((await loading) === null, true, 'a ready answer must not hand out the process that already exited');
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments[0]),
    ['voice.batch.exited'],
    'the exit is said once, by the client that saw it',
  );
  const reloading = getStt();
  assert.equal(h.processes.spawn.mock.callCount(), 2);
  h.processes.children[1]!.ready();
  assert.equal((await reloading) === null, false);
});
