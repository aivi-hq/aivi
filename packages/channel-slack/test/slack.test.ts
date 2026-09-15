import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { Job, KnowledgeService } from '@aivi/core';
import { configSchema, silentLogger } from '@aivi/core';
import type { HostServices } from '@aivi/host';
import { Channels, connectOpenCode, Store } from '@aivi/host';
import { slackConfigSchema } from '../src/config.ts';
import type { SlackCommand, SlackConnection, SlackEvent, SlackHandlers } from '../src/connection.ts';
import { conversationParts, createSlackModule, openSlackStore, routeMessage, SLACK } from '../src/module.ts';

const BOT = 'U0000000BOT';
const ME = 'U0000000001';
const HOME = 'C0000000001';
const TEAM = 'C0000000002';
const DM = 'D0000000001';
const config = slackConfigSchema.parse({
  version: 1,
  directory: '/librarian',
  commandPrefix: 'spider',
  access: {
    dm: { users: [ME] },
    channels: [
      { id: HOME, users: 'anyone' },
      { id: TEAM, users: [ME], trigger: 'any', sessions: 'channel' },
    ],
  },
  reportChannels: [HOME],
});
const message = (over: Partial<SlackEvent> & { channel: string; ts: string }): SlackEvent => ({
  type: 'message',
  user: ME,
  text: 'hello',
  channel_type: over.channel.startsWith('D') ? 'im' : 'channel',
  ...over,
});

test('config: Slack ids are checked, defaults match Discord’s, the owner’s shape parses', () => {
  assert.equal(config.agent, 'librarian');
  assert.equal(config.maxPending, 100);
  assert.equal(slackConfigSchema.parse({ version: 1, access: {} }).commandPrefix, 'aivi');
  assert.throws(() => slackConfigSchema.parse({ version: 1, access: { dm: { users: ['1234'] } } }), /Slack user id/);
  assert.throws(() => slackConfigSchema.parse({ version: 1, access: { channels: [{ id: 'general' }] } }), /channel id/);
  assert.throws(() => slackConfigSchema.parse({ version: 1, access: {}, reportChannels: [DM] }), /channel id/);
  assert.throws(
    () => slackConfigSchema.parse({ version: 1, access: {}, commandPrefix: 'Spider Bot' }),
    /commandPrefix/,
  );
  assert.deepEqual(SLACK, { id: 'slack', label: 'Slack', replyLimit: 3900 });
  assert.deepEqual(conversationParts(`${HOME}:1.5`), { channel: HOME, threadTs: '1.5' });
  assert.deepEqual(conversationParts(DM), { channel: DM });
});

test('routing: DMs, mentions opening threads, threads aivi is in, channel mode, and what is ignored', () => {
  const known = (c: string) => c === `${HOME}:100.1`;
  const dm = routeMessage(config, BOT, message({ channel: DM, ts: '1.0' }), known)!;
  assert.deepEqual([dm.conversation, dm.route.isDM, dm.text], [DM, true, 'hello']);
  assert.equal(routeMessage(config, BOT, message({ channel: DM, ts: '1.0', user: 'U0000000BAD' }), known), null);
  assert.equal(routeMessage(config, BOT, message({ channel: DM, ts: '1.0', bot_id: 'B1' }), known), null, 'bots');
  assert.equal(routeMessage(config, BOT, message({ channel: DM, ts: '1.0', user: BOT }), known), null, 'itself');
  assert.equal(
    routeMessage(config, BOT, message({ channel: DM, ts: '1.0', subtype: 'message_changed' }), known),
    null,
    'edits and other subtypes',
  );
  assert.equal(routeMessage(config, BOT, message({ channel: HOME, ts: '2.0' }), known), null, 'needs a mention');
  const opened = routeMessage(config, BOT, message({ channel: HOME, ts: '2.0', text: `<@${BOT}> hi there` }), known)!;
  assert.deepEqual([opened.conversation, opened.route.parentId, opened.text], [`${HOME}:2.0`, null, 'hi there']);
  const viaEvent = routeMessage(
    config,
    BOT,
    message({ type: 'app_mention', channel: HOME, ts: '2.0', text: 'x' }),
    known,
  )!;
  assert.equal(viaEvent.conversation, `${HOME}:2.0`, 'an app_mention event is a mention even without the tag');
  const inThread = routeMessage(config, BOT, message({ channel: HOME, ts: '3.0', thread_ts: '100.1' }), known)!;
  assert.deepEqual(
    [inThread.conversation, inThread.route.parentId, inThread.route.knownConversation],
    [`${HOME}:100.1`, HOME, true],
  );
  assert.equal(
    routeMessage(config, BOT, message({ channel: HOME, ts: '3.0', thread_ts: '200.1' }), known),
    null,
    'a thread aivi is not part of still needs a mention',
  );
  const onlyMention = routeMessage(config, BOT, message({ channel: HOME, ts: '4.0', text: `<@${BOT}>` }), known)!;
  assert.equal(onlyMention.text, `<@${BOT}>`, 'a bare mention keeps its text so the empty check can reply');
  const team = routeMessage(config, BOT, message({ channel: TEAM, ts: '5.0' }), known)!;
  assert.equal(team.conversation, TEAM, 'channel mode: the channel is the conversation');
  assert.equal(routeMessage(config, BOT, message({ channel: TEAM, ts: '5.1', thread_ts: '5.0' }), known), null);
  assert.equal(routeMessage(config, BOT, message({ channel: TEAM, ts: '5.0', user: 'U0000000BAD' }), known), null);
  assert.equal(
    routeMessage(config, BOT, message({ channel: 'C0000000009', ts: '6.0', text: `<@${BOT}>` }), known),
    null,
  );
});

