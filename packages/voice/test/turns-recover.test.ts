import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, type Logger } from '@aivi/core';
import { Dispatcher as HostDispatcher, LeaseStore, Store } from '@aivi/host';
import type { Dispatcher } from '@aivi/plugin/dispatcher';
import { VoiceStore } from '../src/store.ts';
import { VoiceTurns } from '../src/turns.ts';

test('restart recovery says a lease is recovered only when its slot came back', async t => {
  const info = t.mock.fn();
  const warn = t.mock.fn();
  const forget = t.mock.fn<(label: string) => void>();
  const release = t.mock.fn<Dispatcher['release']>(async id => {
    if (id === 'lease-gone') throw new Error(`Lease ${id} was already gone`);
    const lease = { id, pool: 'voice-local', state: 'expiring' as const };
    return id === 'lease-stuck' ? { pending: lease } : { ended: lease };
  });

  await VoiceTurns.recover(
    [
      { label: 'discord:stuck', leaseId: 'lease-stuck' },
      { label: 'discord:gone', leaseId: 'lease-gone' },
      { label: 'meet:ended', leaseId: 'lease-ended' },
    ],
    release,
    forget,
    { info, warn } as unknown as Logger,
  );

  assert.deepEqual(
    release.mock.calls.map(call => call.arguments[0]),
    ['lease-stuck', 'lease-gone', 'lease-ended'],
    'one lease that cannot be returned does not stop the others',
  );
  assert.deepEqual(
    forget.mock.calls.map(call => call.arguments[0]),
    ['discord:stuck', 'discord:gone', 'meet:ended'],
    'the dispatcher was told about each: no note is replayed at the next start',
  );
  assert.deepEqual(
    info.mock.calls.map(call => call.arguments),
    [['turns.recovered', { room: 'meet:ended', lease: 'lease-ended' }]],
  );
  assert.deepEqual(
    warn.mock.calls.map(call => call.arguments),
    [['turns.lease.pending-kill', { room: 'discord:stuck', lease: 'lease-stuck', pool: 'voice-local' }]],
    'an unconfirmed kill keeps the slot held: that is said, not called a recovery',
  );
});

test('a slot a crashed voice turn left held is free after the next start, and its note is gone', async t => {
  // The dispatcher arms a clock for every lease; this test moves none of them.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const database = new Store(':memory:');
  t.after(() => database.close());
  const log = { info: t.mock.fn(), warn: t.mock.fn() } as unknown as Logger;
  const pools = configSchema.parse({ version: 1, dispatcher: { pools: { default: { capacity: 1 } } } }).dispatcher;
  const host = () =>
    new HostDispatcher({
      leases: new LeaseStore(database),
      dispatcher: pools,
      idleMs: 60_000,
      prepareMs: 60_000,
      opencode: async () => {
        throw new Error('returning a slot needs no OpenCode');
      },
    });
  const voice = new VoiceStore(database, log);
  const granted = host().request({ service: 'voice' });
  assert.ok('lease' in granted);
  voice.setRoomLease('discord:guild', granted.lease.id);

  // The host died with the turn. The next one reads the same database.
  const restarted = host();
  assert.equal(restarted.held(), 1, 'the dead turn still holds the only slot');
  await VoiceTurns.recover(
    voice.roomLeases(),
    id => restarted.release(id),
    label => voice.setRoomLease(label, null),
    log,
  );

  assert.equal(restarted.held(), 0);
  assert.deepEqual(voice.roomLeases(), [], 'the note has done its work');
  assert.ok('lease' in restarted.request({ service: 'voice' }), 'the pool has its slot again');
});
