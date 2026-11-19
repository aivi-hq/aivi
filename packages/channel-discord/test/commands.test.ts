/** The slash commands of the Discord module and the model autocomplete, as the
 *  module answers them: an interaction is sent into the fake client, and the
 *  test reads what the module replied, what it changed in the inbox and what it
 *  logged. `discord.js` is replaced by fakes (see `module-fixture.ts`); the
 *  host's machinery under the commands (the conversation store, the engine, the
 *  host's own command texts) runs for real. Messages and delivery are
 *  `module.test.ts`'s subject. */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import { jobSchema, taskSchema } from '@aivi/core';
import { CHAT_COMMANDS } from '@aivi/host';
import { Events, MessageFlags } from 'discord.js';
import {
  type world as baseWorld,
  commandIn,
  DIRECTORY,
  DM,
  discordExports,
  type FakeChannel,
  HOME,
  ME,
  messageIn,
  SAFE,
  STRANGER,
  settle,
  startedInDm,
  startedInHome,
  startedWithRunningTurn,
  TEAM,
  textChannel,
  threadChannel,
  type World,
} from './module-fixture.ts';

mock.module('discord.js', { exports: discordExports });

const unit = await import('../src/module.ts');
type Options = Parameters<typeof baseWorld>[2];
const inDm = (t: TestContext, options?: Options) => startedInDm(t, unit, options);
const inHome = (t: TestContext, options?: Options) => startedInHome(t, unit, options);
const running = (t: TestContext, options?: Options) => startedWithRunningTurn(t, unit, options);

type Calls = { mock: { calls: Array<{ arguments: unknown[] }> } };
const calls = (fn: Calls) => fn.mock.calls.map(call => call.arguments);

/** What a command that was not deferred answers with, and what one that was edits its answer into. */
const ephemeral = (content: string) => [
  [{ content, flags: MessageFlags.Ephemeral, allowedMentions: SAFE.allowedMentions }],
];
const edited = (content: string) => [[{ content, allowedMentions: SAFE.allowedMentions }]];
const NOT_ENABLED = /^This user or conversation is not enabled for aivi\.$/;
const THREAD_ONLY = 'Run this inside a thread. In this channel every conversation is its own thread.';

/** Send one interaction into the client and let the module finish with it. */
async function send(w: World, interaction: ReturnType<typeof commandIn>) {
  w.client.emit(Events.InteractionCreate, interaction);
  await settle();
  return interaction;
}

const touched = (interaction: ReturnType<typeof commandIn>) =>
  interaction.reply.mock.callCount() +
  interaction.deferReply.mock.callCount() +
  interaction.editReply.mock.callCount() +
  interaction.respond.mock.callCount();

for (const [name, arrange] of [
  ['when the host is going down', (w: World) => w.abort()],
  [
    'when the client is not signed in as the configured application',
    (w: World) => {
      w.client.application = null;
    },
  ],
  [
    'when the interaction is not a command',
    (_w: World, interaction: ReturnType<typeof commandIn>) => {
      interaction.isChatInputCommand = () => false;
    },
  ],
  [
    'when the command is not one of aivi’s',
    (_w: World, interaction: ReturnType<typeof commandIn>) => {
      interaction.commandName = 'steer';
    },
  ],
] as const) {
  test(`an interaction is ignored ${name}`, async t => {
    const { w, dm } = await inDm(t);
    const interaction = commandIn(dm, 'status');
    arrange(w, interaction);

    await send(w, interaction);

    assert.equal(touched(interaction), 0);
  });
}

