import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { OpenCodeClient } from '@aivi/plugin';
import type { DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import { createVoiceModule } from '../src/module.ts';
import { voiceModule } from './module-fixture.ts';

test('voice startup releases persisted room leases before providing a fresh voice seat', async t => {
  const h = voiceModule(t);
  h.store.setRoomLease('old-room', 'lease-old');
  h.release.mock.mockImplementation(async id => {
    assert.equal(h.provide.mock.callCount(), 0);
    assert.equal(id, 'lease-old');
    return { ended: { id, pool: 'default', state: 'active' } };
  });

  await h.start();

  assert.equal(h.release.mock.callCount(), 1);
  assert.equal(h.registerCallback.mock.callCount(), 1);
  assert.equal(h.provide.mock.callCount(), 1);
  assert.equal(h.batchStart.mock.callCount(), 0);
  assert.equal(h.ttsStart.mock.callCount(), 0);
  assert.equal(h.opencode.mock.callCount(), 0);
});

test('the transcript tool reads real stored groups, speakers and bounded, filtered pages', async t => {
  const h = voiceModule(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T10:00:00Z') });
  const first = h.store.openTranscript('first');
  h.store.appendLine(first, 0, 1, 'Ada', 'first');
  const before = h.store.appendLine(first, 1, 2, 'Grace', 'second');
  h.store.appendLine(first, 2, 3, 'Ada', 'third');
  const second = h.store.openTranscript('second');
  h.store.appendLine(second, 0, 1, 'Ada', 'other meeting');
  h.store.identify(new Float32Array([1, 0]), 3, 0.5);
  await h.start();

  const groups = (await h.tool({ action: 'transcripts' })) as { transcripts: { source: string }[] };
  assert.deepEqual(
    groups.transcripts.map(group => group.source),
    ['second', 'first'],
  );
  const last = (await h.tool({ action: 'transcripts', last: 1 })) as typeof groups;
  assert.deepEqual(
    last.transcripts.map(group => group.source),
    ['second'],
  );
  const speakers = (await h.tool({ action: 'speakers' })) as { speakers: { name: string; samples: number }[] };
  assert.deepEqual(
    speakers.speakers.map(({ name, samples }) => ({ name, samples })),
    [{ name: 't1', samples: 1 }],
  );
  const all = (await h.tool({ action: 'lines' })) as { lines: { text: string }[] };
  assert.equal(all.lines.length, 4);
  const page = (await h.tool({ action: 'lines', transcript: first, speaker: 'Ada', before, last: 1 })) as typeof all;
  assert.deepEqual(
    page.lines.map(line => line.text),
    ['first'],
  );
  await assert.rejects(h.tool({ action: 'unknown' }), {
    status: 400,
    message: "action must be 'transcripts', 'lines' or 'speakers'",
  });
  await assert.rejects(h.tool({}), { status: 400 });
});

test('room openers inherit the module defaults and may override mode, agent, pool and resume window', async t => {
  const h = voiceModule(t, {
    pool: 'shared',
    resumeMinutes: 30,
    directory: '/voice',
    model: { providerID: 'p', modelID: 'm' },
  });
  await h.start();
  const adapter = h.adapter();

  adapter.room({ id: 'discord', label: 'default' });
  adapter.room({ id: 'meet', label: 'custom', mode: 'meeting', agent: 'listener', pool: 'meet', resumeMinutes: false });
  adapter.room({ id: 'meet', label: 'fresh', resumeMinutes: 0 });

  const [normal, custom, fresh] = h.rooms;
  assert.equal(normal!.deps.mode, 'call');
  assert.equal(normal!.deps.agent, 'assistant');
  assert.equal(normal!.deps.pool, 'shared');
  assert.equal(normal!.deps.resumeMinutes, 30);
  assert.equal(normal!.deps.directory, '/voice');
  assert.deepEqual(normal!.deps.model, { providerID: 'p', modelID: 'm' });
  assert.deepEqual(normal!.init.engineInput, { type: 'push' });
  assert.equal(normal!.deps.identity, undefined);
  assert.equal(normal!.deps.embedder, null);
  assert.equal(custom!.deps.mode, 'meeting');
  assert.equal(custom!.deps.agent, 'listener');
  assert.equal(custom!.deps.pool, 'meet');
  assert.equal(custom!.deps.resumeMinutes, false);
  assert.equal(fresh!.deps.resumeMinutes, 0);
  assert.equal(custom!.deps.sharedEngine, normal!.deps.sharedEngine);
  assert.equal(custom!.deps.servicesSignal, h.signal);
  assert.equal(custom!.deps.events, h.events);
});

test('speaker embedding configuration reaches the native adapter without loading a real model', async t => {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  const options: unknown[] = [];
  const created: unknown[] = [];
  class Embedder {
    constructor(config: unknown) {
      options.push(config);
      created.push(this);
    }
  }
  t.mock.method(sherpa, 'SpeakerEmbeddingExtractor', Embedder);
  const h = voiceModule(t, { identity: { model: '/fake/speaker.onnx', threshold: 0.7 } });
  await h.start();
  const room = h.room();

  assert.deepEqual(options, [{ model: '/fake/speaker.onnx', numThreads: 2, provider: 'cpu' }]);
  assert.equal(room.deps.embedder, created[0]);
  assert.deepEqual(room.deps.identity, { model: '/fake/speaker.onnx', threshold: 0.7 });
});

test('unconfigured speech endpoints remain absent without starting separate models', async t => {
  const h = voiceModule(t);
  await h.start();
  const room = h.room();

  assert.equal(await room.deps.getStt(), null);
  assert.equal(await room.deps.getTts(), null);
  assert.equal(h.batchStart.mock.callCount(), 0);
  assert.equal(h.ttsStart.mock.callCount(), 0);
});

test('speech endpoints share an in-flight start and cache only a successfully loaded engine', async t => {
  const h = voiceModule(t, { stt: { command: 'fake-stt' }, tts: { command: 'fake-tts' } });
  const batch = Promise.withResolvers<void>();
  const speech = Promise.withResolvers<void>();
  h.batchStart.mock.mockImplementation(() => batch.promise);
  h.ttsStart.mock.mockImplementation(() => speech.promise);
  await h.start();
  const deps = h.room().deps;

  const a = deps.getStt();
  const b = deps.getStt();
  const c = deps.getTts();
  const d = deps.getTts();
  assert.equal(a, b);
  assert.equal(c, d);
  assert.equal(h.batchStart.mock.callCount(), 1);
  assert.equal(h.ttsStart.mock.callCount(), 1);
  batch.resolve();
  speech.resolve();
  const [stt, tts] = await Promise.all([a, c]);
  assert.equal(await deps.getStt(), stt);
  assert.equal(await deps.getTts(), tts);
});

test('failed speech endpoint loads warn and can be retried on the next request', async t => {
  const h = voiceModule(t, { stt: { command: 'fake-stt' }, tts: { command: 'fake-tts' } });
  h.batchStart.mock.mockImplementationOnce(async () => {
    throw new Error('stt unavailable');
  });
  h.ttsStart.mock.mockImplementationOnce(async () => {
    throw new Error('tts unavailable');
  });
  await h.start();
  const deps = h.room().deps;

  assert.equal(await deps.getStt(), null);
  assert.equal(await deps.getTts(), null);
  assert.ok(await deps.getStt());
  assert.ok(await deps.getTts());
  assert.equal(h.batchStart.mock.callCount(), 2);
  assert.equal(h.ttsStart.mock.callCount(), 2);
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments[0]),
    ['voice.stt.start-failed', 'voice.tts.start-failed'],
  );
});

