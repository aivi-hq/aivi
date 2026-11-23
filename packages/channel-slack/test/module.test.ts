/**
 * What the Slack module decides, one unit at a time. The module is started over fakes: the
 * connection to Slack, the services the host hands it, and the host's engine and turn runner,
 * which are module mocks (`@aivi/host` with `ChannelEngine` and `createTurnRunner` replaced, the
 * rest the real module). The inbox is the host's own `ConversationStore` over an in-memory
 * store, so what a message turns into is read from its tables. The engine never runs a turn
 * here: a test that needs one puts the turn in the store, or calls what the module handed the
 * engine. Nothing reaches Slack, OpenCode or a socket; module and real engine together over a
 * fake OpenCode are `slack.test.ts`'s subject.
 */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import { configSchema, jobSchema } from '@aivi/core';
import type { ChannelModule, Turn } from '@aivi/host';
import * as host from '@aivi/host';
import { ConfigurationError } from '@aivi/plugin';
import { recorder } from '../../host/test/support.ts';
import type { SlackConfig } from '../src/config.ts';
import { slackConfigSchema } from '../src/config.ts';
import type { SlackCommand, SlackConnection, SlackEvent, SlackHandlers } from '../src/connection.ts';

const BOT = 'U0000000BOT';
const ME = 'U0000000001';
const STRANGER = 'U0000000BAD';
const HOME = 'C0000000001';
const TEAM = 'C0000000002';
const OUTSIDE = 'C0000000009';
const DM = 'D0000000001';

const ask = mock.fn(async (..._turn: unknown[]) => 'Answer');
const createTurnRunner = mock.fn(async (..._built: unknown[]) => ask);

/** The engine as the module sees it: built with what the module hands it, never running a turn. */
const engines: FakeEngine[] = [];
class FakeEngine {
  readonly tick = mock.fn();
  readonly stop = mock.fn();
  readonly shutdown = mock.fn(async () => {});
  readonly stopTurn = mock.fn((_channel: string): Turn | null => null);
  readonly args: ConstructorParameters<typeof host.ChannelEngine>;
  constructor(...args: ConstructorParameters<typeof host.ChannelEngine>) {
    this.args = args;
    engines.push(this);
  }
}
mock.module('@aivi/host', { exports: { ...host, ChannelEngine: FakeEngine, createTurnRunner } });

const { createSlackModule, openSlackStore, routeMessage, slackManifest } = await import('../src/module.ts');

/** HOME is a threads channel, TEAM a channel-mode one; nothing is posted to report channels unless a test says. */
const config: SlackConfig = slackConfigSchema.parse({
  directory: '/assistant',
  commandPrefix: 'spider',
  access: { channels: [{ id: HOME }, { id: TEAM, trigger: 'any', sessions: 'channel' }] },
  progress: 'silent',
});

const message = (over: Partial<SlackEvent> & { channel: string; ts: string }): SlackEvent => ({
  type: 'message',
  user: ME,
  text: 'hello',
  channel_type: over.channel.startsWith('D') ? 'im' : 'channel',
  ...over,
});

function fakeConnection() {
  let handlers!: SlackHandlers;
  let ts = 1000;
  const connection = {
    identify: mock.fn(async () => ({ userId: BOT })),
    connect: mock.fn(async (given: SlackHandlers) => {
      handlers = given;
    }),
    disconnect: mock.fn(async () => {}),
    post: mock.fn(async (_channel: string, _text: string, _threadTs?: string) => ({ ts: `${++ts}.0` })),
    update: mock.fn(async (_channel: string, _ts: string, _text: string) => {}),
    remove: mock.fn(async (_channel: string, _ts: string) => {}),
    ephemeral: mock.fn(async (_url: string, _text: string) => {}),
    react: mock.fn(async (_channel: string, _ts: string, _name: string) => {}),
    unreact: mock.fn(async (_channel: string, _ts: string, _name: string) => {}),
    userName: mock.fn(async (id: string) => (id === ME ? 'Me' : id)),
  } satisfies SlackConnection;
  return {
    connection,
    event: (event: SlackEvent) => handlers.event(event),
    command: (command: Partial<SlackCommand> & { command: string }) =>
      handlers.command({ text: '', user_id: ME, channel_id: DM, response_url: 'https://hooks/x', ...command }),
  };
}

