import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { KnowledgeService, Person, Run } from '@aivi/core';
import { configSchema, getLogger, slackConfigSchema } from '@aivi/core';
import type { HostServices, SessionEvent, SessionEventListener, SessionEvents } from '@aivi/host';
import { CHAT_COMMANDS, Channels, connectOpenCode, PublicRoutes, Store, TaskRegistry, usageHint } from '@aivi/host';
import type { SlackCommand, SlackConnection, SlackEvent, SlackHandlers } from '../src/connection.ts';
import type { Routed, UnlinkedSender } from '../src/module.ts';
import {
  conversationParts,
  createSlackModule,
  openSlackStore,
  routeMessage,
  SLACK,
  slackManifest,
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
    channels: [{ id: HOME }, { id: TEAM, trigger: 'any', sessions: 'channel' }],
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
  assert.throws(
    () => slackConfigSchema.parse({ access: { dm: { users: ['U0000000001'] } } }),
    /Unrecognized/,
    'the old DM allow-list is gone, not ignored',
  );
  assert.throws(() => slackConfigSchema.parse({ access: { channels: [{ id: 'general' }] } }), /channel id/);
  assert.throws(() => slackConfigSchema.parse({ access: {}, reportChannels: [DM] }), /channel id/);
  assert.throws(() => slackConfigSchema.parse({ access: {}, commandPrefix: 'Spider Bot' }), /commandPrefix/);
  assert.deepEqual(SLACK, { id: 'slack', label: 'Slack', replyLimit: 3900 });
  assert.deepEqual(conversationParts(`${HOME}:1.5`), { channel: HOME, threadTs: '1.5' });
  assert.deepEqual(conversationParts(DM), { channel: DM });
});