test('dispatcher callbacks route the queued seat once and release orphan grants with honest diagnostics', async t => {
  const h = voiceModule(t);
  await h.start();
  const room = h.room();
  const fulfill = t.mock.fn();
  const lease: DispatcherLeaseRef = { id: 'lease-1', pool: 'default', state: 'active' };
  room.deps.requestSeat('queue-1', { fulfill } as never);
  h.dispatch('queue-1', lease);
  assert.deepEqual(fulfill.mock.calls[0]!.arguments, [lease]);
  room.deps.requestSeat('queue-2', { fulfill } as never);
  room.deps.releaseSeat('queue-2');
  const released = Promise.withResolvers<void>();
  h.release.mock.mockImplementation(async () => {
    released.resolve();
    return { ended: lease };
  });
  h.dispatch('queue-2', lease);
  await released.promise;
  assert.equal(fulfill.mock.callCount(), 1);
  const warned = Promise.withResolvers<void>();
  h.warn.mock.mockImplementation(() => {
    warned.resolve();
  });
  h.release.mock.mockImplementation(async () => ({ pending: lease }));
  h.dispatch('queue-1', lease);
  await warned.promise;
  assert.equal(h.warn.mock.calls.at(-1)!.arguments[0], 'turns.lease.pending-kill');
  const failed = Promise.withResolvers<void>();
  h.warn.mock.mockImplementation(() => {
    failed.resolve();
  });
  h.release.mock.mockImplementation(async () => {
    throw new Error('release failed');
  });
  h.dispatch('unknown', lease);
  await failed.promise;
  assert.equal(h.warn.mock.calls.at(-1)!.arguments[0], 'turns.lease.lost');
});