for (const [name, user, place, command, expected] of [
  [
    'an account that is not linked, in a DM, is told how to link',
    STRANGER,
    (_w: World, dm: FakeChannel) => dm,
    'status',
    /^I don't know you yet\. Run `aivi link discord`/,
  ],
  [
    'an account that is not linked is refused in a channel',
    STRANGER,
    (w: World) => w.know(textChannel(HOME)),
    'status',
    NOT_ENABLED,
  ],
  [
    'a linked person is refused in a channel aivi does not listen in',
    ME,
    (w: World) => w.know(textChannel('10000000000000080')),
    'status',
    NOT_ENABLED,
  ],
  [
    'a link code is refused in a channel aivi does not listen in',
    STRANGER,
    (w: World) => w.know(textChannel('10000000000000080')),
    'link',
    NOT_ENABLED,
  ],
] as const) {
  test(`${name}`, async t => {
    const { w, dm } = await inDm(t);
    const interaction = commandIn(place(w, dm), command, {}, { user: { id: user, displayName: 'X' } });

    await send(w, interaction);

    const [[reply]] = calls(interaction.reply) as [[{ content: string; flags: number }]];
    assert.match(reply.content, expected);
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.equal(interaction.deferReply.mock.callCount(), 0);
  });
}

test('/help lists every command as the person types it, with its arguments', async t => {
  const { w, dm } = await inDm(t);

  const help = await send(w, commandIn(dm, 'help'));

  const [[{ content }]] = calls(help.reply) as [[{ content: string }]];
  const lines = content.split('\n');
  assert.equal(lines.length, CHAT_COMMANDS.length);
  assert.equal(lines[0], '`/new` — Start a fresh conversation');
  assert.ok(lines.includes('`/queue TEXT` — Send this behind the running turn instead of interjecting into it'));
});

test('/help works in a DM whose channel Discord has not handed over', async t => {
  const { w, dm } = await inDm(t);

  const help = await send(w, commandIn(dm, 'help', {}, { channel: null }));

  assert.equal(help.reply.mock.callCount(), 1);
});

test('/jobs shows the next occurrences and the last runs', async t => {
  const { w, dm } = await inDm(t);

  const jobs = await send(w, commandIn(dm, 'jobs'));

  assert.deepEqual(
    calls(jobs.reply),
    ephemeral('**Next occurrences**\nNo jobs are due.\n\n**Last runs**\nNo runs have finished yet.'),
  );
});

test('/link binds the account that redeems a valid code to its person, from any place aivi can be reached in', async t => {
  const { w, dm } = await inDm(t);
  const grace = w.store.createPerson({ name: 'Grace' });
  const { code } = w.store.mintLinkCode(grace.id);
  const stranger = { user: { id: STRANGER, displayName: 'Stranger' } };

  const wrong = await send(w, commandIn(dm, 'link', { code: '00000' }, stranger));
  const right = await send(w, commandIn(dm, 'link', { code }, stranger));

  assert.deepEqual(calls(wrong.reply), ephemeral('That code did not match. Run `aivi link` and paste the new one.'));
  assert.deepEqual(calls(right.reply), ephemeral('Linked. This account now belongs to Grace.'));
  assert.equal(w.store.identityFor('discord', STRANGER)?.name, 'Grace');
});

const hit = (n: number, excerpt = `excerpt ${n}`) => ({
  sourceId: 's',
  kind: 'doc',
  scope: 'core',
  path: `/k/${n}.md`,
  title: `Doc ${n}`,
  excerpt,
  score: 1,
});

test('/search answers the top three hits of the knowledge, in the project when one is named', async t => {
  const { w, dm } = await inDm(t);
  w.services.knowledge.search.mock.mockImplementation(async () => [hit(1), hit(2)]);

  const search = await send(w, commandIn(dm, 'search', { query: 'leave policy', project: 'demo' }));

  assert.deepEqual(calls(w.services.knowledge.search), [[{ query: 'leave policy', limit: 3, projects: ['demo'] }]]);
  assert.deepEqual(calls(search.deferReply), [[{ flags: MessageFlags.Ephemeral }]]);
  assert.deepEqual(calls(search.editReply), [
    [
      {
        content: 'Doc 1 — /k/1.md\nexcerpt 1\n\nDoc 2 — /k/2.md\nexcerpt 2',
        allowedMentions: SAFE.allowedMentions,
        flags: MessageFlags.SuppressEmbeds,
      },
    ],
  ]);
});

