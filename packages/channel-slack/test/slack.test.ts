import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { KnowledgeService, Run } from '@aivi/core';
import { configSchema, silentLogger, slackConfigSchema } from '@aivi/core';
import type { HostServices, SessionEvent, SessionEventListener, SessionEvents } from '@aivi/host';
import { CHAT_COMMANDS, Channels, connectOpenCode, PublicRoutes, Store } from '@aivi/host';
import type { SlackCommand, SlackConnection, SlackEvent, SlackHandlers } from '../src/connection.ts';
import {
  conversationParts,
  createSlackModule,
  openSlackStore,
  routeMessage,
  SLACK,
  slackManifestCommands,
} from '../src/module.ts';

const BOT = 'U0000000BOT';
const ME = 'U0000000001';
const HOME = 'C0000000001';
const TEAM = 'C0000000002';
const DM = 'D0000000001';
const config = slackConfigSchema.parse({
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
  // The shared module test asserts every post; progress placeholders have their own test below.
  progress: 'silent',
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
  assert.equal(slackConfigSchema.parse({ access: {} }).commandPrefix, 'aivi');
  assert.throws(() => slackConfigSchema.parse({ access: { dm: { users: ['1234'] } } }), /Slack user id/);
  assert.throws(() => slackConfigSchema.parse({ access: { channels: [{ id: 'general' }] } }), /channel id/);
  assert.throws(() => slackConfigSchema.parse({ access: {}, reportChannels: [DM] }), /channel id/);
  assert.throws(() => slackConfigSchema.parse({ access: {}, commandPrefix: 'Spider Bot' }), /commandPrefix/);
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
async function fakeOpenCode(
  t: { after(fn: () => Promise<void>): void },
  answer: string,
  /** Holds `session.wait` so a test can act while the turn is running. */
  gate: () => Promise<void> = async () => {},
) {
  const prompts: { id: string; text: string; metadata: any; delivery: string }[] = [];
  const sessions = new Map<string, { agent: string; directory: string; model?: unknown }>();
  const interrupted: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, 'http://x').pathname;
    res.setHeader('content-type', 'application/json');
    if (url.endsWith('/wait')) await gate();
    if (url.startsWith('/api/agent')) return void res.end('{"data":[{"id":"librarian","name":"librarian"}]}');
    if (url === '/api/model')
      return void res.end(
        JSON.stringify({
          location: {},
          data: [
            {
              id: 'github-copilot/gpt-5.2',
              providerID: 'github-copilot',
              modelID: 'gpt-5.2',
              name: 'GPT 5.2',
              enabled: true,
              variants: [{ id: 'high' }],
              limit: { context: 128_000, output: 16_000 },
            },
          ],
        }),
      );
    if (url === '/api/model/default') return void res.end('{"location":{},"data":null}');
    if (url.endsWith('/message')) return void res.end('{"data":[],"cursor":{"next":null}}');
    if (url.endsWith('/interrupt')) {
      interrupted.push(decodeURIComponent(url.split('/').at(-2)!));
      return void res.end('{"interrupted":true}');
    }
    if (req.method === 'PATCH' || url.endsWith('/wait') || url.endsWith('/model')) return void res.writeHead(204).end();
    if (url.endsWith('/permission') && req.method === 'GET') return void res.end('{"data":[]}');
    if (url === '/api/session' && req.method === 'POST') {
      sessions.set(body.id, {
        agent: body.agent,
        directory: body.location.directory,
        ...(body.model ? { model: body.model } : {}),
      });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/prompt')) {
      prompts.push({ id: body.id, text: body.text, metadata: body.metadata, delivery: body.delivery });
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
  return { url: `http://127.0.0.1:${address.port}`, prompts, sessions, interrupted };
}

function fakeConnection() {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  /** Gateway status posts (online/offline) in report channels, kept apart from conversation posts. */
  const notices: { channel: string; text: string }[] = [];
  const reactions: string[] = [];
  const ephemerals: string[] = [];
  const edits: string[] = [];
  let handlers: SlackHandlers | undefined;
  let ts = 1000;
  const connection: SlackConnection = {
    identify: async () => ({ userId: BOT }),
    async connect(h) {
      handlers = h;
    },
    disconnect: async () => {},
    async post(channel, text, threadTs) {
      // Status notices are not conversation posts and take no ts, so thread expectations stay put.
      if (!threadTs && /^(🟢|🔴) aivi is /.test(text)) {
        notices.push({ channel, text });
        return { ts: '0.0' };
      }
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return { ts: `${++ts}.0` };
    },
    update: async (channel, ts, text) => void edits.push(`${channel}:${ts} ${text}`),
    remove: async (channel, ts) => void edits.push(`${channel}:${ts} deleted`),
    ephemeral: async (_url, text) => void ephemerals.push(text),
    react: async (channel, ts, name) => void reactions.push(`+${name}@${channel}:${ts}`),
    unreact: async (channel, ts, name) => void reactions.push(`-${name}@${channel}:${ts}`),
    userName: async id => (id === ME ? 'Me' : id),
  };
  return {
    connection,
    posts,
    notices,
    reactions,
    ephemerals,
    edits,
    event: (e: SlackEvent) => handlers!.event(e),
    command: (c: Partial<SlackCommand> & { command: string }) =>
      handlers!.command({ text: '', user_id: ME, channel_id: HOME, response_url: 'https://hooks/x', ...c }),
  };
}

const noEvents: SessionEvents = { watch: () => () => {} };
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
    projects: [{ id: 'demo', directory: '/demo' }],
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
    events: noEvents,
    signal: abort.signal,
    log: silentLogger,
    channels,
    routes: new PublicRoutes(),
    wake: () => {},
    onWake: () => () => {},
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
  const run: Run = {
    id: 'run-1',
    jobId: 'job-1',
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
    run,
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
    run,
    state: 'succeeded',
  });
  await until(() => slack.posts.length === 7, 'the outcome is relayed in the thread');
  assert.equal(inbox.list().at(-1)!.kind, 'job');
  assert.match(opencode.prompts.at(-1)!.text, /^\[aivi delivers the outcome/);
  assert.equal(opencode.prompts.at(-1)!.id, 'msg_slack_run_run_1');
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'Answer', threadTs: '1004.0' });

  // Slash commands: prefix-bound, ephemeral, and thread mode has nothing to reset.
  await slack.command({ command: '/other-status' });
  assert.equal(slack.ephemerals.length, 0);
  await slack.command({ command: '/spider-status' });
  assert.match(slack.ephemerals.at(-1)!, /^Ready for your next message\.\nNo jobs are due\./);
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
  // The new commands: help and jobs anywhere; the conversation ones refuse a threads channel and act in a DM.
  await slack.command({ command: '/spider-help' });
  assert.match(slack.ephemerals.at(-1)!, /^`\/spider-new` — Start a fresh conversation\n/);
  assert.equal(slack.ephemerals.at(-1)!.split('\n').length, CHAT_COMMANDS.length);
  await slack.command({ command: '/spider-jobs' });
  assert.match(slack.ephemerals.at(-1)!, /^\*\*Next occurrences\*\*\nNo jobs are due\.\n\n\*\*Last runs\*\*\n/);
  for (const name of ['model', 'stop', 'steer']) {
    await slack.command({ command: `/spider-${name}`, text: 'x' });
    assert.match(slack.ephemerals.at(-1)!, /cannot tell which one you mean/, name);
  }
  await slack.command({ command: '/spider-stop', channel_id: DM });
  assert.equal(slack.ephemerals.at(-1), 'Nothing is running in this conversation.');
  await slack.command({ command: '/spider-steer', channel_id: DM });
  assert.equal(slack.ephemerals.at(-1), 'Usage: /spider-steer TEXT');
  await slack.command({ command: '/spider-steer', channel_id: DM, text: 'hey' });
  assert.match(slack.ephemerals.at(-1)!, /^Nothing is running in this conversation\. Send it as a message instead\.$/);
  assert.ok(!opencode.prompts.some(p => p.delivery === 'steer'), 'nothing was queued or steered');
  await slack.command({ command: '/spider-model', channel_id: DM });
  assert.deepEqual(slack.ephemerals.at(-1)!.split('\n'), [
    '🧠 **Model**',
    'This conversation: the agent’s default.',
    'Last answer: none yet.',
    'Agent `librarian`: unknown (the agent file pins none and OpenCode reports no default).',
  ]);
  await slack.command({ command: '/spider-model', channel_id: DM, text: 'nope' });
  assert.match(slack.ephemerals.at(-1)!, /^No model is called `nope`\. Nothing in the catalogue matches/);
  await slack.command({ command: '/spider-model', channel_id: DM, text: 'GPT 5.2 (high)' });
  assert.equal(
    slack.ephemerals.at(-1),
    'This conversation answers with `github-copilot/gpt-5.2@high` from its next message on, until /new.',
  );
  await slack.command({ command: '/spider-model', channel_id: DM });
  assert.match(slack.ephemerals.at(-1)!, /This conversation: `github-copilot\/gpt-5\.2@high` \(pinned with \/model/);
  await slack.event(message({ channel: DM, ts: '16.0', text: 'with the pinned model' }));
  await until(() => slack.posts.length === 8, 'answered in the DM');
  const dmSession = inbox.sessionOf(DM)!.session;
  assert.deepEqual(opencode.sessions.get(dmSession)!.model, {
    providerID: 'github-copilot',
    id: 'gpt-5.2',
    variant: 'high',
  });
  await slack.command({ command: '/spider-new', channel_id: DM });
  assert.equal(inbox.sessionOf(DM)!.model, null, '/new clears the pin');

  assert.ok(
    !slack.reactions.some(r => r.startsWith('+hourglass')),
    'nothing waited, so no hourglass was added (removal is attempted for every turn)',
  );
  const eyes = slack.reactions.filter(r => r.includes('eyes'));
  assert.ok(eyes.length >= 2 && eyes[0]!.startsWith('+eyes') && eyes.at(-1)!.startsWith('-eyes'), '👀 while working');
  await running.stop();
  assert.equal(channels.has('slack'), false);
  assert.deepEqual(
    slack.notices,
    [
      { channel: HOME, text: '🟢 aivi is online.' },
      { channel: HOME, text: '🔴 aivi is going offline (a restart or shutdown).' },
    ],
    'the report channel sees the gateway come and go; a plain post, no thread, no session',
  );
});