test('routing: DMs, mentions opening threads, threads aivi is in, channel mode, and what is ignored', () => {
  const known = (c: string) => c === `${HOME}:100.1`;
  const link = (user: string) => user === ME;
  // Narrowing for sites where only a routed message makes sense; a stranger or silence is a failure.
  const routed = (r: Routed | UnlinkedSender | null): Routed => {
    assert.ok(r && !('unlinked' in r));
    return r;
  };
  const dm = routed(routeMessage(config, BOT, message({ channel: DM, ts: '1.0' }), known, link));
  assert.deepEqual([dm.conversation, dm.route.isDM, dm.text], [DM, true, 'hello']);
  assert.deepEqual(
    routeMessage(config, BOT, message({ channel: DM, ts: '1.0', user: 'U0000000BAD' }), known, link),
    { unlinked: true, isDM: true },
    'a stranger in a DM is the one silence worth explaining',
  );
  assert.equal(routeMessage(config, BOT, message({ channel: DM, ts: '1.0', bot_id: 'B1' }), known, link), null, 'bots');
  assert.equal(routeMessage(config, BOT, message({ channel: DM, ts: '1.0', user: BOT }), known, link), null, 'itself');
  assert.equal(
    routeMessage(config, BOT, message({ channel: DM, ts: '1.0', subtype: 'message_changed' }), known, link),
    null,
    'edits and other subtypes',
  );
  assert.equal(routeMessage(config, BOT, message({ channel: HOME, ts: '2.0' }), known, link), null, 'needs a mention');
  const opened = routed(
    routeMessage(config, BOT, message({ channel: HOME, ts: '2.0', text: `<@${BOT}> hi there` }), known, link),
  );
  assert.deepEqual([opened.conversation, opened.route.parentId, opened.text], [`${HOME}:2.0`, null, 'hi there']);
  const viaEvent = routed(
    routeMessage(config, BOT, message({ type: 'app_mention', channel: HOME, ts: '2.0', text: 'x' }), known, link),
  );
  assert.equal(viaEvent.conversation, `${HOME}:2.0`, 'an app_mention event is a mention even without the tag');
  const inThread = routed(
    routeMessage(config, BOT, message({ channel: HOME, ts: '3.0', thread_ts: '100.1' }), known, link),
  );
  assert.deepEqual(
    [inThread.conversation, inThread.route.parentId, inThread.route.knownConversation],
    [`${HOME}:100.1`, HOME, true],
  );
  assert.equal(
    routeMessage(config, BOT, message({ channel: HOME, ts: '3.0', thread_ts: '200.1' }), known, link),
    null,
    'a thread aivi is not part of still needs a mention',
  );
  const onlyMention = routed(
    routeMessage(config, BOT, message({ channel: HOME, ts: '4.0', text: `<@${BOT}>` }), known, link),
  );
  assert.equal(onlyMention.text, `<@${BOT}>`, 'a bare mention keeps its text so the empty check can reply');
  const team = routed(routeMessage(config, BOT, message({ channel: TEAM, ts: '5.0' }), known, link));
  assert.equal(team.conversation, TEAM, 'channel mode: the channel is the conversation');
  assert.equal(routeMessage(config, BOT, message({ channel: TEAM, ts: '5.1', thread_ts: '5.0' }), known, link), null);
  assert.deepEqual(
    routeMessage(config, BOT, message({ channel: TEAM, ts: '5.0', user: 'U0000000BAD' }), known, link),
    { unlinked: true, isDM: false },
    'strangers are heard nowhere, linked persons everywhere',
  );
  assert.equal(
    routeMessage(config, BOT, message({ channel: 'C0000000009', ts: '6.0', text: `<@${BOT}>` }), known, link),
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
  // A failing test body can leave the gated /wait request open; tearing the sockets down
  // first lets close (and the hooks after it) finish instead of deadlocking on the gate.
  t.after(() => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  });
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
/** Link ME into a fresh store the way a real person does: mint a code, redeem it. */
function linkMe(store: Store): Person {
  const person = store.createPerson({ name: 'Ada' });
  store.redeemLinkCode(store.mintLinkCode(person.id).code, 'slack', ME);
  return person;
}
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};

test('the module: a mention opens a thread and is answered there once; duplicates, files, reports, re-entry, commands', async t => {
  const store = new Store(':memory:');
  linkMe(store);
  const opencode = await fakeOpenCode(t, 'Answer');
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: opencode.url } }),
    path: '/config.json',
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
    log: getLogger(['aivi']),
    channels,
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
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
  assert.equal(
    opencode.prompts[0]!.text,
    `[Slack message from Ada (user ${ME})]\nwhat is aivi?`,
    'a linked account speaks as its person',
  );
  assert.deepEqual(opencode.sessions.get(first!.session), { agent: 'librarian', directory: '/librarian' });

  // A follow-up inside that thread needs no mention; a file-only message gets the text-only reply in the thread.
  await slack.event(message({ channel: HOME, ts: '11.0', thread_ts: '10.0', text: 'more' }));
  await until(() => slack.posts.length === 2, 'thread reply');
  assert.deepEqual(slack.posts[1], { channel: HOME, text: 'Answer', threadTs: '10.0' });
  await slack.event(message({ channel: HOME, ts: '12.0', thread_ts: '10.0', text: '', files: [{}] }));
  assert.equal(slack.posts.at(-1)!.text, 'Text messages only for now; paste the relevant text.');
  assert.equal(slack.posts.at(-1)!.threadTs, '10.0');
  assert.equal(inbox.list().length, 2);
  // Un-mentioned top-level messages never reach the inbox; a stranger's DM gets one link hint and nothing else.
  await slack.event(message({ channel: HOME, ts: '13.0', text: 'unaddressed' }));
  const before = slack.posts.length;
  await slack.event(message({ channel: DM, ts: '14.0', user: 'U0000000BAD' }));
  assert.match(slack.posts.at(-1)!.text, /aivi link slack/, 'the stranger gets one link hint');
  assert.equal(slack.posts.at(-1)!.channel, DM, 'the hint stays in the DM');
  await slack.event(message({ channel: DM, ts: '14.5', user: 'U0000000BAD' }));
  assert.equal(slack.posts.length, before + 1, 'the hint is said once per account');
  assert.equal(inbox.list().length, 2);

  // A report opens a thread that adopts the job session; a reply there continues it with that job's agent.
  const run: Run = {
    id: 'run-1',
    jobId: 'job-1',
    task: {
      kind: 'prompt',
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
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'x'.repeat(100), threadTs: '1005.0' });
  assert.equal(channels.ownerOf('ses_aivi_job1'), 'slack');
  await slack.event(message({ channel: HOME, ts: '15.0', thread_ts: '1005.0', text: 'what did you do?' }));
  await until(() => slack.posts.length === 7, 'answered in the report thread');
  assert.equal(opencode.prompts.at(-1)!.metadata.aivi.channel, `${HOME}:1005.0`);
  assert.equal(inbox.list().at(-1)!.session, 'ses_aivi_job1');
  // A job result addressed to that session re-enters the thread as a job turn.
  await channels.deliver({ to: 'session', session: 'ses_aivi_job1', on: 'always' }, '✅ done', {
    run,
    state: 'succeeded',
  });
  await until(() => slack.posts.length === 8, 'the outcome is relayed in the thread');
  assert.equal(inbox.list().at(-1)!.kind, 'job');
  assert.match(opencode.prompts.at(-1)!.text, /^\[aivi delivers the outcome/);
  assert.equal(opencode.prompts.at(-1)!.id, 'msg_slack_run_run_1');
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'Answer', threadTs: '1005.0' });

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
  assert.match(slack.ephemerals.at(-1)!, /aivi link slack/, 'an unlinked DM is told the way in');
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
  await until(() => slack.posts.length === 9, 'answered in the DM');
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
  linkMe(store);
  const woken = new Set<() => void>();
  const loaded = { config: configSchema.parse({ version: 1 }), path: '/config.json', projects: [], sources: [] };
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
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
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
  store.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', 'busy');
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