/** A tiny OpenCode: any session exists with the module agent, every prompt gets the same answer. */
async function fakeOpenCode(t: { after(fn: () => Promise<void>): void }, answer: string) {
  const prompts: { id: string; text: string; metadata: any }[] = [];
  const sessions = new Map<string, { agent: string; directory: string }>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url!;
    res.setHeader('content-type', 'application/json');
    if (url.endsWith('/permission/rules') || url.endsWith('/wait')) return void res.writeHead(204).end();
    if (url.endsWith('/permission') && req.method === 'GET') return void res.end('{"data":[]}');
    if (url === '/api/session' && req.method === 'POST') {
      sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/prompt')) {
      prompts.push({ id: body.id, text: body.text, metadata: body.metadata });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/context')) {
      const last = prompts.at(-1)!;
      return void res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: last.id, text: last.text, time: { created: 1 } },
            {
              type: 'assistant',
              id: 'a',
              agent: 'librarian',
              finish: 'stop',
              time: { created: 2, completed: 3 },
              content: [{ type: 'text', text: answer }],
            },
            { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } },
          ],
        }),
      );
    }
    const id = decodeURIComponent(url.split('/').at(-1)!);
    const session = sessions.get(id) ?? { agent: 'librarian', directory: '/librarian' };
    res.end(JSON.stringify({ data: { id, ...session, location: { directory: session.directory } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, prompts, sessions };
}

function fakeConnection() {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const reactions: string[] = [];
  const ephemerals: string[] = [];
  let handlers: SlackHandlers | undefined;
  let ts = 1000;
  const connection: SlackConnection = {
    identify: async () => ({ userId: BOT }),
    async connect(h) {
      handlers = h;
    },
    disconnect: async () => {},
    async post(channel, text, threadTs) {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return { ts: `${++ts}.0` };
    },
    ephemeral: async (_url, text) => void ephemerals.push(text),
    react: async (channel, ts, name) => void reactions.push(`+${name}@${channel}:${ts}`),
    unreact: async (channel, ts, name) => void reactions.push(`-${name}@${channel}:${ts}`),
    userName: async id => (id === ME ? 'Me' : id),
  };
  return {
    connection,
    posts,
    reactions,
    ephemerals,
    event: (e: SlackEvent) => handlers!.event(e),
    command: (c: Partial<SlackCommand> & { command: string }) =>
      handlers!.command({ text: '', user_id: ME, channel_id: HOME, response_url: 'https://hooks/x', ...c }),
  };
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};

test('the module: a mention opens a thread and is answered there once; duplicates, files, reports, re-entry, commands', async t => {
  const store = new Store(':memory:');
  const opencode = await fakeOpenCode(t, 'Answer');
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: opencode.url } }),
    path: '/aivi.json',
    projects: [{ id: 'demo', directory: '/demo', settings: { knowledge: [] } }],
    sources: [],
  };
  const searches: unknown[] = [];
  const knowledge: KnowledgeService = {
    async search(request) {
      searches.push(request);
      return [
        { sourceId: 's', kind: 'doc', scope: 'core', path: '/k/a.md', title: 'A', excerpt: 'hit', line: 1, score: 1 },
      ];
    },
    index: async () => ({}),
    close: async () => {},
  };
  const channels = new Channels();
  const abort = new AbortController();
  const slack = fakeConnection();
  const services: HostServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    signal: abort.signal,
    log: silentLogger,
    channels,
    wake: () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createSlackModule(config, slack.connection).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  // Slack sends app_mention and message for one mention; the person gets one answer, in a thread on the message.
  await slack.event(message({ type: 'app_mention', channel: HOME, ts: '10.0', text: `<@${BOT}> what is aivi?` }));
  await slack.event(message({ channel: HOME, ts: '10.0', text: `<@${BOT}> what is aivi?` }));
  await until(() => slack.posts.length === 1, 'one reply');
  assert.deepEqual(slack.posts[0], { channel: HOME, text: 'Answer', threadTs: '10.0' });
  const inbox = openSlackStore(store, config);
  const [first] = inbox.list();
  assert.deepEqual(
    [first!.id, first!.channel, first!.name, first!.state],
    [`${HOME}:10.0`, `${HOME}:10.0`, 'Me', 'sent'],
  );
  assert.match(first!.session, /^ses_slack_/);
  assert.equal(opencode.prompts[0]!.id, `msg_slack_${HOME}_10_0`);
  assert.equal(opencode.prompts[0]!.text, `[Slack message from Me (user ${ME})]\nwhat is aivi?`);
  assert.deepEqual(opencode.sessions.get(first!.session), { agent: 'librarian', directory: '/librarian' });

  // A follow-up inside that thread needs no mention; a file-only message gets the text-only reply in the thread.
  await slack.event(message({ channel: HOME, ts: '11.0', thread_ts: '10.0', text: 'more' }));
  await until(() => slack.posts.length === 2, 'thread reply');
  assert.deepEqual(slack.posts[1], { channel: HOME, text: 'Answer', threadTs: '10.0' });
  await slack.event(message({ channel: HOME, ts: '12.0', thread_ts: '10.0', text: '', files: [{}] }));
  assert.equal(slack.posts.at(-1)!.text, 'Text messages only for now; paste the relevant text.');
  assert.equal(slack.posts.at(-1)!.threadTs, '10.0');
  assert.equal(inbox.list().length, 2);
  // Strangers and un-mentioned top-level messages never reach the inbox.
  await slack.event(message({ channel: HOME, ts: '13.0', text: 'unaddressed' }));
  await slack.event(message({ channel: DM, ts: '14.0', user: 'U0000000BAD' }));
  assert.equal(inbox.list().length, 2);

  // A report opens a thread that adopts the job session; a reply there continues it with that job's agent.
  const job: Job = {
    id: 'job-1',
    task: {
      kind: 'opencode.prompt',
      agent: 'librarian',
      directory: '/librarian',
      prompt: 'p',
      timeoutMs: 1,
      onPermission: 'reject',
    },
    resource: 'local-model',
    state: 'succeeded',
    createdAt: 0,
    scheduledFor: 0,
    startedAt: null,
    finishedAt: null,
    scheduleId: null,
    sessionId: 'ses_aivi_job1',
    owner: null,
    result: null,
    error: null,
    report: null,
  };
  assert.match(
    channels.refuse({ to: 'channel', module: 'slack', channel: TEAM, on: 'always' }) ?? '',
    /does not allow/,
  );
  await channels.deliver({ to: 'channel', module: 'slack', channel: HOME, on: 'always' }, 'x'.repeat(4000), {
    job,
    state: 'succeeded',
  });
  const opener = slack.posts.at(-2)!;
  assert.deepEqual([opener.channel, opener.threadTs, opener.text.length], [HOME, undefined, 3900]);
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'x'.repeat(100), threadTs: '1004.0' });
  assert.equal(channels.ownerOf('ses_aivi_job1'), 'slack');
  await slack.event(message({ channel: HOME, ts: '15.0', thread_ts: '1004.0', text: 'what did you do?' }));
  await until(() => slack.posts.length === 6, 'answered in the report thread');
  assert.equal(opencode.prompts.at(-1)!.metadata.aivi.channel, `${HOME}:1004.0`);
  assert.equal(inbox.list().at(-1)!.session, 'ses_aivi_job1');
  // A job result addressed to that session re-enters the thread as a job turn.
  await channels.deliver({ to: 'session', session: 'ses_aivi_job1', on: 'always' }, '✅ done', {
    job,
    state: 'succeeded',
  });
  await until(() => slack.posts.length === 7, 'the outcome is relayed in the thread');
  assert.equal(inbox.list().at(-1)!.kind, 'job');
  assert.match(opencode.prompts.at(-1)!.text, /^\[aivi delivers the outcome/);
  assert.equal(opencode.prompts.at(-1)!.id, 'msg_slack_job_job_1');
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'Answer', threadTs: '1004.0' });

  // Slash commands: prefix-bound, ephemeral, and thread mode has nothing to reset.
  await slack.command({ command: '/other-status' });
  assert.equal(slack.ephemerals.length, 0);
  await slack.command({ command: '/spider-status' });
  assert.match(slack.ephemerals.at(-1)!, /^Ready for your next message\.\nNo schedules are due\./);
  await slack.command({ command: '/spider-new' });
  assert.match(slack.ephemerals.at(-1)!, /every thread is its own conversation/);
  await slack.command({ command: '/spider-new', channel_id: DM });
  assert.match(slack.ephemerals.at(-1)!, /fresh session/);
  await slack.command({ command: '/spider-status', channel_id: DM, user_id: 'U0000000BAD' });
  assert.match(slack.ephemerals.at(-1)!, /not enabled/);
  await slack.command({ command: '/spider-search', text: 'working agreements demo' });
  assert.deepEqual(searches.at(-1), { query: 'working agreements', limit: 3, projects: ['demo'] });
  assert.match(slack.ephemerals.at(-1)!, /^A — \/k\/a\.md:1\nhit$/);
  await slack.command({ command: '/spider-search', text: 'demo' });
  assert.deepEqual(searches.at(-1), { query: 'demo', limit: 3 }, 'a lone word is the query');
  await slack.command({ command: '/spider-search', text: '' });
  assert.match(slack.ephemerals.at(-1)!, /Usage/);

  assert.ok(
    !slack.reactions.some(r => r.startsWith('+hourglass')),
    'nothing waited, so no hourglass was added (removal is attempted for every turn)',
  );
  const eyes = slack.reactions.filter(r => r.includes('eyes'));
  assert.ok(eyes.length >= 2 && eyes[0]!.startsWith('+eyes') && eyes.at(-1)!.startsWith('-eyes'), '👀 while working');
  await running.stop();
  assert.equal(channels.has('slack'), false);
});