test('/search without a project asks the whole knowledge, and says when nothing matches', async t => {
  const { w, dm } = await inDm(t);

  const search = await send(w, commandIn(dm, 'search', { query: 'nothing' }));

  assert.deepEqual(calls(w.services.knowledge.search), [[{ query: 'nothing', limit: 3 }]]);
  assert.deepEqual(calls(search.editReply), [
    [{ content: 'No matching documents.', allowedMentions: SAFE.allowedMentions, flags: MessageFlags.SuppressEmbeds }],
  ]);
});

test('/search keeps its answer inside the length Discord allows', async t => {
  const { w, dm } = await inDm(t);
  w.services.knowledge.search.mock.mockImplementation(async () => [hit(1, 'x'.repeat(1500)), hit(2, 'y'.repeat(1500))]);

  const search = await send(w, commandIn(dm, 'search', { query: 'long' }));

  const [[{ content }]] = calls(search.editReply) as [[{ content: string }]];
  assert.equal(content.length, 1900);
  assert.ok(content.startsWith('Doc 1 — /k/1.md\nxxx'));
});

test('/search that fails says the index or the project is the problem, and logs why', async t => {
  const { w, dm } = await inDm(t);
  const failure = new Error('index is rebuilding');
  w.services.knowledge.search.mock.mockImplementation(async () => Promise.reject(failure));

  const search = await send(w, commandIn(dm, 'search', { query: 'anything', project: 'unknown' }));

  assert.deepEqual(calls(search.editReply), [['Search is unavailable or the project is unknown.']]);
  assert.deepEqual(w.said('warn'), [{ event: 'search.failed', error: failure }]);
});

for (const name of ['new', 'status', 'context', 'model', 'stop', 'queue']) {
  test(`/${name} in a channel where every conversation is a thread asks for a thread, and does nothing`, async t => {
    const { w, home } = await inHome(t);
    const interaction = commandIn(home, name, { text: 'later' });

    await send(w, interaction);

    assert.deepEqual(calls(interaction.reply), ephemeral(THREAD_ONLY));
    assert.equal(interaction.deferReply.mock.callCount(), 0);
    assert.deepEqual(w.inbox.list(), []);
    assert.equal(w.inbox.sessionOf(HOME), null);
  });
}

for (const [name, place] of [
  ['a thread of that channel', () => threadChannel('10000000000000081', HOME)],
  ['a channel that is one shared conversation', () => textChannel(TEAM)],
] as const) {
  test(`/status in ${name} answers: it is a conversation of its own`, async t => {
    const { w } = await inHome(t);
    const interaction = commandIn(w.know(place()), 'status');

    await send(w, interaction);

    assert.deepEqual(
      calls(interaction.reply),
      ephemeral('Ready for your next message.\nNo jobs are due.\nNo runs finished in the last 24 h.'),
    );
  });
}

test('/status says what waits here, which jobs come next and how the last day of runs went', async t => {
  const { w, dm } = await inDm(t, { capacity: 0 });
  for (const [id, at] of [
    ['nightly', '2099-01-02T03:04:05.000Z'],
    ['weekly', '2099-02-03T04:05:06.000Z'],
  ]) {
    w.store.addJob(jobSchema.parse({ id, at, task: 'system.check' }), 'operator');
  }
  for (const [key, state, finished] of [
    ['a', 'succeeded', 1000],
    ['b', 'succeeded', 2000],
    ['c', 'failed', 3000],
  ] as const) {
    const at = Date.now() - 60_000;
    const run = w.store.enqueue(taskSchema.parse({ kind: 'shell', command: ['true'] }), 'default', key, at);
    w.store.claimRun(run.id, 'host', at);
    w.store.finish(run.id, 'host', state, null, 'done', at + finished);
  }
  w.client.emit(Events.MessageCreate, messageIn(dm)); // no capacity: the message waits
  await settle();

  const status = await send(w, commandIn(dm, 'status'));

  assert.deepEqual(
    calls(status.reply),
    ephemeral(
      [
        '1 pending turn(s): queued. Blocked turns require operator inspection.',
        'Next jobs: nightly at 2099-01-02 03:04 UTC, weekly at 2099-02-03 04:05 UTC.',
        'Runs in the last 24 h: 1 failed, 2 succeeded.', // the newest run counts first
      ].join('\n'),
    ),
  );
});