/** The host and what it hands the module, before the module is started. `ME` is a linked account. */
function world(t: TestContext) {
  ask.mock.resetCalls();
  createTurnRunner.mock.resetCalls();
  const lines = recorder();
  const store = new host.Store(':memory:');
  t.after(() => store.close());
  const person = store.createPerson({ name: 'Ada' });
  store.redeemLinkCode(store.mintLinkCode(person.id).code, 'slack', ME);
  const slack = fakeConnection();
  const client = {
    session: {
      prompt: mock.fn(async (..._prompted: unknown[]) => ({})),
      interrupt: mock.fn(async (..._interrupted: unknown[]) => ({})),
    },
  };
  const opencode = mock.fn(async () => client);
  const knowledge = { search: mock.fn(async (_request: unknown) => [] as unknown[]) };
  const unregister = mock.fn();
  const unsubscribe = mock.fn();
  const channels = { register: mock.fn((_entry: ChannelModule) => unregister) };
  const services = {
    loaded: {
      config: configSchema.parse({ version: 1 }),
      path: '/config.json',
      projects: [{ id: 'demo', directory: '/demo' }],
      sources: [],
    },
    store,
    knowledge,
    opencode,
    events: { watch: mock.fn() },
    signal: new AbortController().signal,
    log: lines.log,
    channels,
    dispatcher: {},
    wake: mock.fn(),
    onWake: mock.fn((_listener: () => void) => unsubscribe),
    fail: mock.fn(),
  } as unknown as host.AiviServices;
  return { lines, store, slack, client, opencode, knowledge, unregister, unsubscribe, channels, services };
}
type World = ReturnType<typeof world>;

/** Start the module over the world; the engine it built is the last one made. */
async function start(w: World, mine: SlackConfig = config) {
  const running = await createSlackModule(mine, w.slack.connection).start(w.services);
  return { running, engine: engines.at(-1)! };
}

/** What the person at the other end of Slack has been told. */
const told = (w: World) => w.slack.connection.ephemeral.mock.calls.map(call => call.arguments[1]);
const posted = (w: World) => w.slack.connection.post.mock.calls.map(call => call.arguments);
const reacted = (w: World) => w.slack.connection.react.mock.calls.map(call => call.arguments);
const events = (w: World, level: string) => w.lines.said(level).map(line => line.event);

/** A turn of the DM conversation, running its session — the one a steer or a stop would meet. */
function runningTurn(w: World, id = `${DM}:40.0`) {
  const inbox = openSlackStore(w.store, config);
  inbox.enqueue({ id, channel: DM, user: ME, name: 'Me', text: 'take your time' }, 100);
  inbox.claimTurn(id);
  inbox.ready(DM);
  return inbox;
}

test('a module handed no connection needs the Slack tokens in the environment, and refuses to start without them', async t => {
  const { SLACK_BOT_TOKEN: _bot, SLACK_APP_TOKEN: _app, ...without } = process.env;
  const w = world(t);
  t.mock.property(process, 'env', without);

  await assert.rejects(createSlackModule(config).start(w.services), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, /SLACK_BOT_TOKEN/);
    return true;
  });

  assert.equal(w.channels.register.mock.callCount(), 0, 'nothing was given to the host');
});

test('a changed agent or directory is said at start: every conversation begins a new session', async t => {
  const w = world(t);
  const first = await start(w);
  await first.running.stop();

  await start(w, { ...config, agent: 'concierge' });

  assert.deepEqual(events(w, 'warn'), ['binding.changed']);
});