test('capacity changes wake every room and module shutdown closes consumers before shared engines', async t => {
  const h = voiceModule(t, { stt: { command: 'fake-stt' }, tts: { command: 'fake-tts' } });
  await h.start();
  const first = h.room();
  const second = h.room();
  first.deps.capacityMoved();
  assert.equal(first.retryTurns.mock.callCount(), 1);
  assert.equal(second.retryTurns.mock.callCount(), 1);
  assert.equal(h.wake.mock.callCount(), 1);
  await first.deps.getStt();
  await first.deps.getTts();

  await h.stop();

  assert.deepEqual(h.order, ['release-tool', 'unprovide', 'room:meeting', 'room:meeting', 'shared', 'batch', 'tts']);
  assert.equal(h.tools.size, 0);
});

test('development rooms keep their own configured file or microphone source and mode', async t => {
  for (const source of [
    { type: 'file', path: '/audio.wav', mode: 'call' },
    { type: 'mic', device: 'input-1', mode: 'call' },
    { type: 'mic', mode: 'call' },
  ]) {
    await t.test(JSON.stringify(source), async t => {
      const h = voiceModule(t, { room: source });
      await h.start();
      const room = h.rooms[0]!;

      assert.equal(room.init.id, 'voice');
      assert.equal(room.init.label, source.type === 'file' ? source.path : `mic:${source.device ?? 'default'}`);
      assert.equal(room.init.streaming, true);
      assert.deepEqual(room.init.engineInput, h.config.room);
      assert.equal(room.deps.mode, 'call');
      assert.equal(room.deps.agent, 'assistant');
    });
  }
});

test('the default room constructor opens a push room without launching audio or discovering OpenCode', async t => {
  const h = voiceModule(t);
  const running = await createVoiceModule(h.config).start(h.services);
  t.after(() => running.stop());

  const room = h.adapter().room({ id: 'meet', label: 'default-room' });

  assert.equal(h.createRoom.mock.callCount(), 0);
  assert.equal(h.opencode.mock.callCount(), 0);
  await room.stop();
});

test('the room turn driver forwards the selected session and cancellation signal without starting a failed turn', async t => {
  const h = voiceModule(t);
  await h.start();
  const deps = h.room().deps;
  const failure = new Error('session unavailable');
  const get = t.mock.fn(async () => {
    throw failure;
  });
  const client = { session: { get } } as unknown as OpenCodeClient;

  await assert.rejects(
    deps.runTurn(
      client,
      { sessionId: 'ses_voice', messageId: 'msg_voice', text: 'hello', agent: 'assistant', directory: '/voice' },
      { signal: h.signal, log: h.log },
    ),
    { cause: failure },
  );

  assert.deepEqual(get.mock.calls[0]!.arguments, [{ sessionID: 'ses_voice' }, { signal: h.signal }]);
});