test('a queued message shows the hourglass until its turn starts; a turn that never started asks to resend', async t => {
  const store = new Store(':memory:');
  const woken = new Set<() => void>();
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
    events: noEvents,
    signal: abort.signal,
    log: silentLogger,
    channels: new Channels(),
    routes: new PublicRoutes(),
    wake: () => {
      for (const l of woken) l();
    },
    onWake: l => {
      woken.add(l);
      return () => woken.delete(l);
    },
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
  services.wake(); // what the host does when a run releases capacity; the engine ticks, nothing polls
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

test('progress: the placeholder goes into the thread, is updated through chat.update and removed when the answer lands', async t => {
  const store = new Store(':memory:');
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const opencode = await fakeOpenCode(t, 'Answer', () => gate);
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: opencode.url } }),
    path: '/aivi.json',
    projects: [],
    sources: [],
  };
  const listeners = new Map<string, SessionEventListener>();
  const events: SessionEvents = {
    watch(sessionID, listener) {
      listeners.set(sessionID, listener);
      return () => void listeners.delete(sessionID);
    },
  };
  const slack = fakeConnection();
  const abort = new AbortController();
  const services: HostServices = {
    loaded,
    store,
    knowledge: { search: async () => [], index: async () => ({}), close: async () => {} },
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events,
    signal: abort.signal,
    log: silentLogger,
    channels: new Channels(),
    routes: new PublicRoutes(),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createSlackModule({ ...config, progress: 'tools' }, slack.connection).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await slack.event(message({ type: 'app_mention', channel: HOME, ts: '30.0', text: `<@${BOT}> look this up` }));
  await until(() => slack.posts.length === 1, 'the placeholder is posted in the thread at once');
  assert.deepEqual(slack.posts[0], { channel: HOME, text: '⏳ thinking…', threadTs: '30.0' });
  const session = openSlackStore(store, config).list()[0]!.session;
  await until(() => listeners.has(session), 'the turn watches its session');
  const emit = (type: string, data: Record<string, unknown> = {}) =>
    listeners.get(session)!({ type, data: { sessionID: session, ...data } } as SessionEvent);
  emit('session.tool.input.started', { id: 't1', name: 'execute' });
  emit('session.tool.called', { id: 't1', input: { code: 'return tools.knowledge.search({ query: "leave" })' } });
  await until(() => slack.edits.length === 1, 'the first edit lands after the throttle window (2 s)');
  assert.deepEqual(slack.edits, [`${HOME}:1001.0 🔧 searching knowledge "leave"\n… knowledge.search "leave"`]);
  release();
  await until(() => slack.edits.length === 2, 'the placeholder is removed');
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'Answer', threadTs: '30.0' });
  assert.equal(slack.edits[1], `${HOME}:1001.0 deleted`);
  assert.ok(!listeners.has(session), 'the watch is released with the turn');
});