test('turns a restart cut off are discarded, and each conversation hears about it once', async t => {
  const w = world(t);
  const inbox = openSlackStore(w.store, config);
  const thread = `${HOME}:5.0`;
  for (const [id, channel] of [
    ['a', thread],
    ['b', thread],
    ['c', DM],
  ]) {
    inbox.enqueue({ id: id!, channel: channel!, user: ME, name: 'Me', text: 'working on it' }, 100);
    inbox.claimTurn(id!);
  }
  inbox.result('b', 'half an answ');

  await start(w);

  assert.deepEqual(events(w, 'warn'), ['turns.interrupted']);
  assert.deepEqual(w.lines.said('warn')[0]!.discarded, 3);
  assert.deepEqual(
    inbox.list().map(turn => turn.state),
    ['discarded', 'discarded', 'discarded'],
  );
  assert.deepEqual(posted(w), [
    [HOME, 'I was restarted while replying, so my last answer may be incomplete. Ask again if you need it.', '5.0'],
    [DM, 'I was restarted while working on your last message. Please send it again.', undefined],
  ]);
});

test('a conversation that cannot be told about the restart is logged, and the others are still told', async t => {
  const w = world(t);
  const inbox = openSlackStore(w.store, config);
  for (const channel of [DM, `${HOME}:5.0`]) {
    inbox.enqueue({ id: channel, channel, user: ME, name: 'Me', text: 'working on it' }, 100);
    inbox.claimTurn(channel);
  }
  w.slack.connection.post.mock.mockImplementation(async channel => {
    if (channel === DM) throw new Error('channel_not_found');
    return { ts: '1.0' };
  });

  await start(w);
  const failed = await w.lines.next('notify.failed');

  assert.equal(failed.channel, DM);
  assert.equal(w.slack.connection.post.mock.callCount(), 2, 'the other conversation was told');
});

test('stop gives back what start took, says goodbye, and a socket that will not close does not stop it', async t => {
  const w = world(t);
  w.slack.connection.disconnect.mock.mockImplementation(async () => {
    throw new Error('socket stuck');
  });
  const { running, engine } = await start(w, { ...config, reportChannels: [HOME] });
  assert.equal(w.slack.connection.connect.mock.callCount(), 1);

  await running.stop();

  assert.equal(w.unregister.mock.callCount(), 1, 'the channel entry is given back');
  assert.equal(w.unsubscribe.mock.callCount(), 1, 'the wake listener is given back');
  assert.equal(engine.stop.mock.callCount(), 1);
  assert.equal(engine.shutdown.mock.callCount(), 1);
  assert.deepEqual(
    posted(w).map(call => call[1]),
    ['🟢 aivi is online.', '🔴 aivi is going offline (a restart or shutdown).'],
  );
  assert.deepEqual(events(w, 'warn'), ['disconnect.failed']);
});

test('a start that fails closes the socket and gives the failure back, with nothing announced', async t => {
  const w = world(t);
  w.slack.connection.identify.mock.mockImplementation(async () => {
    throw new Error('token revoked');
  });

  await assert.rejects(start(w, { ...config, reportChannels: [HOME] }), /token revoked/);

  assert.equal(w.slack.connection.disconnect.mock.callCount(), 1, 'the socket is closed');
  assert.deepEqual(posted(w), [], 'a module that never came up says nothing about going offline');
});

test('after stop, a late message or command is dropped without an answer', async t => {
  const w = world(t);
  const { running } = await start(w);
  await running.stop();

  await w.slack.event(message({ channel: DM, ts: '1.0' }));
  await w.slack.command({ command: '/spider-help' });

  assert.deepEqual(posted(w), []);
  assert.deepEqual(told(w), []);
  assert.deepEqual(openSlackStore(w.store, config).list(), []);
});

test('a message that cannot be queued says so, and so does a full queue to /queue', async t => {
  const w = world(t);
  const { engine } = await start(w, { ...config, maxPending: 1 });
  const inbox = openSlackStore(w.store, config);

  await w.slack.event(message({ channel: DM, ts: '50.0' }));
  await w.slack.event(message({ channel: DM, ts: '51.0' }));

  assert.equal(inbox.list().length, 1, 'the second message was not queued');
  assert.deepEqual(posted(w), [
    [DM, 'I could not queue this message. The queue may be full; check /spider-status.', undefined],
  ]);
  assert.deepEqual(events(w, 'warn'), ['enqueue.rejected']);

  await w.slack.command({ command: '/spider-queue', text: 'after this' });

  assert.equal(told(w).at(-1), 'I could not queue this message. The queue may be full; check the status command.');
  assert.deepEqual(events(w, 'warn'), ['enqueue.rejected', 'queue.rejected']);
  assert.equal(engine.tick.mock.callCount(), 1, 'only the queued message woke the engine');
});

