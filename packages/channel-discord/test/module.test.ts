/** The Discord module as `aivi serve` runs it: started over the services a
 *  module is handed, with `discord.js` replaced by fakes (the client the
 *  module builds, and the REST that registers its commands) and the voice
 *  watcher replaced by a spy. The host's own machinery is real: the
 *  conversation store on an in-memory database, the channel engine over a
 *  stand-in dispatcher, the channel registry. A test sends events into the
 *  fake client and reads what the module did to Discord, to the inbox and to
 *  the log. The slash commands are `commands.test.ts`'s subject. */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mock, type TestContext, test } from 'node:test';
import { jobSchema, taskSchema } from '@aivi/core';
import { CHAT_COMMANDS } from '@aivi/host';
import { ConfigurationError } from '@aivi/plugin';
import type { DeliveryContext } from '@aivi/plugin/channel';
import { VoiceNotLoaded } from '@aivi/plugin/voice';
import { Events, GatewayIntentBits, InteractionContextType, Partials } from 'discord.js';
import {
  APP,
  BOT,
  world as baseWorld,
  DIRECTORY,
  DM,
  discord,
  discordExports,
  dmChannel,
  type FakeChannel,
  forumChannel,
  GUILD,
  HOME,
  ME,
  MENTIONS_BOT,
  messageIn,
  REPORTS,
  runOf,
  SAFE,
  STRANGER,
  settle,
  startedInDm,
  startedInHome,
  startedWithRunningTurn,
  TEAM,
  TOKEN,
  textChannel,
  threadChannel,
  type World,
} from './module-fixture.ts';

const watchVoice = mock.fn((..._watch: unknown[]) => ({ stop: async () => {} }));
mock.module('discord.js', { exports: discordExports });
mock.module('../src/voice.ts', { exports: { watchVoice } });

const unit = await import('../src/module.ts');
type Options = Parameters<typeof baseWorld>[2];
const world = (t: TestContext, options?: Options) => baseWorld(t, unit, options);

type Calls = { mock: { calls: Array<{ arguments: unknown[] }> } };
const calls = (fn: Calls) => fn.mock.calls.map(call => call.arguments);

test('start logs in with the token, says it is ready, registers the commands and announces itself in the report channels', async t => {
  const w = world(t);

  await w.start();
  await settle();

  assert.deepEqual(discord.tokens, [TOKEN]);
  assert.deepEqual(w.said('info'), [
    { event: 'ready', application: APP, agent: 'assistant', reportChannels: 1 },
    { event: 'commands.registered', commands: CHAT_COMMANDS.map(c => c.name) },
  ]);
  assert.deepEqual(calls(w.reports.send), [[{ content: '🟢 aivi is online.', ...SAFE }]]);
});

for (const [name, channel] of [
  ['unknown to the bot', null],
  ['one it cannot send to', { ...textChannel(REPORTS), isSendable: () => false }],
] as const) {
  test(`an announcement to a report channel that is ${name} is logged and does not fail the start`, async t => {
    const w = world(t);
    w.places.set(REPORTS, channel);

    await w.start();
    await settle();

    assert.deepEqual(
      w.said('warn').map(({ event, channel, error }) => [event, channel, (error as Error).message]),
      [['presence.notify_failed', REPORTS, 'Discord channel is not sendable']],
    );
    assert.equal(w.client.isReady(), true);
  });
}

test('the commands are put to Discord in one bulk overwrite, for guilds and DMs, under the bot token', async t => {
  const w = world(t);

  await w.start();
  await settle();

  const [rest] = discord.rests;
  assert.deepEqual(rest!.options, { version: '10', timeout: 15000, retries: 0 });
  assert.equal(rest!.token, TOKEN);
  const [[route, request]] = calls(discord.put) as [[string, { body: { name: string; contexts: unknown[] }[] }]];
  assert.equal(route, `/applications/${APP}/commands`);
  assert.deepEqual(
    request.body.map(command => command.name),
    CHAT_COMMANDS.map(c => c.name),
  );
  for (const command of request.body)
    assert.deepEqual(command.contexts, [InteractionContextType.Guild, InteractionContextType.BotDM]);
});

test('a failed registration of the commands is logged and the module keeps running', async t => {
  const w = world(t);
  const failure = new Error('Discord is slow');
  discord.put = mock.fn(async () => {
    throw failure;
  });

  await w.start();
  await settle();

  assert.deepEqual(w.said('warn'), [{ event: 'commands.register_failed', error: failure }]);
  assert.equal(w.client.isReady(), true);
});

for (const [name, config, intents] of [
  ['without message content or voice', { messageContent: false, access: { channels: [] } }, []],
  ['with message content', {}, [GatewayIntentBits.MessageContent]],
  [
    'with a voice block',
    { voice: { guild: GUILD, channels: [HOME] } },
    [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
  ],
] as const) {
  test(`the gateway client is built ${name}: its intents, DM partials, no pings, no cached messages`, async t => {
    const w = world(t, { config });

    await w.start();

    const { makeCache, ...options } = w.client.options as {
      makeCache: (...manager: unknown[]) => { maxSize?: number };
    };
    assert.deepEqual(options, {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        ...intents,
      ],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
      rest: { timeout: 15000, retries: 0 },
    });
    const manager = (name: string) => makeCache({ name }, undefined, { name });
    assert.equal(manager('MessageManager').maxSize, 0, 'messages are not kept in memory');
    assert.equal(manager('GuildManager').maxSize, undefined, 'everything else is');
  });
}

test('the token may come from DISCORD_TOKEN', async t => {
  const w = world(t, { env: { DISCORD_TOKEN: 'other-token' } });

  await w.start();

  assert.deepEqual(discord.tokens, ['other-token']);
});

