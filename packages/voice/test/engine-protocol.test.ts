import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineFixture } from './process-fixture.ts';

test('non-object JSON from an engine is a bad protocol line, not an event or an uncaught exception', async t => {
  const h = engineFixture(t);
  await h.start();
  const child = h.children[0]!;

  for (const value of [null, true, 42, 'not an event', []]) assert.doesNotThrow(() => child.response(value));

  assert.equal(h.events.mock.callCount(), 0);
  assert.equal(h.warn.mock.callCount(), 5);
  child.response({ ev: 'delta', text: 'still listening', pos: 1 });
  assert.equal(h.events.mock.callCount(), 1);
});

test('an engine error response cannot certify text attached to that failed request', async t => {
  const h = engineFixture(t);
  await h.start();
  const child = h.children[0]!;
  const pending = h.run.transcribe(new Float32Array([0.25]));
  const request = JSON.parse(await child.nextInput());

  child.response({ id: request.id, error: 'decode failed', text: 'not authoritative' });

  assert.equal(await pending, null);
  assert.equal(h.warn.mock.calls[0]!.arguments[0], 'voice.engine.batch-error');
});

test('malformed replies for a known request settle as loss rather than throwing or leaving its promise orphaned', async t => {
  for (const invalid of [{ text: 42 }, { error: { message: 'bad shape' } }]) {
    await t.test(JSON.stringify(invalid), async t => {
      const h = engineFixture(t);
      await h.start();
      const child = h.children[0]!;
      const pending = h.run.transcribe(new Float32Array([0.25]));
      const request = JSON.parse(await child.nextInput());

      assert.doesNotThrow(() => child.response({ id: request.id, ...invalid }));

      assert.equal(await pending, null);
      assert.equal(h.warn.mock.calls[0]!.arguments[0], 'voice.engine.bad-line');
    });
  }
});

test('malformed event fields cannot produce made-up transcript words or invalid positions', async t => {
  const h = engineFixture(t);
  await h.start();
  const child = h.children[0]!;
  const invalid = [
    { ev: 'delta', text: 42, pos: 1 },
    { ev: 'delta', text: 'wrong position', pos: '1' },
    { ev: 'delta', text: 'wrong lane', pos: 1, lane: 42 },
    { ev: 'act', t: '1', slot: 0 },
    { ev: 'act', t: 1, slot: '0' },
    { ev: 'session_reset', pos: '1' },
    { ev: 'session_reset', pos: 1, lane: 42 },
    { ev: 'lane_end' },
    { ev: 'diar', on: 'true' },
    { ev: 'unknown' },
  ];

  for (const event of invalid) assert.doesNotThrow(() => child.response(event));
  child.stdout.write('{"ev":"delta","text":"non-finite","pos":1e400}\n');

  assert.equal(h.events.mock.callCount(), 0);
  assert.equal(h.warn.mock.callCount(), invalid.length + 1);
});

test('valid protocol events retain their fields, including lane tags and additional metadata', async t => {
  const h = engineFixture(t);
  await h.start();
  const child = h.children[0]!;
  const events = [
    { ev: 'delta', text: 'hello', pos: 1, lane: 'speaker', extra: 'kept' },
    { ev: 'act', t: 1, slot: -1 },
    { ev: 'session_reset', pos: 2 },
    { ev: 'session_reset', pos: 2, lane: 'speaker' },
    { ev: 'lane_end', lane: 'speaker' },
    { ev: 'diar', on: true },
    { ev: 'eof' },
  ];

  for (const event of events) child.response(event);

  assert.deepEqual(
    h.events.mock.calls.map(call => call.arguments[0]),
    events,
  );
  assert.equal(h.run.eof, true);
  assert.equal(h.warn.mock.callCount(), 0);
});

test('batch replies trim real text, settle missing or empty text as loss and ignore late duplicates', async t => {
  const h = engineFixture(t);
  await h.start();
  const child = h.children[0]!;
  for (const text of [undefined, '  ', ' heard ']) {
    const pending = h.run.transcribe(new Float32Array([0.25]));
    const request = JSON.parse(await child.nextInput());
    child.response({ id: request.id, ...(text !== undefined ? { text } : {}) });
    assert.equal(await pending, text?.trim() || null);
    child.response({ id: request.id, text: 'late duplicate' });
  }
  assert.equal(h.events.mock.callCount(), 0);
  assert.equal(h.warn.mock.callCount(), 0);
});