test('/queue with nothing running queues the words as a turn of their own and wakes the engine', async t => {
  const w = world(t);
  const { engine } = await start(w);

  await w.slack.command({ command: '/spider-queue', text: ' after this ' });

  const [turn] = openSlackStore(w.store, config).list();
  assert.deepEqual(
    [turn!.channel, turn!.user, turn!.name, turn!.text, turn!.state],
    [DM, ME, 'Me', 'after this', 'queued'],
  );
  assert.match(turn!.id, /^slash:\d+$/);
  assert.equal(told(w).at(-1), 'Queued; nothing is running.');
  assert.equal(engine.tick.mock.callCount(), 1);
});

test('/new with work still queued is refused in words, and keeps the work', async t => {
  const w = world(t);
  await start(w);
  await w.slack.event(message({ channel: DM, ts: '60.0' }));

  await w.slack.command({ command: '/spider-new' });

  assert.equal(
    told(w).at(-1),
    'This conversation has queued or unresolved work. Finish or resolve it before starting fresh.',
  );
  assert.equal(openSlackStore(w.store, config).list().length, 1);
});

test('a steer that cannot be sent is not a lost message: it is logged and queued after all', async t => {
  for (const [why, refuse] of [
    [
      'OpenCode refuses the prompt',
      (w: World) =>
        w.client.session.prompt.mock.mockImplementation(async () => {
          throw new Error('session gone');
        }),
    ],
    [
      'the running turn cannot even be looked up',
      (_w: World, s: TestContext) =>
        s.mock.method(host.ConversationStore.prototype, 'running', () => {
          throw new Error('database is locked');
        }),
    ],
  ] as const) {
    await t.test(why, async s => {
      const w = world(s);
      const { engine } = await start(w);
      const inbox = runningTurn(w);
      refuse(w, s);

      await w.slack.event(message({ channel: DM, ts: '41.0', text: 'also the appendix' }));

      assert.deepEqual(events(w, 'warn'), ['interject.failed']);
      assert.deepEqual(
        inbox
          .list()
          .filter(turn => turn.state === 'queued')
          .map(turn => turn.text),
        ['also the appendix'],
      );
      assert.equal(engine.tick.mock.callCount(), 1);
      assert.deepEqual(reacted(w), [[DM, '41.0', 'hourglass_flowing_sand']]);
    });
  }
});

test('a reaction Slack refuses never fails the message that earned it', async t => {
  for (const [what, steered, reaction] of [
    ['a steer into the running turn', true, 'high_brightness'],
    ['a message that waits its turn', false, 'hourglass_flowing_sand'],
  ] as const) {
    await t.test(what, async s => {
      const w = world(s);
      await start(w);
      const inbox = steered ? runningTurn(w) : openSlackStore(w.store, config);
      w.slack.connection.react.mock.mockImplementation(async () => {
        throw new Error('already_reacted');
      });

      await w.slack.event(message({ channel: DM, ts: '41.0', text: 'also the appendix' }));

      assert.deepEqual(reacted(w), [[DM, '41.0', reaction]]);
      assert.equal(w.client.session.prompt.mock.callCount(), steered ? 1 : 0);
      assert.equal(inbox.list().length, 1, 'the one turn there is: the running one, or the one that waits');
    });
  }
});