test('without a token the start is refused as a configuration error, before any client exists', async t => {
  const w = world(t, { env: {} });

  await assert.rejects(
    w.start(),
    error => error instanceof ConfigurationError && /^DISCORD_BOT_TOKEN is required/.test(error.message),
  );

  assert.equal(discord.clients.length, 0);
});

test('a token Discord rejects is a configuration error; any other login failure is passed on as it is', async t => {
  const w = world(t);
  discord.login = async () => {
    throw Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' });
  };
  await assert.rejects(
    w.start(),
    error => error instanceof ConfigurationError && error.message === 'An invalid token was provided.',
  );

  const outage = new Error('getaddrinfo ENOTFOUND discord.com');
  discord.login = async () => {
    throw outage;
  };
  await assert.rejects(w.start(), error => error === outage);

  assert.equal(discord.destroy.mock.callCount(), 2, 'each failed start closed its client');
});

test('a token of another application is refused, and the client is closed', async t => {
  const w = world(t);
  discord.applicationId = '10000000000000777';

  await assert.rejects(
    w.start(),
    error =>
      error instanceof ConfigurationError && error.message === 'Discord token does not match configured application',
  );

  assert.equal(discord.destroy.mock.callCount(), 1);
});

test('a host that goes down while the gateway is still connecting ends the start', async t => {
  const w = world(t);
  discord.login = async () => {
    w.abort();
    return TOKEN;
  };

  await assert.rejects(w.start(), error => (error as Error).name === 'AbortError');

  assert.equal(discord.destroy.mock.callCount(), 1);
});

test('gateway troubles are logged and never thrown: the module outlives them', async t => {
  const w = world(t);
  await w.start();
  const failure = new Error('socket closed');

  w.client.emit(Events.Error, failure);
  w.client.emit(Events.Warn, 'heartbeat is late');
  w.client.emit(Events.ShardDisconnect);
  w.client.emit(Events.ShardResume);

  assert.deepEqual(w.said('warn'), [
    { event: 'gateway.error', error: failure },
    { event: 'gateway.warn', message: 'heartbeat is late' },
    { event: 'gateway.disconnected' },
  ]);
  assert.deepEqual(w.said('info').at(-1), { event: 'gateway.resumed' });
});

test('a binding that changed is said at start: every conversation begins a fresh session on its next message', async t => {
  const w = world(t);
  unit.openDiscordStore(w.store, { ...w.config, agent: 'writer' }); // another agent held the inbox before

  await w.start();

  assert.deepEqual(w.said('warn'), [
    { event: 'binding.changed', hint: 'Every conversation starts a fresh session on its next message.' },
  ]);
});

test('turns a restart interrupted are discarded at start, and each conversation is told once what it may have lost', async t => {
  const w = world(t);
  const working = w.know(dmChannel(DM));
  const replying = w.know(textChannel(TEAM));
  const refusing = w.know({
    ...textChannel('10000000000000032'),
    send: mock.fn(async (_payload: unknown): Promise<never> => {
      throw new Error('Missing Permissions');
    }),
  });
  // one turn was working in a DM; two in TEAM, one of them already replying; one in a channel the bot cannot
  // find any more; one in a channel it may not write to
  for (const [id, channel] of [
    ['t1', DM],
    ['t2', TEAM],
    ['t3', TEAM],
    ['t4', '10000000000000031'],
    ['t5', refusing.id],
  ] as const) {
    w.inbox.enqueue({ id, channel, user: ME, name: 'Me', text: id }, 100);
    w.inbox.claimTurn(id);
  }
  w.inbox.result('t3', 'half an answer');

  await w.start();
  await settle();

  assert.deepEqual(
    w.said('warn').map(({ event, ...fields }) => [event, fields.discarded ?? fields.channel]),
    [
      ['turns.interrupted', 5],
      ['notify.failed', refusing.id],
    ],
  );
  assert.deepEqual(calls(working.send), [
    [{ content: 'I was restarted while working on your last message. Please send it again.', ...SAFE }],
  ]);
  assert.deepEqual(calls(replying.send), [
    [
      {
        content: 'I was restarted while replying, so my last answer may be incomplete. Ask again if you need it.',
        ...SAFE,
      },
    ],
  ]);
  assert.deepEqual(
    w.inbox.list().map(turn => turn.state),
    ['discarded', 'discarded', 'discarded', 'discarded', 'discarded'],
    'nothing is answered after the restart',
  );
});

test('stop says goodbye in the report channels, tells the conversations still waiting, and gives the host everything back', async t => {
  const w = world(t, { capacity: 0 });
  const dm = w.know(dmChannel(DM));
  w.link();
  await w.start();
  await settle();
  w.client.emit(Events.MessageCreate, messageIn(dm)); // the pool has no room: the message waits
  await settle();
  w.reports.send.mock.resetCalls();
  assert.equal(getEventListeners(w.services.signal, 'abort').length, 1);

  await w.stop();

  assert.deepEqual(calls(w.reports.send), [
    [{ content: '🔴 aivi is going offline (a restart or shutdown).', ...SAFE }],
  ]);
  assert.deepEqual(calls(dm.send).at(-1), [
    {
      content:
        'I am going offline for a moment (a restart or shutdown). Your message stays queued and I will answer it when I am back.',
      ...SAFE,
    },
  ]);
  assert.equal(w.channels.has('discord'), false, 'no longer a report destination');
  assert.equal(w.unwatch.mock.callCount(), 1, 'the wake listener is given back');
  assert.deepEqual(
    [...new Set(w.dispatcher.cancelled)],
    ['req_1'],
    'the place the waiting turn held in the pool is given back',
  );
  assert.equal(discord.destroy.mock.callCount(), 1);
  assert.equal(getEventListeners(w.services.signal, 'abort').length, 0, 'the host signal is released');
});

test('a gateway that dropped is not told goodbye, but its client is still closed', async t => {
  const w = world(t);
  await w.start();
  await settle();
  w.reports.send.mock.resetCalls();
  w.client.ready = false;

  await w.stop();

  assert.equal(w.reports.send.mock.callCount(), 0);
  assert.equal(discord.destroy.mock.callCount(), 1);
});

