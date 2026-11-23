import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '@aivi/core';
import type { ChannelModule } from '@aivi/plugin/channel';
import { Channels } from '../src/channel/router.ts';

const module = (id: string, overrides: Partial<ChannelModule> = {}): ChannelModule => ({
  id,
  accepts: () => true,
  ownsSession: () => false,
  channelOf: async () => undefined,
  reenter: async () => {},
  post: async () => {},
  ...overrides,
});
const toSession = { to: 'session', session: 'ses_1', on: 'always' } as const;
const run = { id: 'run-1' } as Run;

test('the registry says which modules are running, and which link hint each one carries', () => {
  const channels = new Channels();
  channels.register(module('discord', { linkHint: 'In Discord, DM the bot: /link <code>.' }));
  channels.register(module('slack'));

  assert.deepEqual(channels.ids(), ['discord', 'slack']);
  assert.equal(channels.has('slack'), true);
  assert.equal(channels.has('teams'), false);
  assert.deepEqual(channels.linkable(), [
    { id: 'discord', hint: 'In Discord, DM the bot: /link <code>.' },
    { id: 'slack' },
  ]);
});

test('a report to a session is refused when nothing can deliver it, and delivering it needs the run whose result it is', async () => {
  const bare = new Channels();
  assert.equal(bare.refuse(toSession), 'No session delivery is available');
  await assert.rejects(
    bare.deliver(toSession, 'done', { run, state: 'succeeded' }),
    /No session delivery is available/,
  );
  await assert.rejects(bare.deliver(toSession, 'done', { state: 'succeeded' }), /needs the run whose result it is/);

  const withModule = new Channels();
  withModule.register(module('discord'));
  assert.equal(withModule.refuse(toSession), undefined, 'a running module can own the session');
  assert.equal(new Channels(async () => {}).refuse(toSession), undefined, 'so can the native path');
});
