import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@aivi/core';
import type { Dispatcher } from '@aivi/plugin/dispatcher';
import { VoiceTurns } from '../src/turns.ts';

test('restart recovery says a lease is recovered only when its slot came back', async t => {
  const info = t.mock.fn();
  const warn = t.mock.fn();
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
    { info, warn } as unknown as Logger,
  );

  assert.deepEqual(
    release.mock.calls.map(call => call.arguments[0]),
    ['lease-stuck', 'lease-gone', 'lease-ended'],
    'one lease that cannot be returned does not stop the others',
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