test('/new starts the next message in a fresh session', async t => {
  const { w, dm } = await inDm(t);
  const ended = w.turnEnded();
  w.client.emit(Events.MessageCreate, messageIn(dm));
  await ended;
  const before = w.inbox.sessionOf(DM)!;

  const fresh = await send(w, commandIn(dm, 'new'));

  assert.deepEqual(
    calls(fresh.reply),
    ephemeral('The next message starts a fresh session. Previous sessions remain in OpenCode.'),
  );
  const after = w.inbox.sessionOf(DM)!;
  assert.notEqual(after.session, before.session);
  assert.equal(after.ready, false);
});

test('/new refuses while the conversation still has queued work', async t => {
  const { w, dm } = await inDm(t, { capacity: 0 });
  w.client.emit(Events.MessageCreate, messageIn(dm));
  await settle();
  const before = w.inbox.sessionOf(DM)!;

  const fresh = await send(w, commandIn(dm, 'new'));

  assert.deepEqual(
    calls(fresh.reply),
    ephemeral('This conversation has queued or unresolved work. Finish or resolve it before starting fresh.'),
  );
  assert.equal(w.inbox.sessionOf(DM)!.session, before.session);
});

test('/context says what the next message would start when the conversation has no session yet', async t => {
  const { w, dm } = await inDm(t);

  const context = await send(w, commandIn(dm, 'context'));

  assert.deepEqual(calls(context.deferReply), [[{ flags: MessageFlags.Ephemeral }]]);
  const [[{ content }]] = calls(context.editReply) as [[{ content: string }]];
  const lines = content.split('\n');
  assert.equal(lines[0], '🧠 **Context** · no session yet');
  assert.equal(lines[1], `The next message starts one with agent \`assistant\` in \`${DIRECTORY}\`.`);
  assert.equal(lines.at(-1), 'Nothing pending here.');
});

test('/context that cannot read the session from OpenCode says so and logs why', async t => {
  const { w, dm } = await inDm(t);
  w.inbox.bind(DM, { agent: 'assistant', directory: DIRECTORY });
  w.inbox.ready(DM);
  const failure = w.opencodeDown();

  const context = await send(w, commandIn(dm, 'context'));

  assert.deepEqual(calls(context.editReply), edited('I could not read this session from OpenCode just now.'));
  assert.deepEqual(w.said('warn'), [{ event: 'context.failed', error: failure }]);
});

test('/model without an argument shows the conversation’s model and the agent’s default', async t => {
  const { w, dm } = await inDm(t);

  const model = await send(w, commandIn(dm, 'model'));

  assert.deepEqual(calls(model.deferReply), [[{ flags: MessageFlags.Ephemeral }]]);
  assert.deepEqual(
    calls(model.editReply),
    edited(
      [
        '🧠 **Model**',
        'This conversation: the agent’s default.',
        'Last answer: none yet.',
        'Agent `assistant`: unknown (the agent file pins none and OpenCode reports no default).',
      ].join('\n'),
    ),
  );
});

for (const [name, wanted, said, pinned] of [
  [
    'a model by its name',
    'GPT 5.2 (high)',
    'This conversation answers with `github-copilot/gpt-5.2@high` from its next message on, until /new.',
    { providerID: 'github-copilot', modelID: 'gpt-5.2', variant: 'high' },
  ],
  [
    'the default again',
    'default',
    'This conversation answers with the agent’s default model again from its next message on.',
    null,
  ],
] as const) {
  test(`/model switches the conversation to ${name}`, async t => {
    const { w, dm } = await inDm(t);

    const model = await send(w, commandIn(dm, 'model', { model: wanted }));

    assert.deepEqual(calls(model.editReply), edited(said));
    assert.deepEqual(w.inbox.sessionOf(DM)?.model, pinned);
  });
}

