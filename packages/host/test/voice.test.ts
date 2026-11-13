/** The voice seat: one adapter, honest failure without one (the contract is
 *  the kit's `Voice`; the voice module provides, every room holder asks). */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type VoiceAdapter, VoiceNotLoaded, type VoiceRoom } from '@aivi/plugin/voice';
import { Voice } from '../src/voice.ts';

const fakeRoom = {
  feed() {},
  async heard() {
    return null;
  },
  mouth() {
    return () => {};
  },
  bargeIn() {},
  lane: () => ({ push() {}, end: async () => null, abort() {} }),
  onEvent() {
    return () => {};
  },
  async stop() {},
};

const adapter: VoiceAdapter = { room: () => fakeRoom as VoiceRoom };

test('the seat fails honestly until the voice module provides an adapter', () => {
  const voice = new Voice();
  assert.throws(() => voice.room({ id: 'discord', label: 'a guild' }), VoiceNotLoaded);
  const off = voice.provide(adapter);
  assert.equal(voice.room({ id: 'discord', label: 'a guild' }), fakeRoom as VoiceRoom, 'after provide, rooms open');
  assert.throws(() => voice.provide(adapter), /already provided/, 'a second provider is a bug, and says so');
  off();
  assert.throws(() => voice.room({ id: 'discord', label: 'a guild' }), VoiceNotLoaded, 'unprovide closes the seat');
});

test('room origins are unique and retained after an adapter leaves', () => {
  const voice = new Voice();
  assert.deepEqual(voice.origins(), []);
  assert.throws(() => voice.room({ id: 'unopened', label: 'no adapter' }), VoiceNotLoaded);
  assert.deepEqual(voice.origins(), [], 'a failed open is not an origin');
  const off = voice.provide(adapter);
  voice.room({ id: 'discord', label: 'one guild' });
  voice.room({ id: 'discord', label: 'another guild' });
  voice.room({ id: 'meet', label: 'a meeting' });
  off();
  assert.deepEqual(voice.origins(), ['discord', 'meet']);
});

test('a stale unprovide cannot remove a replacement adapter, and room options pass through unchanged', () => {
  const voice = new Voice();
  const staleOff = voice.provide(adapter);
  staleOff();
  const options = { id: 'meet', label: 'a meeting', mode: 'meeting' as const };
  const off = voice.provide({
    room: received => {
      assert.equal(received, options);
      return fakeRoom as VoiceRoom;
    },
  });
  staleOff();
  assert.equal(voice.room(options), fakeRoom);
  off();
  assert.throws(() => voice.room(options), VoiceNotLoaded);
});