test('the client is closed and the host signal released even when the voice watcher cannot stop', async t => {
  const w = world(t, { config: { voice: { guild: GUILD, channels: [HOME] } } });
  const failure = new Error('voice is stuck');
  watchVoice.mock.mockImplementationOnce(() => ({
    stop: async () => {
      throw failure;
    },
  }));
  await w.start();

  await assert.rejects(w.stop(), error => error === failure);

  assert.equal(discord.destroy.mock.callCount(), 1);
  assert.equal(getEventListeners(w.services.signal, 'abort').length, 0);
});

test('a host that goes down stops the module taking turns: what arrives afterwards is ignored', async t => {
  const w = world(t);
  const dm = w.know(dmChannel(DM));
  w.link();
  await w.start();
  const message = messageIn(dm);

  w.abort();
  w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.deepEqual(w.inbox.list(), []);
  assert.equal(message.reply.mock.callCount() + message.react.mock.callCount(), 0);
});

test('without a voice block no voice watcher is started', async t => {
  const w = world(t);
  watchVoice.mock.resetCalls();

  await w.start();

  assert.equal(watchVoice.mock.callCount(), 0);
});

test('a voice block starts the watcher on the same client, with the room it opens, the people it knows and the module log', async t => {
  const voice = { guild: GUILD, channels: [HOME], mode: 'meeting', agent: 'scribe' };
  const w = world(t, { config: { voice } });
  const room = { stop: async () => {} };
  w.services.voice.room.mock.mockImplementation(() => room);
  watchVoice.mock.resetCalls();
  w.link(ME, 'Ada');

  await w.start();

  const [[deps]] = calls(watchVoice) as [
    [{ client: unknown; config: unknown; openRoom: () => unknown; personName: (user: string) => string | undefined }],
  ];
  assert.equal(deps.client, w.client);
  assert.deepEqual(deps.config, { ...voice, silenceMs: 500 });
  assert.equal(deps.openRoom(), room);
  assert.deepEqual(calls(w.services.voice.room), [
    [{ id: 'discord', label: `discord:${GUILD}`, mode: 'meeting', agent: 'scribe' }],
  ]);
  assert.deepEqual([deps.personName(ME), deps.personName(STRANGER)], ['Ada', undefined]);
});

test('a voice room speaks as the module agent unless the voice block names another', async t => {
  const w = world(t, { config: { agent: 'helper', voice: { guild: GUILD, channels: [HOME] } } });
  watchVoice.mock.resetCalls();
  await w.start();
  const [[deps]] = calls(watchVoice) as [[{ openRoom: () => unknown }]];

  deps.openRoom();

  assert.deepEqual(calls(w.services.voice.room), [
    [{ id: 'discord', label: `discord:${GUILD}`, mode: 'call', agent: 'helper' }],
  ]);
});

test('a missing voice plugin gives no room, and any other failure to open one is passed on', async t => {
  const w = world(t, { config: { voice: { guild: GUILD, channels: [HOME] } } });
  watchVoice.mock.resetCalls();
  await w.start();
  const [[deps]] = calls(watchVoice) as [[{ openRoom: () => unknown }]];

  w.services.voice.room.mock.mockImplementation(() => {
    throw new VoiceNotLoaded();
  });
  assert.equal(deps.openRoom(), null);

  const failure = new Error('the engine fell over');
  w.services.voice.room.mock.mockImplementation(() => {
    throw failure;
  });
  assert.throws(
    () => deps.openRoom(),
    error => error === failure,
  );
});

/** What a job's report delivers through the host's registry, as `channels.deliver` hands it to the module. */
const deliver = (w: World, channel: string, text: string, context: DeliveryContext = {}) =>
  w.channels.deliver({ to: 'channel', module: 'discord', channel, on: 'always' }, text, context);

const job = (title?: string) =>
  jobSchema.parse({
    id: 'job-1',
    ...(title ? { title } : {}),
    at: new Date(Date.now() + 86_400_000).toISOString(),
    task: 'system.check',
  });

test('Discord is a report destination for its report channels only, and says how a person links', async t => {
  const w = world(t);
  await w.start();

  assert.equal(w.channels.refuse({ to: 'channel', module: 'discord', channel: REPORTS, on: 'always' }), undefined);
  assert.equal(
    w.channels.refuse({ to: 'channel', module: 'discord', channel: HOME, on: 'always' }),
    `Module "discord" does not allow posting to ${HOME}`,
  );
  assert.deepEqual(w.channels.linkable(), [{ id: 'discord', hint: 'In Discord, DM the bot: /link <code>.' }]);
});

test('a report is posted in the channel, and a thread opens under it that continues the job’s own session', async t => {
  const w = world(t);
  w.store.addJob(job('Nightly digest'), 'operator');
  await w.start();
  await settle();
  w.reports.send.mock.resetCalls();
  const outcome = `${'x'.repeat(1900)}${'y'.repeat(1900)}${'z'.repeat(200)}`;

  await deliver(w, REPORTS, outcome, { run: runOf(), state: 'succeeded' });

  const opener = w.reports.openers.at(-1)!;
  assert.deepEqual(calls(w.reports.send), [[{ content: 'x'.repeat(1900), ...SAFE }]]);
  assert.deepEqual(calls(opener.startThread), [
    [{ name: 'Nightly digest', autoArchiveDuration: 1440, reason: 'aivi run run-1' }],
  ]);
  assert.deepEqual(calls(opener.thread.send), [
    [{ content: 'y'.repeat(1900), ...SAFE }],
    [{ content: 'z'.repeat(200), ...SAFE }],
  ]);
  assert.deepEqual(w.inbox.sessionOf(opener.thread.id), {
    session: 'ses_aivi_job1',
    ready: true,
    agent: 'assistant',
    directory: DIRECTORY,
    model: null,
    project: null,
    issue: null,
  });
  assert.equal(w.channels.ownerOf('ses_aivi_job1'), 'discord', 'replies in the thread are the job’s session');
});

