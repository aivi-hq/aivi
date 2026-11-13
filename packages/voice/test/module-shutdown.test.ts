import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceModule } from './module-fixture.ts';

test('module shutdown stops speech engines that are still loading and cannot resurrect them', async t => {
  for (const kind of ['stt', 'tts'] as const) {
    await t.test(kind, async t => {
      const h = voiceModule(t, { stt: { command: 'fake-stt' }, tts: { command: 'fake-tts' } });
      const entered = Promise.withResolvers<void>();
      const loading = Promise.withResolvers<void>();
      t.after(() => loading.resolve());
      const start = kind === 'stt' ? h.batchStart : h.ttsStart;
      const stop = kind === 'stt' ? h.batchStop : h.ttsStop;
      start.mock.mockImplementation(() => {
        entered.resolve();
        return loading.promise;
      });
      await h.start();
      const deps = h.room().deps;
      const get = kind === 'stt' ? deps.getStt : deps.getTts;
      const pending = get();
      await entered.promise;

      await h.stop();

      assert.equal(stop.mock.callCount(), 1, 'the loading process is still owned by the module');
      assert.equal(stop.mock.calls[0]!.this, start.mock.calls[0]!.this);
      loading.resolve();
      assert.equal(await pending, null, 'late readiness cannot bring a stopped endpoint back');
      assert.equal(await get(), null, 'a stopped module cannot create another engine');
      assert.equal(start.mock.callCount(), 1);
    });
  }
});

test('an engine killed before readiness settles as shutdown, not a new startup failure', async t => {
  const h = voiceModule(t, { stt: { command: 'fake-stt' } });
  const loading = Promise.withResolvers<void>();
  h.batchStart.mock.mockImplementation(() => loading.promise);
  await h.start();
  const pending = h.room().deps.getStt();

  await h.stop();
  loading.reject(new Error('process exited before ready'));

  assert.equal(await pending, null);
  assert.equal(h.batchStop.mock.callCount(), 1);
  assert.equal(h.warn.mock.callCount(), 0);
});
