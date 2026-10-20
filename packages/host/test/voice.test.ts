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