for (const [name, run] of [
  ['a job that never opened a session', () => runOf({ sessionId: null })],
  ['a script job', () => runOf({ task: taskSchema.parse({ kind: 'shell', command: ['true'] }) })],
  ['a notice that belongs to no job', () => undefined],
] as const) {
  test(`the thread of a report of ${name} starts a fresh session seeded with the text`, async t => {
    const w = world(t);
    await w.start();
    await settle();
    const context = run();

    await deliver(w, REPORTS, 'the output', { ...(context ? { run: context } : {}), state: 'succeeded' });

    const { thread } = w.reports.openers.at(-1)!;
    const binding = w.inbox.sessionOf(thread.id)!;
    assert.deepEqual([binding.ready, binding.agent, binding.directory], [false, null, null]);
    assert.match(binding.session, /^ses_discord_/);
  });
}

for (const [name, setup, run, title, text, expected] of [
  ['the job’s own title', () => job('Nightly digest'), runOf(), undefined, 'out', 'Nightly digest'],
  ['the post’s title when the job has none', () => job(), runOf(), 'Weekly notes', 'out', 'Weekly notes'],
  ['the first line when neither has a title', () => job(), runOf(), undefined, '\n\nfirst line\nsecond', 'first line'],
  ['the first line when the job was removed since', () => undefined, runOf(), undefined, 'Result:\nmore', 'Result:'],
  ['the post’s title for a notice', () => undefined, undefined, 'Notice', 'out', 'Notice'],
  [
    'a first line cut to 79 characters and an ellipsis',
    () => undefined,
    undefined,
    undefined,
    'y'.repeat(81),
    `${'y'.repeat(79)}…`,
  ],
  [
    'a first line of exactly 80 characters as it is',
    () => undefined,
    undefined,
    undefined,
    'z'.repeat(80),
    'z'.repeat(80),
  ],
] as const) {
  test(`the thread of a report is named by ${name}`, async t => {
    const w = world(t);
    const added = setup();
    if (added) w.store.addJob(added, 'operator');
    await w.start();
    await settle();

    await deliver(w, REPORTS, text, { ...(run ? { run } : {}), ...(title ? { title } : {}), state: 'succeeded' });

    const [[options]] = calls(w.reports.openers.at(-1)!.startThread) as [[{ name: string }]];
    assert.equal(options.name, expected);
  });
}

for (const [name, shape] of [
  ['a thread', () => threadChannel(REPORTS, HOME)],
  ['a DM', () => dmChannel(REPORTS)],
  ['a forum channel', () => forumChannel(REPORTS)],
  [
    'a channel that cannot hold threads',
    () => {
      const { threads: _threads, ...bare } = textChannel(REPORTS);
      return bare;
    },
  ],
] as const) {
  test(`a report posted in ${name} opens no thread: every chunk goes where the first went`, async t => {
    const w = world(t);
    const channel = w.know(shape());
    await w.start();
    await settle();
    channel.send.mock.resetCalls();

    await deliver(w, REPORTS, `${'a'.repeat(1900)}b`, { state: 'succeeded' });

    assert.deepEqual(calls(channel.send), [[{ content: 'a'.repeat(1900), ...SAFE }], [{ content: 'b', ...SAFE }]]);
    assert.equal(channel.openers.at(-1)!.startThread.mock.callCount(), 0);
  });
}

test('a thread that cannot be opened for a report is logged, and the rest of the report goes to the channel', async t => {
  const w = world(t);
  await w.start();
  await settle();
  w.reports.send.mock.resetCalls();
  const failure = new Error('Missing Permissions');
  w.reports.refusal.thread = failure;

  await deliver(w, REPORTS, `${'a'.repeat(1900)}b`, { state: 'succeeded' });

  assert.deepEqual(w.said('warn'), [{ event: 'report.thread.failed', channel: REPORTS, error: failure }]);
  assert.deepEqual(calls(w.reports.send), [[{ content: 'a'.repeat(1900), ...SAFE }], [{ content: 'b', ...SAFE }]]);
});

test('a report for a channel outside the report channels is refused before anything is sent', async t => {
  const w = world(t);
  const elsewhere = w.know(textChannel(HOME));
  await w.start();
  await settle();

  await assert.rejects(deliver(w, HOME, 'text'), new Error(`Discord channel ${HOME} is not in reportChannels`));

  assert.equal(elsewhere.send.mock.callCount(), 0);
});

test('a report for a channel the bot cannot send to fails', async t => {
  const w = world(t);
  await w.start();
  await settle();
  w.places.set(REPORTS, { ...textChannel(REPORTS), isSendable: () => false });

  await assert.rejects(deliver(w, REPORTS, 'text'), new Error('Discord channel is not sendable'));
});

/** A started module with one linked person (the account ME is Ada), a DM channel Discord knows, and the gateway
 *  ready. */
const inDm = (t: TestContext, options?: Options) => startedInDm(t, unit, options);

/** A started module with one linked person and the HOME channel, where a mention starts a conversation in a thread. */
const inHome = (t: TestContext, options?: Options) => startedInHome(t, unit, options);

/** A started module whose DM has a turn running, parked at OpenCode until `finishTurn`. */
const running = (t: TestContext, options?: Options) => startedWithRunningTurn(t, unit, options);

test('a linked person’s DM becomes a turn in the DM’s conversation, and the answer is sent back there', async t => {
  const { w, dm } = await inDm(t);
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, messageIn(dm, { id: 'm-1', content: 'what is aivi?' }));
  await ended;

  assert.deepEqual(calls(dm.send), [[{ content: 'Answer', ...SAFE }]]);
  assert.deepEqual(
    w.inbox.list().map(turn => [turn.id, turn.channel, turn.user, turn.name, turn.state]),
    [['m-1', DM, ME, 'Me', 'sent']],
  );
});