test('/model that cannot read the catalogue from OpenCode says so and logs why', async t => {
  const { w, dm } = await inDm(t);
  const failure = w.opencodeDown();

  const model = await send(w, commandIn(dm, 'model'));

  assert.deepEqual(calls(model.editReply), edited('I could not read the model catalogue from OpenCode just now.'));
  assert.deepEqual(w.said('warn'), [{ event: 'model.failed', error: failure }]);
});

test('/stop says when nothing is running', async t => {
  const { w, dm } = await inDm(t);

  const stop = await send(w, commandIn(dm, 'stop'));

  assert.deepEqual(calls(stop.editReply), edited('Nothing is running in this conversation.'));
});

test('/stop ends the running turn, interrupts the agent, and the conversation hears that it was stopped', async t => {
  const { w, dm } = await running(t);
  const ended = w.turnEnded();

  const stop = await send(w, commandIn(dm, 'stop'));
  await ended;
  await settle();

  assert.deepEqual(calls(stop.deferReply), [[{ flags: MessageFlags.Ephemeral }]]);
  assert.deepEqual(calls(stop.editReply), edited('Stopped.'));
  const [[interrupted]] = calls(w.opencode.client.session.interrupt) as [[{ sessionID: string }]];
  assert.equal(interrupted.sessionID, w.inbox.sessionOf(DM)!.session);
  assert.deepEqual(calls(dm.send), [[{ content: 'Stopped at your request.', ...SAFE }]]);
  assert.deepEqual(
    w.inbox.list().map(turn => [turn.state, turn.error]),
    [['discarded', 'Stopped at the person’s request']],
  );
});

test('/stop that cannot interrupt the agent still stops the turn, says so and logs why', async t => {
  const { w, dm } = await running(t);
  const failure = new Error('interrupt refused');
  w.opencode.client.session.interrupt.mock.mockImplementation(async () => Promise.reject(failure));
  const ended = w.turnEnded();

  const stop = await send(w, commandIn(dm, 'stop'));
  await ended;

  assert.deepEqual(
    calls(stop.editReply),
    edited(
      'Stopped here, but I could not tell OpenCode to interrupt the agent; it may finish on its own in the background.',
    ),
  );
  assert.deepEqual(
    w.said('warn').filter(line => line.event === 'stop.interrupt_failed'),
    [{ event: 'stop.interrupt_failed', error: failure }],
  );
});

test('/queue puts the text behind the running turn instead of interjecting, and /status counts both', async t => {
  const { w, dm } = await running(t);

  const queue = await send(w, commandIn(dm, 'queue', { text: 'after this please' }));
  const status = await send(w, commandIn(dm, 'status'));

  assert.deepEqual(calls(queue.deferReply), [[{ flags: MessageFlags.Ephemeral }]]);
  assert.deepEqual(calls(queue.editReply), edited('Queued behind the running turn.'));
  const [first, second] = w.inbox.list();
  assert.deepEqual([first!.id, first!.state], ['first', 'running']);
  assert.match(second!.id, /^slash:\d+$/);
  assert.deepEqual(
    [second!.channel, second!.user, second!.name, second!.text, second!.state],
    [DM, ME, 'Me', 'after this please', 'queued'],
  );
  const [[{ content }]] = calls(status.reply) as [[{ content: string }]];
  assert.match(content, /^2 pending turn\(s\): running, queued\. Blocked turns require operator inspection\./);
  await w.finishTurn();
});

for (const [name, member, expected] of [
  ['no member (a DM)', null, 'Me'],
  ['a member the API gave without a nickname', {}, 'Me'],
  ['a member with a nickname', { displayName: 'Nick' }, 'Nick'],
] as const) {
  test(`/queue names the speaker by ${name}`, async t => {
    const { w, dm } = await inDm(t, { capacity: 0 });

    const queue = await send(w, commandIn(dm, 'queue', { text: 'later' }, { member }));

    assert.deepEqual(calls(queue.editReply), edited('Queued; nothing is running.'));
    assert.deepEqual(
      w.inbox.list().map(turn => turn.name),
      [expected],
    );
  });
}