test('a queued message shows the hourglass until its turn starts; a turn that never started asks to resend', async t => {
  const store = new Store(':memory:');
  const loaded = { config: configSchema.parse({ version: 1 }), path: '/aivi.json', projects: [], sources: [] };
  const slack = fakeConnection();
  const abort = new AbortController();
  const services: HostServices = {
    loaded,
    store,
    knowledge: { search: async () => [], index: async () => ({}), close: async () => {} },
    opencode: async () => {
      throw new Error('No running OpenCode v2 service found');
    },
    signal: abort.signal,
    log: silentLogger,
    channels: new Channels(),
    wake: () => {},
    fail: error => assert.fail(String(error)),
  };
  // Capacity is taken by a job, so the message waits.
  const job = store.claim('host', 1, loaded.config.scheduler.resources, 0);
  assert.equal(job, null);
  store.enqueue({ kind: 'system.check' }, 'local-model', 'busy');
  const busy = store.claim('host', 1, loaded.config.scheduler.resources)!;
  const running = await createSlackModule(config, slack.connection).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await slack.event(message({ channel: DM, ts: '20.0', text: 'are you there?' }));
  assert.deepEqual(slack.reactions, [`+hourglass_flowing_sand@${DM}:20.0`]);
  assert.equal(openSlackStore(store, config).state(`${DM}:20.0`), 'queued');
  store.finish(busy.id, 'host', 'succeeded', {}, 'done');
  await until(() => slack.posts.length === 1, 'the person is told the turn did not start');
  await until(() => slack.reactions.length === 4, 'the working reaction is cleared too');
  assert.deepEqual(slack.reactions, [
    `+hourglass_flowing_sand@${DM}:20.0`,
    `-hourglass_flowing_sand@${DM}:20.0`,
    `+eyes@${DM}:20.0`,
    `-eyes@${DM}:20.0`,
  ]);
  assert.match(slack.posts[0]!.text, /send that again/);
  assert.equal(openSlackStore(store, config).list()[0]!.state, 'discarded');
  assert.equal(store.leases().length, 0);
});