for (const [name, over] of [
  ['a bot', { author: { id: STRANGER, bot: true, displayName: 'Bot' } }],
  ['a webhook', { webhookId: '10000000000000040' }],
  ['Discord itself', { system: true }],
] as const) {
  test(`a message from ${name} is ignored`, async t => {
    const { w, dm } = await inDm(t);
    const message = messageIn(dm, over);

    w.client.emit(Events.MessageCreate, message);
    await settle();

    assert.deepEqual(w.inbox.list(), []);
    assert.equal(message.reply.mock.callCount() + message.react.mock.callCount(), 0);
  });
}

test('a message that reaches a client that is not signed in as the configured application is ignored', async t => {
  const { w, dm } = await inDm(t);
  w.client.application = null;
  const message = messageIn(dm);

  w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.deepEqual(w.inbox.list(), []);
});

test('a stranger’s DM hears how to link once, and everyone else who is not linked hears nothing', async t => {
  const { w, dm } = await inDm(t);
  const hint = (user: string) => messageIn(dm, { author: { id: user, bot: false, displayName: 'Stranger' } });
  const first = hint(STRANGER);
  const again = hint(STRANGER);
  const other = hint('10000000000000041');
  other.reply.mock.mockImplementation(async () => Promise.reject(new Error('cannot DM this user')));
  const home = w.know(textChannel(HOME));
  const inChannel = messageIn(home, {
    author: { id: STRANGER, bot: false, displayName: 'Stranger' },
    mentions: MENTIONS_BOT,
  });

  for (const message of [first, again, other, inChannel]) w.client.emit(Events.MessageCreate, message);
  await settle();

  const [[answer]] = calls(first.reply) as [[{ content: string }]];
  assert.match(answer.content, /aivi link discord.*\/link CODE/);
  assert.deepEqual(calls(first.reply), [[{ content: answer.content, ...SAFE }]]);
  assert.equal(again.reply.mock.callCount(), 0, 'the hint is said once per account');
  assert.equal(other.reply.mock.callCount(), 1, 'another account hears it too; a reply that fails is not an error');
  assert.equal(inChannel.reply.mock.callCount(), 0, 'in a channel the stranger is not answered at all');
  assert.deepEqual(w.said('error'), []);
  assert.deepEqual(w.inbox.list(), []);
});

for (const [name, over] of [
  ['an attachment', { attachments: { size: 1 }, content: 'see file' }],
  ['no text', { content: '   ' }],
] as const) {
  test(`a message with ${name} is answered that text only is read, and nothing is queued`, async t => {
    const { w, dm } = await inDm(t);
    const message = messageIn(dm, over);

    w.client.emit(Events.MessageCreate, message);
    await settle();

    assert.deepEqual(calls(message.reply), [
      [{ content: 'Text messages only for now; paste the relevant text.', ...SAFE }],
    ]);
    assert.deepEqual(w.inbox.list(), []);
  });
}

test('a message that fails to be handled is logged, never thrown', async t => {
  const { w, dm } = await inDm(t);
  const failure = new Error('Unknown Message');
  const message = messageIn(dm, { attachments: { size: 1 } });
  message.reply.mock.mockImplementation(async () => Promise.reject(failure));

  w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.deepEqual(w.said('error'), [{ event: 'message.failed', error: failure }]);
});

for (const [content, text] of [
  [`<@${BOT}> what is aivi?`, 'what is aivi?'],
  [`<@!${BOT}>   with a nickname`, 'with a nickname'],
  [`before <@${BOT}> after`, 'before  after'],
  [`<@${BOT}>`, `<@${BOT}>`],
] as const) {
  test(`${JSON.stringify(content)} is queued as ${JSON.stringify(text)}: the mention is not part of the question`, async t => {
    const { w, dm } = await inDm(t, { capacity: 0 });

    w.client.emit(Events.MessageCreate, messageIn(dm, { content }));
    await settle();

    assert.deepEqual(
      w.inbox.list().map(turn => turn.text),
      [text],
    );
  });
}

for (const [name, member, expected] of [
  ['its server nickname', { displayName: 'Ada in the guild' }, 'Ada in the guild'],
  ['its Discord name when there is no member', null, 'Me'],
] as const) {
  test(`a turn is queued under ${name}`, async t => {
    const { w, dm } = await inDm(t, { capacity: 0 });

    w.client.emit(Events.MessageCreate, messageIn(dm, { member }));
    await settle();

    assert.deepEqual(
      w.inbox.list().map(turn => turn.name),
      [expected],
    );
  });
}

test('a message that has to wait for capacity gets an hourglass', async t => {
  const { w, dm } = await inDm(t, { capacity: 0 });
  const queued = messageIn(dm);

  w.client.emit(Events.MessageCreate, queued);
  await settle();

  assert.deepEqual(calls(queued.react), [['⏳']]);
  assert.equal(w.inbox.state(queued.id), 'queued');
});

test('a message that is answered at once gets no hourglass', async t => {
  const { w, dm } = await inDm(t);
  const answered = messageIn(dm);
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, answered);
  await ended;

  assert.equal(answered.react.mock.callCount(), 0);
});

test('where the bot may not react, a message that has to wait is answered with a reply instead', async t => {
  const { w, dm } = await inDm(t, { capacity: 0 });
  const message = messageIn(dm);
  message.react.mock.mockImplementation(async () => Promise.reject(new Error('Missing Permissions')));

  w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.deepEqual(calls(message.reply), [[{ content: 'Queued; I will answer in turn.', ...SAFE }]]);
  assert.deepEqual(w.said('error'), []);
});

