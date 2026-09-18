import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordConfigSchema } from '@aivi/core';
import { CHAT_COMMANDS } from '@aivi/host';
import { ApplicationCommandOptionType } from 'discord.js';
import { authorized } from '../src/config.ts';
import { DISCORD, discordCommands } from '../src/module.ts';

const config = discordConfigSchema.parse({
  applicationId: '10000000000000001',
  directory: '/librarian',
  messageContent: true,
  access: {
    dm: { users: ['10000000000000002'] },
    channels: [
      { id: '10000000000000004', users: 'anyone', trigger: 'mention-to-start' },
      { id: '10000000000000006', users: ['10000000000000002'], trigger: 'any', sessions: 'channel' },
    ],
  },
});

test('access policy: allow-listed DMs, mention-triggered public channels, restricted always-on channels, nothing else', () => {
  const dm = {
    channelId: 'dm',
    userId: '10000000000000002',
    guildId: null,
    parentId: null,
    isDM: true,
    mentioned: false,
    knownConversation: false,
  };
  assert.equal(authorized(config, dm), true);
  assert.equal(authorized(config, { ...dm, userId: 'stranger' }), false);
  assert.equal(authorized(config, { ...dm, guildId: 'g' }), false, 'a DM route must not carry a guild');
  assert.equal(authorized({ ...config, access: { channels: [] } }, dm), false, 'no dm block means nobody may DM');
  const home = {
    channelId: '10000000000000004',
    userId: 'stranger',
    guildId: 'g',
    parentId: null,
    isDM: false,
    mentioned: true,
    knownConversation: false,
  };
  assert.equal(authorized(config, home), true, 'anyone may ping the home channel');
  assert.equal(authorized(config, { ...home, mentioned: false }), false, 'home channel requires a mention');
  assert.equal(
    authorized(config, { ...home, channelId: 'thread-1', parentId: '10000000000000004' }),
    true,
    'threads inherit their parent channel policy',
  );
  const inThread = { ...home, channelId: 'thread-1', parentId: '10000000000000004', mentioned: false };
  assert.equal(
    authorized(config, { ...inThread, knownConversation: true }),
    true,
    'mention-to-start: no mention needed once aivi is in the thread',
  );
  assert.equal(authorized(config, inThread), false, 'a thread aivi is not part of still needs a mention');
  assert.equal(
    authorized(
      { ...config, access: { ...config.access, channels: [{ ...config.access.channels[0]!, trigger: 'mention' }] } },
      { ...inThread, knownConversation: true },
    ),
    false,
    'plain mention mode always needs a mention',
  );
  const restricted = { ...home, channelId: '10000000000000006', mentioned: false };
  assert.equal(
    authorized(config, { ...restricted, userId: '10000000000000002' }),
    true,
    'always-on channel hears listed users without a mention',
  );
  assert.equal(authorized(config, restricted), false, 'strangers are ignored in a restricted channel');
  assert.equal(authorized(config, { ...home, channelId: 'elsewhere', parentId: null }), false);
  assert.equal(
    authorized(config, {
      ...restricted,
      userId: '10000000000000002',
      channelId: 'thread-2',
      parentId: '10000000000000006',
    }),
    false,
    'channel mode ignores threads',
  );
  assert.equal(config.access.channels[0]!.sessions, 'threads', 'thread mode is the default');
  assert.throws(
    () =>
      discordConfigSchema.parse({
        applicationId: '10000000000000001',
        directory: '/l',
        access: { channels: [{ id: '10000000000000004' }] },
      }),
    /messageContent/,
  );
  assert.equal(config.access.channels[0]!.trigger, 'mention-to-start', 'natural thread behaviour is the default');
  assert.deepEqual(DISCORD, { id: 'discord', label: 'Discord', replyLimit: 1900 });
});

test('slash commands are the shared table, so a command cannot exist without a handler or vice versa', () => {
  const commands = discordCommands().map(c => c.toJSON());
  assert.deepEqual(
    commands.map(c => c.name),
    CHAT_COMMANDS.map(c => c.name),
  );
  const byName = new Map(commands.map(c => [c.name, c]));
  assert.equal(byName.get('new')!.options?.length ?? 0, 0);
  assert.deepEqual(
    byName.get('search')!.options!.map(o => [o.name, o.type, o.required]),
    [
      ['query', ApplicationCommandOptionType.String, true],
      ['project', ApplicationCommandOptionType.String, false],
    ],
  );
  const model = byName.get('model')!.options![0]!;
  assert.deepEqual(
    [model.name, model.required, (model as { autocomplete?: boolean }).autocomplete],
    ['model', false, true],
  );
  const steer = byName.get('steer')!.options![0]!;
  assert.deepEqual(
    [steer.name, steer.required, (steer as { autocomplete?: boolean }).autocomplete],
    ['text', true, false],
  );
  assert.ok(commands.every(c => c.description.length <= 100));
});