test('/queue that finds the queue full says so, and logs why', async t => {
  const { w, dm } = await inDm(t, { capacity: 0, config: { maxPending: 1 } });
  w.client.emit(Events.MessageCreate, messageIn(dm)); // takes the only place in the queue
  await settle();

  const full = await send(w, commandIn(dm, 'queue', { text: 'two' }));

  assert.deepEqual(
    calls(full.editReply),
    edited('I could not queue this message. The queue may be full; check /status.'),
  );
  assert.deepEqual(
    w.said('warn').map(({ event, error }) => [event, (error as Error).message]),
    [['queue.rejected', 'The Discord queue is full. Try again later.']],
  );
});

/** An autocomplete request for the focused text of a command's argument. */
const autocompleting = (channel: FakeChannel, commandName: string, focused: string, over = {}) =>
  commandIn(
    channel,
    commandName,
    { focused },
    { isChatInputCommand: () => false, isAutocomplete: () => true, ...over },
  );

test('the model argument offers the catalogue’s models that match what is typed, with their variants', async t => {
  const { w, dm } = await inDm(t);

  const typing = await send(w, autocompleting(dm, 'model', 'gpt'));

  assert.deepEqual(calls(typing.respond), [
    [
      [
        { name: 'github-copilot/gpt-5.2', value: 'github-copilot/gpt-5.2' },
        { name: 'github-copilot/gpt-5.2@high', value: 'github-copilot/gpt-5.2@high' },
      ],
    ],
  ]);
  assert.equal(typing.deferReply.mock.callCount() + typing.reply.mock.callCount(), 0);
  assert.deepEqual((calls(w.opencode.client.model.list)[0] as [{ location: unknown }])[0].location, {
    directory: DIRECTORY,
  });
});

test('the catalogue is read for the directory of the conversation’s own binding', async t => {
  const { w, dm } = await inDm(t);
  w.inbox.bind(DM, { agent: 'worker', directory: '/work/shop' });

  await send(w, autocompleting(dm, 'model', ''));

  assert.deepEqual((calls(w.opencode.client.model.list)[0] as [{ location: unknown }])[0].location, {
    directory: '/work/shop',
  });
});

for (const [name, arrange] of [
  ['an argument of another command', (_w: World, dm: FakeChannel) => autocompleting(dm, 'search', 'gpt')],
  [
    'a person who may not use aivi here',
    (_w: World, dm: FakeChannel) => autocompleting(dm, 'model', 'gpt', { user: { id: STRANGER, displayName: 'X' } }),
  ],
] as const) {
  test(`${name} is offered no choices`, async t => {
    const { w, dm } = await inDm(t);

    const typing = await send(w, arrange(w, dm));

    assert.deepEqual(calls(typing.respond), [[[]]]);
    assert.equal(w.opencode.client.model.list.mock.callCount(), 0);
  });
}

test('when the catalogue cannot be read the model argument is offered no choices, and it is logged', async t => {
  const { w, dm } = await inDm(t);
  const failure = w.opencodeDown();

  const typing = await send(w, autocompleting(dm, 'model', 'gpt'));

  assert.deepEqual(calls(typing.respond), [[[]]]);
  assert.deepEqual(w.said('warn'), [{ event: 'autocomplete.failed', error: failure }]);
});

test('an offer of no choices that Discord cannot take is not an error', async t => {
  const { w, dm } = await inDm(t);
  w.opencodeDown();
  const typing = autocompleting(dm, 'model', 'gpt');
  typing.respond.mock.mockImplementation(async () => Promise.reject(new Error('Unknown interaction')));

  await send(w, typing);

  assert.deepEqual(w.said('error'), []);
});

test('a command that cannot be answered is logged, never thrown', async t => {
  const { w, dm } = await inDm(t);
  const failure = new Error('Unknown interaction');
  const interaction = commandIn(dm, 'status', {}, { user: { id: STRANGER, displayName: 'X' } });
  interaction.reply.mock.mockImplementation(async () => Promise.reject(failure));

  await send(w, interaction);

  assert.deepEqual(w.said('error'), [{ event: 'command.failed', error: failure }]);
});