test('where the bot may neither react nor reply, the message still waits in the queue', async t => {
  const { w, dm } = await inDm(t, { capacity: 0 });
  const message = messageIn(dm);
  message.react.mock.mockImplementation(async () => Promise.reject(new Error('Missing Permissions')));
  message.reply.mock.mockImplementation(async () => Promise.reject(new Error('Missing Permissions')));

  w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.equal(w.inbox.state(message.id), 'queued');
  assert.deepEqual(w.said('error'), []);
});

test('a full queue refuses the message and says so', async t => {
  const { w, dm } = await inDm(t, { capacity: 0, config: { maxPending: 1 } });
  w.client.emit(Events.MessageCreate, messageIn(dm));
  await settle();
  const refused = messageIn(dm);

  w.client.emit(Events.MessageCreate, refused);
  await settle();

  assert.deepEqual(calls(refused.reply), [
    [{ content: 'I could not queue this message. The queue may be full; check /status.', ...SAFE }],
  ]);
  assert.deepEqual(
    w.said('warn').map(({ event, channel, error }) => [event, channel, (error as Error).message]),
    [['enqueue.rejected', DM, 'The Discord queue is full. Try again later.']],
  );
  assert.equal(w.inbox.list().length, 1);
});

const mention = (text: string) => ({ content: `<@${BOT}> ${text}`, mentions: MENTIONS_BOT });

test('in a thread-mode channel a mention opens a thread named after the message, and the answer goes there', async t => {
  const { w, home } = await inHome(t);
  const message = messageIn(home, mention('what is aivi?'));
  const thread = w.know(threadChannel(`${message.id}:thread`, HOME));
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, message);
  await ended;

  assert.deepEqual(calls(message.startThread), [
    [{ name: 'what is aivi?', autoArchiveDuration: 1440, reason: 'aivi conversation' }],
  ]);
  assert.deepEqual(calls(thread.send), [[{ content: 'Answer', ...SAFE }]]);
  assert.equal(home.send.mock.callCount(), 0, 'the channel itself hears nothing');
  assert.deepEqual(
    w.inbox.list().map(turn => turn.channel),
    [thread.id],
  );
});

for (const [name, text, expected] of [
  ['the first line of a message', 'first line\nsecond line', 'first line'],
  ['a long first line cut to 79 characters and an ellipsis', 'y'.repeat(81), `${'y'.repeat(79)}…`],
  ['a first line of exactly 80 characters as it is', 'z'.repeat(80), 'z'.repeat(80)],
] as const) {
  test(`the thread is named by ${name}`, async t => {
    const { w, home } = await inHome(t, { capacity: 0 });
    const message = messageIn(home, mention(text));

    w.client.emit(Events.MessageCreate, message);
    await settle();

    const [[options]] = calls(message.startThread) as [[{ name: string }]];
    assert.equal(options.name, expected);
  });
}

test('when the thread cannot be opened the person is told which permission is missing, and nothing is queued', async t => {
  const { w, home } = await inHome(t);
  const failure = new Error('Missing Permissions');
  const message = messageIn(home, mention('hello'));
  message.startThread.mock.mockImplementation(async () => Promise.reject(failure));

  w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.deepEqual(w.said('warn'), [{ event: 'thread.create.failed', channel: HOME, error: failure }]);
  assert.deepEqual(calls(message.reply), [
    [{ content: 'I need permission to create threads in this channel.', ...SAFE }],
  ]);
  assert.deepEqual(w.inbox.list(), []);
});

for (const [name, shape] of [
  ['a thread', () => threadChannel('10000000000000060', HOME)],
  ['a forum channel', () => forumChannel(HOME)],
  [
    'a channel that cannot hold threads',
    () => {
      const { threads: _threads, ...bare } = textChannel(HOME);
      return bare;
    },
  ],
] as const) {
  test(`a mention in ${name} opens no thread: the conversation is where the message is`, async t => {
    const { w } = await inHome(t, { capacity: 0 });
    const place = w.know(shape());
    const message = messageIn(place, mention('hello'));

    w.client.emit(Events.MessageCreate, message);
    await settle();

    assert.equal(message.startThread.mock.callCount(), 0);
    assert.deepEqual(
      w.inbox.list().map(turn => turn.channel),
      [place.id],
    );
  });
}

test('a message in a thread aivi already takes part in needs no mention; in any other thread or channel it does', async t => {
  const { w, home } = await inHome(t, { capacity: 0 });
  w.inbox.adopt('10000000000000061', { seed: 'an earlier report' }); // aivi is in this thread
  const known = messageIn(w.know(threadChannel('10000000000000061', HOME)), { content: 'and then?' });
  const stranger = messageIn(w.know(threadChannel('10000000000000062', HOME)), { content: 'and then?' });
  const unaddressed = messageIn(home, { content: 'hello' });

  for (const message of [known, stranger, unaddressed]) w.client.emit(Events.MessageCreate, message);
  await settle();

  assert.deepEqual(
    w.inbox.list().map(turn => turn.channel),
    ['10000000000000061'],
  );
  assert.equal(unaddressed.startThread.mock.callCount(), 0);
});

test('a channel that is one shared conversation answers everything said in it without a thread, and ignores its threads', async t => {
  const w = world(t, { capacity: 0 });
  w.link();
  const team = w.know(textChannel(TEAM));
  const inThread = messageIn(w.know(threadChannel('10000000000000063', TEAM)), { content: 'aside' });
  const message = messageIn(team, { content: 'no mention needed' });
  await w.start();
  await settle();

  for (const each of [message, inThread]) w.client.emit(Events.MessageCreate, each);
  await settle();

  assert.equal(message.startThread.mock.callCount(), 0);
  assert.deepEqual(
    w.inbox.list().map(turn => turn.channel),
    [TEAM],
  );
});