test('the manifest in docs/slack.md carries the shared command table, so the doc and the handlers cannot drift', async () => {
  const doc = await readFile(new URL('../../../docs/slack.md', import.meta.url), 'utf8');
  const block = `  slash_commands:\n${slackManifestCommands()}\noauth_config:`;
  assert.ok(doc.includes(block), `docs/slack.md must contain:\n${block}`);
  assert.match(
    slackManifestCommands('spider'),
    /^ {4}- command: \/spider-new\n {6}description: Start a fresh conversation\n {6}should_escape: false\n/,
  );
  assert.match(slackManifestCommands(), /usage_hint: "\[model\]"/, 'a hint that YAML would read as a list is quoted');
});

test('-steer and -stop act on the running turn; -model is refused while it runs', async t => {
  const store = new Store(':memory:');
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const opencode = await fakeOpenCode(t, 'Answer', () => gate);
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: opencode.url } }),
    path: '/aivi.json',
    projects: [],
    sources: [],
  };
  const slack = fakeConnection();
  const abort = new AbortController();
  const services: HostServices = {
    loaded,
    store,
    knowledge: { search: async () => [], index: async () => ({}), close: async () => {} },
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: abort.signal,
    log: silentLogger,
    channels: new Channels(),
    routes: new PublicRoutes(),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createSlackModule(config, slack.connection).start(services);
  t.after(async () => {
    release();
    await running.stop();
    store.close();
  });
  const inbox = openSlackStore(store, config);
  await slack.event(message({ channel: DM, ts: '40.0', text: 'take your time' }));
  await until(() => opencode.prompts.length === 1 && inbox.sessionOf(DM)?.ready === true, 'the turn is running');
  const session = inbox.sessionOf(DM)!.session;

  await slack.command({ command: '/spider-steer', channel_id: DM, text: 'also the appendix' });
  assert.equal(slack.ephemerals.at(-1), 'Passed on to the agent mid-turn.');
  assert.deepEqual(opencode.prompts.at(-1), {
    id: undefined,
    text: `[Slack message from Me (user ${ME})]\nalso the appendix`,
    delivery: 'steer',
    metadata: { aivi: { origin: 'slack', channel: DM, user: ME, steer: `msg_slack_${DM}_40_0` } },
  });
  assert.equal(inbox.list().length, 1, 'a steer is not a queued turn');

  await slack.command({ command: '/spider-model', channel_id: DM, text: 'github-copilot/gpt-5.2' });
  assert.match(slack.ephemerals.at(-1)!, /^A turn is running in this conversation\./);
  assert.equal(inbox.sessionOf(DM)!.model, null);

  await slack.command({ command: '/spider-stop', channel_id: DM });
  assert.equal(slack.ephemerals.at(-1), 'Stopped.');
  assert.deepEqual(opencode.interrupted, [session]);
  await until(() => slack.posts.length === 1, 'the DM hears it in place of the answer');
  assert.deepEqual(slack.posts[0], { channel: DM, text: 'Stopped at your request.' });
  const [turn] = inbox.list();
  assert.deepEqual([turn!.state, turn!.error], ['discarded', 'Stopped at the person’s request']);
  assert.equal(store.leases().length, 0, 'capacity is released');
  await until(() => slack.reactions.at(-1) === `-eyes@${DM}:40.0`, 'the working reaction is cleared');
  await slack.command({ command: '/spider-stop', channel_id: DM });
  assert.equal(slack.ephemerals.at(-1), 'Nothing is running in this conversation.');
});