test('the turn runner is wrapped: 👀 while a message turn works and cleared when it ends, refused or not', async t => {
  for (const refusing of [false, true]) {
    await t.test(refusing ? 'Slack refuses every reaction' : 'Slack takes every reaction', async s => {
      const w = world(s);
      const { engine } = await start(w);
      const working = Promise.withResolvers<void>();
      w.slack.connection.react.mock.mockImplementation(async () => {
        working.resolve();
        if (refusing) throw new Error('no_reaction');
      });
      w.slack.connection.unreact.mock.mockImplementation(async () => {
        if (refusing) throw new Error('no_reaction');
      });
      const turn = { kind: 'message', id: `${DM}:60.0` } as Turn;
      const [signal, ready] = [new AbortController().signal, () => {}];

      const answer = await engine.args[3](turn, signal, ready);
      await working.promise;

      assert.equal(answer, 'Answer');
      assert.deepEqual(ask.mock.calls[0]!.arguments, [turn, signal, ready, undefined]);
      assert.deepEqual(
        w.slack.connection.unreact.mock.calls.map(call => call.arguments),
        [
          [DM, '60.0', 'hourglass_flowing_sand'],
          [DM, '60.0', 'eyes'],
        ],
        'the hourglass goes when the work starts, the eyes when it ends',
      );
      assert.deepEqual(reacted(w), [[DM, '60.0', 'eyes']]);
    });
  }
});

test('a job turn, or a message turn whose id names no message, has nothing to react to', async t => {
  const w = world(t);
  const { engine } = await start(w);

  for (const turn of [
    { kind: 'job', id: 'run:run-1' },
    { kind: 'message', id: 'no-message-here' },
  ] as Turn[]) {
    const answer = await engine.args[3](turn, new AbortController().signal, () => {});

    assert.equal(answer, 'Answer');
  }
  assert.equal(w.slack.connection.react.mock.callCount() + w.slack.connection.unreact.mock.callCount(), 0);
});

test('the duplicate filter remembers the last thousand messages and forgets the ones before', async t => {
  const w = world(t);
  await start(w);
  const textless = (n: number) => message({ channel: DM, ts: `${n}.0`, text: '', files: [{}] });
  for (let n = 1; n <= 1001; n++) await w.slack.event(textless(n));
  const answered = posted(w).length;

  await w.slack.event(textless(1001));
  assert.equal(posted(w).length, answered, 'the newest message is still a duplicate');

  await w.slack.event(textless(1));
  assert.equal(posted(w).length, answered + 1, 'the oldest was forgotten, so it is a new message');
});

test('a link hint that cannot be posted is dropped, and the message handler still ends', async t => {
  const w = world(t);
  w.slack.connection.post.mock.mockImplementation(async () => {
    throw new Error('channel_not_found');
  });
  await start(w);

  await w.slack.event(message({ channel: DM, ts: '1.0', user: STRANGER }));

  assert.equal(posted(w).length, 1);
  assert.match(String(posted(w)[0]![1]), /aivi link slack/);
});

test('/context describes a conversation with no session, and says so when OpenCode cannot be read', async t => {
  const w = world(t);
  await start(w);

  await w.slack.command({ command: '/spider-context' });
  assert.match(told(w).at(-1)!, /no session yet[\s\S]*Nothing pending here\./);

  openSlackStore(w.store, config).adopt(DM, { session: 'ses_job', agent: 'assistant', directory: '/assistant' });
  w.opencode.mock.mockImplementation(async () => {
    throw new Error('No running OpenCode v2 service found');
  });
  await w.slack.command({ command: '/spider-context' });

  assert.equal(told(w).at(-1), 'I could not read this session from OpenCode just now.');
  assert.deepEqual(events(w, 'warn'), ['context.failed']);
});

test('/model says so when OpenCode cannot be read, whether it was asked to show or to switch', async t => {
  const w = world(t);
  await start(w);
  w.opencode.mock.mockImplementation(async () => {
    throw new Error('No running OpenCode v2 service found');
  });

  for (const text of ['', 'github-copilot/gpt-5.2']) {
    await w.slack.command({ command: '/spider-model', text });
    assert.equal(told(w).at(-1), 'I could not read the model catalogue from OpenCode just now.', `/model ${text}`);
  }

  assert.deepEqual(events(w, 'warn'), ['model.failed', 'model.failed']);
});

test('/search says when nothing matches, and when the search itself fails', async t => {
  const w = world(t);
  await start(w);

  await w.slack.command({ command: '/spider-search', text: 'working agreements' });
  assert.equal(told(w).at(-1), 'No matching documents.');

  w.knowledge.search.mock.mockImplementation(async () => {
    throw new Error('the index is closed');
  });
  await w.slack.command({ command: '/spider-search', text: 'working agreements' });

  assert.equal(told(w).at(-1), 'Search is unavailable or the project is unknown.');
  assert.deepEqual(events(w, 'warn'), ['search.failed']);
});