test('a message that arrives while the conversation’s turn runs is steered into that turn, not queued behind it', async t => {
  const { w, dm, ada } = await running(t);
  const steer = messageIn(dm, { id: 'second', content: 'also the appendix' });

  w.client.emit(Events.MessageCreate, steer);
  await settle();

  const [, prompt] = calls(w.opencode.client.session.prompt) as [unknown, [{ sessionID: string }]];
  assert.deepEqual(prompt[0], {
    sessionID: w.inbox.sessionOf(DM)!.session,
    text: `[Discord message from Ada (user ${ME})]\nalso the appendix`,
    delivery: 'steer',
    metadata: { aivi: { origin: 'discord', channel: DM, user: ME, steer: 'msg_discord_first', person: ada.id } },
  });
  assert.deepEqual(calls(steer.react), [['⚡']]);
  assert.equal(w.inbox.list().length, 1, 'an interjection is no turn of its own');
  await w.finishTurn();
});

test('a steer is still passed on when the bot may not react to it', async t => {
  const { w, dm } = await running(t);
  const steer = messageIn(dm, { id: 'second', content: 'also the appendix' });
  steer.react.mock.mockImplementation(async () => Promise.reject(new Error('Missing Permissions')));

  w.client.emit(Events.MessageCreate, steer);
  await settle();

  assert.equal(calls(w.opencode.client.session.prompt).length, 2);
  assert.deepEqual(w.said('error'), []);
  await w.finishTurn();
});

for (const [name, failure] of [
  [
    'OpenCode refuses it',
    (_t: TestContext, w: World, error: Error) => {
      w.opencode.refuse.steer = error;
    },
  ],
  [
    'the speaker cannot be looked up',
    (t: TestContext, w: World, error: Error) => {
      const identityFor = w.store.identityFor.bind(w.store);
      let asked = 0;
      t.mock.method(w.store, 'identityFor', (channel: string, user: string) => {
        if (++asked === 2) throw error; // the first answer is the access check; the second is the steer's
        return identityFor(channel, user);
      });
    },
  ],
] as const) {
  test(`a message that cannot be steered because ${name} waits its turn instead, and the failure is logged`, async t => {
    const { w, dm } = await running(t);
    const error = new Error('could not steer');
    failure(t, w, error);
    const steer = messageIn(dm, { id: 'second', content: 'also the appendix' });

    w.client.emit(Events.MessageCreate, steer);
    await settle();

    assert.deepEqual(w.said('warn'), [{ event: 'interject.failed', channel: DM, error }]);
    assert.equal(w.inbox.state('second'), 'queued');
    assert.deepEqual(calls(steer.react), [['⏳']]);
    await w.finishTurn();
  });
}

test('the typing indicator is sent while the agent works, and stops with the turn', async t => {
  const { w, dm } = await running(t);
  assert.equal(dm.sendTyping.mock.callCount(), 1);

  await w.finishTurn();

  assert.equal(dm.sendTyping.mock.callCount(), 1, 'nothing is left running to send the next one');
});

test('a typing indicator that Discord refuses does not stop the turn', async t => {
  const { w, dm } = await inDm(t);
  dm.sendTyping.mock.mockImplementation(async () => Promise.reject(new Error('Missing Access')));
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, messageIn(dm));
  await ended;

  assert.deepEqual(calls(dm.send), [[{ content: 'Answer', ...SAFE }]]);
});

const removal = () => mock.fn(async (_user: string): Promise<void> => {});
for (const [name, install, removed] of [
  [
    'takes the hourglass off the message that waited',
    (dm: FakeChannel, remove: ReturnType<typeof removal>) =>
      dm.messages.fetch.mock.mockImplementation(async () => ({
        reactions: { resolve: (emoji: string) => (emoji === '⏳' ? { users: { remove } } : undefined) },
      })),
    [[BOT]],
  ],
  [
    'leaves a message that has no hourglass alone',
    (dm: FakeChannel) =>
      dm.messages.fetch.mock.mockImplementation(async () => ({ reactions: { resolve: () => undefined } })),
    [],
  ],
  [
    'carries on when the hourglass cannot be removed',
    (dm: FakeChannel, remove: ReturnType<typeof removal>) => {
      remove.mock.mockImplementation(async () => Promise.reject(new Error('Missing Permissions')));
      dm.messages.fetch.mock.mockImplementation(async () => ({
        reactions: { resolve: () => ({ users: { remove } }) },
      }));
    },
    [[BOT]],
  ],
  [
    'carries on when the message is gone',
    (dm: FakeChannel) =>
      dm.messages.fetch.mock.mockImplementation(async () => Promise.reject(new Error('Unknown Message'))),
    [],
  ],
] as const) {
  test(`when the turn of a message starts, the bot ${name}`, async t => {
    const { w, dm } = await inDm(t);
    const remove = removal();
    install(dm, remove);
    const ended = w.turnEnded();

    w.client.emit(Events.MessageCreate, messageIn(dm, { id: 'waited' }));
    await ended;

    assert.deepEqual(calls(dm.messages.fetch), [['waited']]);
    assert.deepEqual(calls(remove), removed);
    assert.deepEqual(calls(dm.send), [[{ content: 'Answer', ...SAFE }]], 'the turn is answered whatever came of it');
  });
}

test('with progress on, a placeholder is posted while the agent works and removed once the answer is sent', async t => {
  const { w, dm } = await inDm(t, { config: { progress: 'status' } });
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, messageIn(dm));
  await ended;

  assert.deepEqual(calls(dm.send), [[{ content: '⏳ thinking…', ...SAFE }], [{ content: 'Answer', ...SAFE }]]);
  assert.deepEqual(calls(dm.messages.delete), [[`${DM}:1`]]);
});