test('progress: the placeholder goes into the thread, stays quiet inside its window, and goes when the answer lands', async t => {
  const store = new Store(':memory:');
  linkMe(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const opencode = await fakeOpenCode(t, 'Answer', () => gate);
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: opencode.url } }),
    path: '/config.json',
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
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
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
  // The burst lands in the window the placeholder just opened, so nothing is edited yet. What one
  // edit says, and that it lands when the window closes, is the host's own progress test — it runs
  // this reporter on a 100 ms window, which is the honest way to watch a 2 s throttle.
  assert.equal(slack.edits.length, 0, 'the window stays quiet');
  release();
  await until(() => slack.edits.length === 1, 'the placeholder is removed');
  assert.deepEqual(slack.posts.at(-1), { channel: HOME, text: 'Answer', threadTs: '30.0' });
  assert.equal(slack.edits[0], `${HOME}:1001.0 deleted`);
  assert.ok(!listeners.has(session), 'the watch is released with the turn');
});

test('progress when the turn cannot run: the notice edits the placeholder instead of posting beside it', async t => {
  const store = new Store(':memory:');
  linkMe(store);
  const loaded = { config: configSchema.parse({ version: 1 }), path: '/config.json', projects: [], sources: [] };
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
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createSlackModule({ ...config, progress: 'status' }, slack.connection).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  await slack.event(message({ type: 'app_mention', channel: HOME, ts: '31.0', text: `<@${BOT}> are you there` }));
  // Slack's delivery has no notice of its own, so the failure becomes the placeholder through
  // chat.update: one message in the thread, not a placeholder left behind beside the bad news.
  await until(() => slack.edits.length === 1, 'the notice is an edit of the placeholder');
  assert.deepEqual(slack.posts, [{ channel: HOME, text: '⏳ thinking…', threadTs: '31.0' }]);
  assert.equal(
    slack.edits[0],
    `${HOME}:1001.0 I could not reach my agent runtime just now. Please send that again in a moment.`,
  );
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

test('the JSON manifest agrees with the YAML snippet: one command table, two spellings', () => {
  const json = slackManifest('aivi', { name: 'Aivi' }) as {
    display_information: { name: string };
    features: {
      bot_user: { display_name: string };
      slash_commands: { command: string; description: string; usage_hint?: string; should_escape: boolean }[];
    };
  };
  assert.equal(json.display_information.name, 'Aivi');
  assert.equal(json.features.bot_user.display_name, 'Aivi', 'the bot answers under the persona name');
  const commands = json.features.slash_commands;
  assert.deepEqual(
    commands.map(c => c.command),
    CHAT_COMMANDS.map(c => `/aivi-${c.name}`),
  );
  for (const c of commands) assert.equal(c.should_escape, false);
  // Every field the YAML snippet carries is in the JSON too.
  for (const command of CHAT_COMMANDS) {
    const dumped = commands.find(c => c.command === `/aivi-${command.name}`)!;
    assert.equal(dumped.description, command.description);
    assert.equal(dumped.usage_hint, usageHint(command) || undefined);
  }
});

test('-steer and -stop act on the running turn; -model is refused while it runs', async t => {
  const store = new Store(':memory:');
  const ada = linkMe(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const opencode = await fakeOpenCode(t, 'Answer', () => gate);
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: opencode.url } }),
    path: '/config.json',
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
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
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
    text: `[Slack message from Ada (user ${ME})]\nalso the appendix`,
    delivery: 'steer',
    metadata: {
      aivi: { origin: 'slack', channel: DM, user: ME, steer: `msg_slack_${DM}_40_0`, person: ada.id },
    },
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