test('/stop says when OpenCode could not be told to interrupt, and logs why', async t => {
  const w = world(t);
  const { engine } = await start(w);
  engine.stopTurn.mock.mockImplementation(() => ({ ready: true, session: 'ses_run' }) as Turn);
  w.client.session.interrupt.mock.mockImplementation(async () => {
    throw new Error('No running OpenCode v2 service found');
  });

  await w.slack.command({ command: '/spider-stop' });

  assert.deepEqual(
    engine.stopTurn.mock.calls.map(call => call.arguments),
    [[DM]],
  );
  assert.match(told(w).at(-1)!, /^Stopped here, but I could not tell OpenCode to interrupt the agent/);
  assert.deepEqual(events(w, 'warn'), ['stop.interrupt_failed']);
});

/** A job due far ahead and three runs that finished within the last day, for `/status` to summarise. */
function hostActivity(store: host.Store) {
  const now = Date.now();
  store.addJob(
    jobSchema.parse({ id: 'digest', at: '2099-01-02T09:30:00.000Z', task: 'system.check' }),
    'operator',
    now,
  );
  for (const [n, state] of (['succeeded', 'failed', 'succeeded'] as const).entries()) {
    const run = store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', `finished-${n}`, now);
    store.claimRun(run.id, 'host', now - 10_000);
    store.finish(run.id, 'host', state, null, 'done', now - 1000 * (n + 1));
  }
}

test('/status counts what waits in this conversation, or in every thread of a threads channel, beside jobs and runs', async t => {
  const w = world(t);
  await start(w);
  hostActivity(w.store);
  const inbox = openSlackStore(w.store, config);
  for (const [id, channel] of [
    ['dm-1', DM],
    ['dm-2', DM],
    ['thread-1', `${HOME}:5.0`],
    ['elsewhere', TEAM],
  ])
    inbox.enqueue({ id: id!, channel: channel!, user: ME, name: 'Me', text: 'hello' }, 100);
  inbox.claimTurn('dm-2');

  await w.slack.command({ command: '/spider-status', channel_id: DM });
  await w.slack.command({ command: '/spider-status', channel_id: HOME });

  const tail = ['Next jobs: digest at 2099-01-02 09:30 UTC.', 'Runs in the last 24 h: 2 succeeded, 1 failed.'];
  assert.deepEqual(told(w), [
    ['2 pending turn(s): queued, running. Blocked turns require operator inspection.', ...tail].join('\n'),
    ['1 pending turn(s): queued. Blocked turns require operator inspection.', ...tail].join('\n'),
  ]);
});

test('/link spends a code for whoever holds it, in any place aivi listens, linked or not', async t => {
  const w = world(t);
  const grace = w.store.createPerson({ name: 'Grace' });
  const { code } = w.store.mintLinkCode(grace.id);
  await start(w);

  await w.slack.command({ command: '/spider-link', user_id: STRANGER, text: ` ${code} ` });

  assert.equal(told(w).at(-1), 'Linked. This account now belongs to Grace.');
  assert.equal(w.store.identityFor('slack', STRANGER)?.id, grace.id);
});

test('a command from where or whom aivi does not serve is refused in words', async t => {
  const w = world(t);
  await start(w);
  const enabled = 'This user or conversation is not enabled for aivi.';

  for (const [command, answer] of [
    [
      { command: '/spider-status', user_id: STRANGER },
      "I don't know you yet. Run `aivi link slack` where you work, then send `/spider-link CODE` to me — from then on I answer as your person.",
    ],
    [{ command: '/spider-status', channel_id: OUTSIDE }, enabled],
    [{ command: '/spider-status', channel_id: HOME, user_id: STRANGER }, enabled],
    [{ command: '/spider-link', channel_id: OUTSIDE, text: '12345' }, enabled],
  ] as const) {
    await w.slack.command(command);

    assert.equal(told(w).at(-1), answer, `${command.command} in ${command.channel_id ?? DM}`);
  }
});