test('with progress on, a turn that cannot start turns the placeholder into the notice', async t => {
  const { w, dm } = await inDm(t, { config: { progress: 'status' } });
  w.opencodeDown();
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, messageIn(dm));
  await ended;

  assert.deepEqual(calls(dm.send), [[{ content: '⏳ thinking…', ...SAFE }]]);
  assert.deepEqual(calls(dm.messages.edit), [
    [
      `${DM}:1`,
      { content: 'I could not reach my agent runtime just now. Please send that again in a moment.', ...SAFE },
    ],
  ]);
});

for (const [name, place, reason] of [
  ['knows no more', null, 'Discord channel is not sendable'],
  ['has gone for good', new Error('Unknown Channel'), 'Unknown Channel'],
] as const) {
  test(`an answer for a channel the bot ${name} fails the turn, and nobody can be told because there is nowhere to say it`, async t => {
    const { w, dm } = await inDm(t);
    w.places.set(DM, place);
    const ended = w.turnEnded();

    w.client.emit(Events.MessageCreate, messageIn(dm, { id: 'lost' }));
    await ended;

    assert.deepEqual(
      w.said('warn').map(({ event, error }) => [event, (error as Error).message]),
      [
        ['turn.failed', reason],
        ['notify.failed', reason],
      ],
    );
    assert.deepEqual(
      w.inbox.list().map(turn => [turn.state, turn.error]),
      [['discarded', reason]],
    );
  });
}

test('a placeholder that cannot be turned into the notice because the channel is gone falls back to a message, and that fails too', async t => {
  const { w, dm } = await inDm(t, { config: { progress: 'status' } });
  w.opencode.hold();
  w.client.emit(Events.MessageCreate, messageIn(dm));
  await settle();
  w.places.delete(DM); // the channel vanishes after the placeholder was posted
  const ended = w.turnEnded();

  w.opencode.release();
  await ended;

  assert.deepEqual(
    w.said('warn').map(({ event, error }) => [event, (error as Error).message]),
    [
      ['turn.failed', 'Discord channel is not sendable'],
      ['progress.edit.failed', 'Discord channel is not text based'],
      ['notify.failed', 'Discord channel is not sendable'],
    ],
  );
});

test('a placeholder that cannot be removed after the answer was sent is logged, and the turn is still sent', async t => {
  const { w, dm } = await inDm(t, { config: { progress: 'status' } });
  const send = dm.send;
  let sent = 0;
  dm.send = mock.fn(async (payload: unknown) => {
    const message = await send(payload);
    if (++sent === 2) w.places.delete(DM); // the channel vanishes once the answer is out
    return message;
  });
  const ended = w.turnEnded();

  w.client.emit(Events.MessageCreate, messageIn(dm));
  await ended;

  assert.deepEqual(
    w.said('warn').map(({ event, error }) => [event, (error as Error).message]),
    [['progress.delete.failed', 'Discord channel is not text based']],
  );
  assert.deepEqual(
    w.inbox.list().map(turn => turn.state),
    ['sent'],
  );
});

test('a job outcome addressed to a session of a conversation comes back into it as a turn and is answered there', async t => {
  const { w, dm } = await inDm(t);
  let ended = w.turnEnded();
  w.client.emit(Events.MessageCreate, messageIn(dm));
  await ended;
  const { session } = w.inbox.sessionOf(DM)!;
  ended = w.turnEnded();

  await w.channels.deliver({ to: 'session', session, on: 'always' }, '✅ nightly done', {
    run: runOf({ id: 'run-9' }),
    state: 'succeeded',
  });
  await ended;

  assert.equal(w.channels.ownerOf(session), 'discord');
  const [, outcome] = w.inbox.list();
  assert.deepEqual([outcome!.id, outcome!.kind, outcome!.state], ['run:run-9', 'job', 'sent']);
  const [[turn]] = calls(w.opencode.client.session.prompt).slice(-1) as [[{ text: string }]];
  assert.match(turn.text, /✅ nightly done/);
  assert.deepEqual(calls(dm.send).at(-1), [{ content: 'Answer', ...SAFE }]);
  assert.equal(dm.messages.fetch.mock.callCount(), 1, 'only the person’s message could carry an hourglass');
});

test('the channel of a conversation is the parent of its thread, or the conversation itself', async t => {
  const w = world(t);
  const thread = w.know(threadChannel('10000000000000070', HOME));
  const gone = '10000000000000071';
  w.places.set(gone, new Error('Unknown Channel'));
  for (const channel of [thread.id, DM, gone]) w.inbox.adopt(channel, { seed: 'a report' });
  await w.start();
  w.know(dmChannel(DM));

  assert.deepEqual(
    await Promise.all([thread.id, DM, gone].map(channel => w.channels.channelOf(w.inbox.sessionOf(channel)!.session))),
    [
      { module: 'discord', channel: HOME },
      { module: 'discord', channel: DM },
      { module: 'discord', channel: gone },
    ],
  );
  assert.equal(await w.channels.channelOf('ses_nobody'), undefined);
});

test('the module answers undefined for the channel of a session it does not hold', async t => {
  const w = world(t);
  await w.start();

  assert.equal(await w.entry().channelOf('ses_nobody'), undefined);
  assert.equal(w.entry().ownsSession('ses_nobody'), false);
});

test('a wake from the host starts the turn that waited for capacity elsewhere, but only while the gateway is ready', async t => {
  const { w, dm } = await inDm(t);
  w.dispatcher.throwing.add('default'); // the pool is not configured yet: the turn waits and nobody is asked
  w.client.emit(Events.MessageCreate, messageIn(dm, { id: 'waited' }));
  await settle();
  assert.equal(w.inbox.state('waited'), 'queued');
  w.dispatcher.throwing.delete('default');

  w.client.ready = false;
  w.wake();
  await settle();
  assert.equal(w.inbox.state('waited'), 'queued', 'a gateway that is not ready starts nothing');

  w.client.ready = true;
  const ended = w.turnEnded();
  w.wake();
  await ended;
  assert.equal(w.inbox.state('waited'), 'sent');
});
