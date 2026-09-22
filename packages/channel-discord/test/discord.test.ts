import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordConfigSchema } from '@aivi/core';
import { CHAT_COMMANDS } from '@aivi/host';
import { ApplicationCommandOptionType } from 'discord.js';
import { authorized, reaches } from '../src/config.ts';
import { DISCORD, discordCommands } from '../src/module.ts';

const config = discordConfigSchema.parse({
  applicationId: '10000000000000001',
  directory: '/librarian',
  messageContent: true,
  access: {
    channels: [
      { id: '10000000000000004', trigger: 'mention-to-start' },
      { id: '10000000000000006', trigger: 'any', sessions: 'channel' },
    ],
  },
});

const ME = '10000000000000002';

test('access policy: linked persons talk anywhere aivi listens, unlinked accounts nowhere', () => {
  const dm = {
    channelId: 'dm',
    userId: ME,
    guildId: null,
    parentId: null,
    isDM: true,
    mentioned: false,
    knownConversation: false,
    senderLinked: true,
  };
  assert.equal(authorized(config, dm), true, 'a linked person may DM');
  assert.equal(authorized(config, { ...dm, senderLinked: false }), false, 'an unlinked account may not');
  assert.equal(authorized(config, { ...dm, guildId: 'g' }), false, 'a DM route must not carry a guild');
  const home = {
    channelId: '10000000000000004',
    userId: ME,
    guildId: 'g',
    parentId: null,
    isDM: false,
    mentioned: true,
    knownConversation: false,
    senderLinked: true,
  };
  assert.equal(authorized(config, home), true, 'any linked person may ping the home channel');
  assert.equal(authorized(config, { ...home, senderLinked: false }), false, 'strangers are ignored in channels');
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
  const always = { ...home, channelId: '10000000000000006', mentioned: false };
  assert.equal(authorized(config, always), true, 'an always-on channel hears linked persons without a mention');
  assert.equal(authorized(config, { ...home, channelId: 'elsewhere', parentId: null }), false);
  assert.equal(
    authorized(config, { ...always, channelId: 'thread-2', parentId: '10000000000000006' }),
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

test('reaches: the place decides, the sender does not', () => {
  const base = {
    userId: ME,
    guildId: 'g',
    parentId: null,
    isDM: false,
    mentioned: false,
    knownConversation: false,
    senderLinked: false,
  };
  assert.equal(reaches(config, { ...base, channelId: '10000000000000004' }), true);
  assert.equal(reaches(config, { ...base, channelId: 'thread-1', parentId: '10000000000000004' }), true);
  assert.equal(reaches(config, { ...base, channelId: 'thread-1', parentId: '10000000000000006' }), false);
  assert.equal(reaches(config, { ...base, channelId: 'elsewhere' }), false);
  assert.equal(reaches(config, { ...base, channelId: 'dm', guildId: null, isDM: true }), true, 'DMs always reach');
  assert.equal(reaches(config, { ...base, channelId: 'dm', isDM: true }), false, 'the guild stays checked');
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