test('the channel entry owns the sessions its conversations are bound to, and says which channel each lives in', async t => {
  const w = world(t);
  await start(w, { ...config, reportChannels: [HOME] });
  const entry = w.channels.register.mock.calls[0]!.arguments[0];
  const inbox = openSlackStore(w.store, config);
  inbox.adopt(`${HOME}:5.0`, { session: 'ses_job', agent: 'assistant', directory: '/assistant' });
  inbox.adopt(DM, { seed: 'an outcome' });

  assert.equal(entry.id, 'slack');
  assert.deepEqual([entry.ownsSession('ses_job'), entry.ownsSession('ses_other')], [true, false]);
  assert.equal(await entry.channelOf('ses_job'), HOME, 'a thread lives in its channel');
  assert.equal(await entry.channelOf(inbox.sessionOf(DM)!.session), DM);
  assert.equal(await entry.channelOf('ses_other'), undefined);
  assert.deepEqual([entry.accepts(HOME), entry.accepts(TEAM)], [true, false]);
});

test('a report goes only where the operator said; its thread becomes a conversation seeded with it', async t => {
  const w = world(t);
  await start(w, { ...config, reportChannels: [HOME] });
  const entry = w.channels.register.mock.calls[0]!.arguments[0];
  const inbox = openSlackStore(w.store, config);

  await assert.rejects(entry.post(TEAM, 'x', {}), /Slack channel C0000000002 is not in reportChannels/);

  w.slack.connection.post.mock.mockImplementationOnce(async () => ({ ts: '7.0' }));
  await entry.post(HOME, 'The outcome', {});
  inbox.enqueue({ id: 'reply-1', channel: `${HOME}:7.0`, user: ME, name: 'Me', text: 'what did you do?' }, 100);

  assert.equal(inbox.nextTurn()?.seed, 'The outcome', 'the first reply in the thread carries the report');
});

test('a thread that is already a conversation is logged, and the rest of a long report still follows it', async t => {
  const w = world(t);
  await start(w, { ...config, reportChannels: [HOME] });
  const entry = w.channels.register.mock.calls[0]!.arguments[0];
  openSlackStore(w.store, config).adopt(`${HOME}:7.0`, { seed: 'earlier' });
  w.slack.connection.post.mock.mockImplementationOnce(async () => ({ ts: '7.0' }));

  await entry.post(HOME, 'x'.repeat(4000), {});

  assert.deepEqual(events(w, 'warn'), ['report.adopt.failed']);
  assert.deepEqual(posted(w).at(-1), [HOME, 'x'.repeat(100), '7.0']);
});

test('a DM is told by the shape of its id when Slack leaves out the channel type, and a message may carry no text', () => {
  const route = (event: SlackEvent) =>
    routeMessage(
      config,
      BOT,
      event,
      () => false,
      () => true,
    );

  assert.deepEqual(route({ type: 'message', channel: DM, ts: '1.0', user: ME }), {
    route: {
      channelId: DM,
      parentId: null,
      userId: ME,
      isDM: true,
      mentioned: false,
      knownConversation: false,
      senderLinked: true,
    },
    conversation: DM,
    text: '',
  });
  assert.equal(
    route({ type: 'message', channel: HOME, ts: '1.0', user: ME }),
    null,
    'an id that is not a DM’s is a channel, where a mention is needed',
  );
});

test('the manifest names the persona aivi by default, and takes the name, description and colour it is given', () => {
  const display = (manifest: Record<string, unknown>) => manifest.display_information;

  assert.deepEqual(display(slackManifest()), {
    name: 'aivi',
    description: "The team's assistant",
    background_color: '#4c7185',
  });
  assert.deepEqual(
    display(slackManifest('aivi', { name: '   ' })),
    display(slackManifest()),
    'a blank name is no name',
  );
  assert.deepEqual(
    display(slackManifest('spider', { name: ' Clawd ', description: 'Helps', backgroundColor: '#112233' })),
    { name: 'Clawd', description: 'Helps', background_color: '#112233' },
  );
});
