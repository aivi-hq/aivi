import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import type { ChannelPlatform } from '@aivi/plugin/channel';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { ChannelEngine, STOPPED_NOTICE, STOPPED_REASON, splitReply } from '../src/channel/engine.ts';
import { ConversationStore } from '../src/channel/store.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore } from '../src/dispatcher/leases.ts';
import { TurnNotStarted } from '../src/session.ts';
import { Store } from '../src/store.ts';
import { TestCapacity } from './support.ts';

/** Discord's shape, so the ids and tables asserted here are the ones existing databases hold. */
const platform: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
const limits = { pool: 'local-model', maxConcurrent: 1 };
const message = (id: string, channel = 'dm-a') => ({
  id,
  channel,
  user: '10000000000000002',
  name: 'Speaker',
  text: `Question ${id}`,
});
/** The store's candidate and claim, as one step: capacity is the dispatcher's, not here. */
const claimTurn = (store: ConversationStore) => {
  const candidate = store.nextTurn();
  return candidate ? store.claimTurn(candidate.id) : null;
};

test('deduplicated turns retain channel sessions; reset cannot evade pending work', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  assert.equal(store.enqueue(message('one'), 10), true);
  assert.equal(store.enqueue(message('one'), 10), false);
  store.enqueue({ ...message('two'), user: 'second-speaker' }, 10);
  store.enqueue(message('three', 'thread-b'), 10);
  const rows = store.list();
  assert.equal(rows[0]!.session, rows[1]!.session);
  assert.notEqual(rows[0]!.session, rows[2]!.session);
  assert.throws(() => store.reset('dm-a'), /unresolved/);
  const first = claimTurn(store)!;
  store.ready(first.channel);
  store.sent(first.id);
  const second = claimTurn(store)!;
  assert.equal(second.ready, true);
  store.sent(second.id);
  store.reset('dm-a');
  store.enqueue(message('four'), 10);
  assert.notEqual(store.list().at(-1)!.session, first.session);
  assert.equal(store.list()[0]!.text, ''); // delivered payload is not another transcript archive
  // A rebind is refused while work is pending, and otherwise rotates every conversation's session.
  assert.throws(
    () => new ConversationStore(core, platform, 'different-agent'),
    /binding changed while 2 turn\(s\) are pending/,
  );
  for (const pending of store.list().filter(t => t.state === 'queued')) {
    claimTurn(store);
    store.sent(pending.id);
  }
  const before = new Map(store.list().map(t => [t.channel, t.session]));
  const rebound = new ConversationStore(core, platform, 'different-agent');
  assert.equal(rebound.rebound, true);
  rebound.enqueue(message('five', 'dm-a'), 10);
  rebound.enqueue(message('six', 'thread-b'), 10);
  for (const turn of rebound.list().filter(t => ['five', 'six'].includes(t.id))) {
    assert.notEqual(turn.session, before.get(turn.channel), `${turn.channel} starts a fresh session`);
    assert.equal(turn.ready, false);
  }
  assert.equal(
    new ConversationStore(core, platform, 'different-agent').rebound,
    false,
    'same binding again is not a rebind',
  );
});

test('the tables and ids follow the module id, so a second platform never collides with the first', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const slack = new ConversationStore(core, { id: 'slack', label: 'Slack', replyLimit: 3900 }, 'binding');
  const discord = new ConversationStore(core, platform, 'binding');
  slack.enqueue(message('C1:1.0', 'C1'), 10);
  discord.enqueue(message('one', 'C1'), 10);
  assert.match(slack.list()[0]!.session, /^ses_slack_/);
  assert.match(discord.list()[0]!.session, /^ses_discord_/);
  assert.equal(slack.list().length, 1);
  assert.equal(slack.channelOf(discord.list()[0]!.session), null);
  claimTurn(slack);
  claimTurn(discord);
  assert.throws(() => slack.enqueue(message('C1:2.0', 'C1'), 1), /The Slack queue is full/);
});

test('a platform id that is not a bare SQL identifier still gets its tables', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  // An adapter's platform id is its author's string, and a third-party package
  // bringing a dashed one would otherwise die at its first CREATE: SQL reads
  // `tracker-linear_turns` unquoted as `tracker` minus `linear_turns`. The
  // first-party ids are bare words, so this renames nothing that exists — it is
  // the module's first CREATE meeting a real SQLite, with the name quoted.
  const dashed: ChannelPlatform = { id: 'tracker-linear', label: 'Linear', replyLimit: 60_000, effects: 'work' };
  const store = new ConversationStore(core, dashed, 'binding');
  store.enqueue(message('one', 'ENG-1'), 10);
  assert.match(store.list()[0]!.session, /^ses_tracker-linear_/, 'the session id carries the id as written');
  const claimed = claimTurn(store);
  assert.equal(claimed!.id, 'one');
  // The index names carry the id as well, and they are the ones that died first.
  assert.deepEqual(
    core.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'tracker-linear%' ORDER BY name")
      .all()
      .map(row => row.name),
    ['tracker-linear_pending', 'tracker-linear_session_lookup'],
  );
});

test('a channel turn and a job run draw from the same pool: one slot, the second waits', async t => {
  // The real dispatcher, the real tables: capacity left the store's ledger and
  // lives only here, so both services share the same slot through it.
  const core = new Store(':memory:');
  t.after(() => core.close());
  const sessions = new Map<string, { agent: string; directory: string }>();
  const client = {
    agent: { list: async () => ({ data: [] }) },
    session: {
      create: async (body: { id: string; agent: string; location: { directory: string } }) => {
        sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`session ${sessionID} not found`);
        return { agent: session.agent, location: { directory: session.directory } };
      },
      active: async () => ({}),
      interrupt: async () => {},
    },
  } as unknown as OpenCodeClient;
  const dispatcher = new Dispatcher({
    leases: new LeaseStore(core),
    dispatcher: configSchema.parse({
      version: 1,
      dispatcher: { pools: { 'local-model': { capacity: 1 } } },
    }).dispatcher,
    opencode: async () => client,
    idleMs: 600_000,
    prepareMs: 600_000,
    signal: AbortSignal.timeout(900),
  });
  const served: string[] = [];
  dispatcher.registerCallback('discord', requestId => served.push(requestId));
  const jobRun = dispatcher.request({ service: 'jobs', pool: 'local-model' });
  assert.ok('lease' in jobRun);
  const turnAsk = dispatcher.request({ service: 'discord', pool: 'local-model' });
  assert.ok('queued' in turnAsk, 'the pool is full: the turn waits in its queue place');
  const again = dispatcher.request({ service: 'discord', pool: 'local-model' });
  assert.ok('refused' in again && again.refused === 'waiting', 'one queue place per service and pool');
  const ended = await dispatcher.release(jobRun.lease.id);
  assert.ok('ended' in ended);
  assert.deepEqual(served, [turnAsk.queued], 'the waiting turn is handed the freed slot');
  assert.equal(dispatcher.held(), 1, 'the turn works inside it now');
});

test('restart discards interrupted turns, reports who to tell; queued work survives', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one'), 10);
  store.enqueue(message('two'), 10);
  store.enqueue(message('three', 'dm-b'), 10);
  claimTurn(store);
  const second = claimTurn(store)!;
  store.result(second.id, 'half sent');
  assert.deepEqual(store.recover(), [
    { id: 'one', channel: 'dm-a', state: 'running' },
    { id: 'three', channel: 'dm-b', state: 'replying' },
  ]);
  assert.equal(store.list()[0]!.state, 'discarded');
  assert.equal(store.list()[0]!.error, 'Interrupted by a restart');
  assert.equal(store.list()[1]!.state, 'queued', 'the next message in the conversation is untouched');
  assert.equal(store.list()[2]!.state, 'discarded');
  assert.ok(claimTurn(store), 'the queued message can start at once');
  assert.throws(() => store.resolve('two', 'Not blocked'), /Only a blocked/);
  assert.equal(store.list('dm-a').length, 2);
  assert.equal(store.list('other').length, 0);
});

test('turns queue behind a slow answer; a delivery failure fails the turn (its answer stays recorded), never resends, never blocks a chat', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one'), 10);
  store.enqueue(message('two'), 10);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  let asks = 0;
  const sends: string[] = [];
  const capacity = new TestCapacity(1);
  const engine = new ChannelEngine(
    store,
    limits,
    capacity,
    async () => {
      asks++;
      await pending;
      return 'Answer';
    },
    {
      async send(_channel, text) {
        // Fail only on the answer itself; the failure notice is allowed through.
        if (text === 'Answer') {
          sends.push(text);
          throw new Error('Ambiguous Discord response');
        }
        sends.push(text);
        return undefined;
      },
    },
  );
  engine.tick();
  await Promise.resolve();
  engine.tick();
  assert.equal(asks, 1);
  assert.equal(capacity.heldCount(), 1, 'one slot held by the running turn');
  release();
  await engine.drain();
  engine.tick();
  await engine.drain();
  // Both turns ran; each answer's send threw once and was never retried; each person got the
  // failure notice; both turns failed with their slots paid back. No resend, no block.
  assert.equal(sends.filter(x => x === 'Answer').length, 2, 'each answer was attempted exactly once');
  assert.equal(sends.filter(x => x.startsWith('Something went wrong')).length, 2, 'each person was told');
  assert.deepEqual(
    store.list().map(x => x.state),
    ['discarded', 'discarded'],
  );
  assert.deepEqual(
    store.list().map(x => x.result),
    ['Answer', 'Answer'],
  );
  assert.equal(capacity.heldCount(), 0, 'failed chat turns hold no capacity');
});

test('a chat turn that never reached the agent, and one lost after its prompt, both fail with capacity released; only workers block', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one', 'dm-a'), 10);
  store.enqueue(message('two', 'dm-b'), 10);
  const sent: string[] = [];
  const capacity = new TestCapacity(2);
  const engine = new ChannelEngine(
    store,
    { ...limits, maxConcurrent: 2 },
    capacity,
    async turn => {
      if (turn.id === 'one') throw new TurnNotStarted(new Error('No running OpenCode v2 service found'));
      throw new Error('lost after prompt');
    },
    { send: async (_channel, text) => void sent.push(text) },
  );
  engine.tick();
  await engine.drain();
  const [one, two] = store.list();
  assert.equal(one!.state, 'discarded');
  assert.match(one!.error ?? '', /^Not started/);
  assert.equal(two!.state, 'discarded', 'a post-prompt error is a known end for a chat, not a block');
  assert.match(two!.error ?? '', /lost after prompt/);
  assert.equal(capacity.heldCount(), 0, 'neither holds capacity');
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /send that again/);
  assert.match(sent[1]!, /Something went wrong \(lost after prompt\)/);
});

test('shutdown discards the running turn instead of blocking it, warns queued conversations, and leaves no lease behind', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one', 'dm-a'), 10);
  store.enqueue(message('two', 'dm-b'), 10);
  store.enqueue(message('three', 'dm-b'), 10);
  const sent: [string, string][] = [];
  const capacity = new TestCapacity(1);
  const engine = new ChannelEngine(
    store,
    limits, // one at a time: `one` runs, `two` and `three` wait
    capacity,
    (_turn, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    { send: async (channel, text) => void sent.push([channel, text]) },
  );
  engine.tick();
  await Promise.resolve();
  await engine.shutdown();
  const [one, two, three] = store.list();
  assert.equal(
    one!.state,
    'discarded',
    'a shutdown is a restart from the turn’s point of view: discarded, not blocked',
  );
  assert.match(one!.error ?? '', /shutdown/);
  assert.equal(two!.state, 'queued');
  assert.equal(three!.state, 'queued');
  assert.equal(capacity.granted.size, 0, 'nothing waits for an operator');
  assert.deepEqual(
    sent.map(([channel]) => channel).sort(),
    ['dm-a', 'dm-b'],
    'the interrupted conversation and each waiting conversation hear about it once',
  );
  assert.match(sent.find(([c]) => c === 'dm-a')![1], /going offline .* send it again/);
  assert.match(sent.find(([c]) => c === 'dm-b')![1], /stays queued/);
  assert.deepEqual(store.recover(), [], 'nothing left for restart recovery to announce a second time');
});

test('/stop aborts one conversation’s running turn: discarded as stopped, slot paid back, the person told; queued messages follow', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one', 'dm-a'), 10);
  store.enqueue(message('two', 'dm-a'), 10);
  store.enqueue(message('three', 'dm-b'), 10);
  const sent: [string, string][] = [];
  const asked: string[] = [];
  const capacity = new TestCapacity(2);
  const engine = new ChannelEngine(
    store,
    { ...limits, maxConcurrent: 2 },
    capacity,
    (turn, signal) =>
      new Promise<string>((resolve, reject) => {
        asked.push(turn.id);
        if (turn.id === 'two') return resolve('Answer two');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    { send: async (channel, text) => void sent.push([channel, text]) },
  );
  engine.tick();
  await Promise.resolve();
  assert.deepEqual(asked, ['one', 'three']);
  assert.equal(store.running('dm-a')?.id, 'one');
  assert.equal(store.running('dm-c'), null);
  assert.equal(engine.stopTurn('dm-c'), null, 'nothing running there');
  assert.equal(engine.stopTurn('dm-a')?.id, 'one');
  assert.equal(engine.stopTurn('dm-a'), null, 'a stop is idempotent');
  await new Promise(resolve => setTimeout(resolve, 20));
  const one = store.list().find(t => t.id === 'one')!;
  assert.equal(one.state, 'discarded', 'stopped by the person: discarded like a shutdown, not blocked');
  assert.equal(one.error, STOPPED_REASON);
  assert.deepEqual(sent[0], ['dm-a', STOPPED_NOTICE]);
  assert.deepEqual(asked, ['one', 'three', 'two'], 'the next message in that conversation starts at once');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.list().find(t => t.id === 'two')!.state, 'sent');
  assert.equal(store.list().find(t => t.id === 'three')!.state, 'running', 'the other conversation is untouched');
  assert.equal(capacity.heldCount(), 1, 'only the still-running turn holds a slot');
  assert.equal(engine.stopped, false, 'a per-turn stop is not the engine’s stop');
  engine.stop();
  await engine.drain();
  assert.match(sent.find(([c]) => c === 'dm-b')![1], /going offline/, 'a shutdown still reads as one');
});

test('a waiting turn takes its slot from the queue place: the grant arrives through the callback and starts the turn', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one', 'dm-a'), 10);
  store.enqueue(message('two', 'dm-b'), 10);
  const asked: string[] = [];
  const capacity = new TestCapacity(1);
  const engine = new ChannelEngine(
    store,
    { ...limits, maxConcurrent: 2 }, // two at a time by module; the pool says one
    capacity,
    async turn => {
      asked.push(turn.id);
      return `Answer ${turn.id}`;
    },
    { send: async (_channel, _text) => undefined },
  );
  engine.tick();
  assert.equal(store.state('two'), 'queued', 'the waiting turn is not claimed before its slot arrives');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(asked, ['one', 'two'], 'the freed slot walked the queue place to the waiting turn');
  assert.equal(store.state('two'), 'sent');
  assert.equal(capacity.heldCount(), 0, 'and both slots were paid back');
  await engine.drain();
});

test('a conversation’s model pin lives on its session row: read by every turn, cleared by /new, a rebind and a fresh adoption', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  assert.equal(store.sessionOf('dm-a'), null);
  store.setModel('dm-a', { providerID: 'openai', modelID: 'gpt-5.2', variant: 'high' });
  assert.deepEqual(store.sessionOf('dm-a')?.model, { providerID: 'openai', modelID: 'gpt-5.2', variant: 'high' });
  assert.equal(store.sessionOf('dm-a')?.ready, false, 'pinning before the first message creates the binding');
  store.enqueue(message('one'), 10);
  const one = claimTurn(store)!;
  assert.deepEqual(one.model, { providerID: 'openai', modelID: 'gpt-5.2', variant: 'high' });
  store.ready('dm-a');
  store.sent('one');
  store.setModel('dm-a', { providerID: 'anthropic', modelID: 'claude' });
  store.enqueue(message('two'), 10);
  assert.deepEqual(claimTurn(store)!.model, { providerID: 'anthropic', modelID: 'claude' });
  store.sent('two');
  store.setModel('dm-a', null);
  assert.equal(store.sessionOf('dm-a')?.model, null, 'null returns to the agent’s default');
  store.setModel('dm-a', { providerID: 'anthropic', modelID: 'claude' });
  store.reset('dm-a');
  assert.equal(store.sessionOf('dm-a')?.model, null, '/new clears the pin');
  store.setModel('dm-a', { providerID: 'anthropic', modelID: 'claude' });
  const rebound = new ConversationStore(core, platform, 'other-binding');
  assert.equal(rebound.sessionOf('dm-a')?.model, null, 'a rebind clears the pin');
  rebound.adopt('thread', { session: 'ses_aivi_job1', agent: 'coder', directory: '/other' });
  assert.equal(rebound.sessionOf('thread')?.model, null, 'an adopted session runs its own model');
  // A database from before the column has it added; existing rows read as unpinned.
  assert.equal(
    (core.db.prepare("SELECT count(*) AS n FROM pragma_table_info('discord_sessions') WHERE name='model'").get() as any)
      .n,
    1,
  );
});

test('reply splitting preserves Unicode and respects the platform UTF-16 message limit', () => {
  const text = `${'a'.repeat(1899)}${'🦊'.repeat(1000)}\nlast`;
  const chunks = splitReply(text, platform.replyLimit);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(c => c.length <= 1900 && c.isWellFormed()));
  assert.equal(splitReply(text, 3900).length, 2);
  assert.throws(() => splitReply(text, 1), /surrogate/);
});

test('a job result re-enters the thread bound to its session as a turn of kind job, in order with messages', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one', 'thread-a'), 10);
  const session = store.list()[0]!.session;
  assert.equal(store.channelOf(session), 'thread-a');
  assert.equal(store.channelOf('ses_unknown'), null);
  assert.throws(() => store.enqueueJobResult('j1', 'ses_unknown', 'text', 10), /No Discord conversation/);
  assert.equal(store.enqueueJobResult('j1', session, '✅ done', 10), true);
  assert.equal(store.enqueueJobResult('j1', session, '✅ done', 10), false, 'one turn per job outcome');
  const turns = store.list('thread-a');
  assert.deepEqual(
    turns.map(x => [x.id, x.kind, x.user]),
    [
      ['one', 'message', '10000000000000002'],
      ['run:j1', 'job', 'aivi'],
    ],
  );
  const first = claimTurn(store)!;
  assert.equal(first.id, 'one', 'the person’s message goes first');
  assert.equal(claimTurn(store), null, 'one turn per thread at a time');
  store.ready(first.channel);
  store.sent(first.id);
  const result = claimTurn(store)!;
  assert.equal(result.kind, 'job');
  assert.equal(result.session, session, 'the result continues the same session');
});

test('a report thread adopts the job session (agent jobs) or seeds a fresh one (script jobs); /new and rebinds undo it', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.adopt('thread-agent', { session: 'ses_aivi_job1', agent: 'coder', directory: '/other' });
  store.adopt('thread-script', { seed: 'exit 0\nremoved 3 logs' });
  assert.throws(() => store.adopt('thread-agent', { seed: 'x' }), /already has a session/);
  assert.equal(store.channelOf('ses_aivi_job1'), 'thread-agent', 'a job result may re-enter the adopted thread');
  assert.equal(store.has('thread-agent'), true, 'the thread counts as a known conversation for access rules');

  store.enqueue(message('reply-a', 'thread-agent'), 10);
  store.enqueue(message('reply-s', 'thread-script'), 10);
  const a = claimTurn(store)!;
  assert.deepEqual(
    [a.session, a.ready, a.agent, a.directory, a.seed],
    ['ses_aivi_job1', true, 'coder', '/other', null],
  );
  store.sent(a.id);
  const s = claimTurn(store)!;
  assert.deepEqual([s.ready, s.agent, s.seed], [false, null, 'exit 0\nremoved 3 logs']);
  assert.match(s.session, /^ses_discord_/);
  store.ready(s.channel);
  store.sent(s.id);
  assert.equal(store.list('thread-script')[0]!.seed, null, 'the seed is consumed by the first turn');

  store.reset('thread-agent');
  store.enqueue(message('fresh', 'thread-agent'), 10);
  const fresh = store.list('thread-agent').at(-1)!;
  assert.deepEqual(
    [fresh.agent, fresh.directory, fresh.ready],
    [null, null, false],
    '/new returns to the module agent',
  );
  assert.notEqual(fresh.session, 'ses_aivi_job1');
});

test('bound workers: one turn per issue across conversations; a blocked worker keeps the issue; restart blocks instead of discarding', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const workers: ChannelPlatform = { id: 'linear', label: 'Linear', replyLimit: 60_000, effects: 'work' };
  const store = new ConversationStore(core, workers, 'binding');
  const bind = (channel: string, project: string, issue: string | null) =>
    store.bind(channel, {
      agent: 'developer',
      directory: `/home/projects/${project}/worktrees/${channel}`,
      project,
      issue,
    });
  bind('as-1', 'website', 'ENG-1');
  bind('as-2', 'website', 'ENG-2');
  bind('as-3', 'api', 'API-1');
  bind('as-4', 'api', 'API-1');
  bind('as-5', 'website', null);
  assert.throws(() => bind('as-1', 'website', 'ENG-1'), /already has a session/);
  for (const channel of ['as-1', 'as-2', 'as-3', 'as-4', 'as-5']) store.enqueue(message(`m-${channel}`, channel), 10);

  const first = claimTurn(store)!;
  assert.equal(first.channel, 'as-1');
  assert.deepEqual([first.project, first.issue, first.agent], ['website', 'ENG-1', 'developer']);
  assert.equal(
    store.waitingOn('as-2'),
    null,
    'a different issue in the same project no longer waits: worktrees isolate them',
  );
  const second = claimTurn(store)!;
  assert.equal(second.channel, 'as-2', 'ENG-2 runs beside ENG-1');
  const third = claimTurn(store)!;
  assert.equal(third.channel, 'as-3');
  const assistant = claimTurn(store)!;
  assert.equal(assistant.channel, 'as-5', 'a conversation with no issue (the assistant) never waits');
  assert.deepEqual([assistant.project, assistant.issue, assistant.agent], ['website', null, 'developer']);
  assert.equal(claimTurn(store), null, 'as-4 waits: same issue as as-3');
  assert.deepEqual(store.waitingOn('as-4'), { channel: 'as-3', issue: 'API-1' });

  store.block(third.id);
  assert.equal(claimTurn(store), null, 'a blocked worker holds the issue');
  store.resolve(third.id, 'Inspected; the worker had stopped');
  const fourth = claimTurn(store)!;
  assert.equal(fourth.channel, 'as-4', 'released by resolve');

  // A restart with a worker mid-turn: nobody knows whether it stopped, so it is blocked, not discarded.
  assert.deepEqual(
    store.recover().map(r => [r.id, r.state]),
    [
      ['m-as-1', 'running'],
      ['m-as-2', 'running'],
      ['m-as-4', 'running'],
      ['m-as-5', 'running'],
    ],
  );
  assert.equal(store.state('m-as-1'), 'blocked');
  assert.match(store.list('as-1')[0]!.error!, /restart while working/);
  assert.equal(store.sessionOf('as-3')!.project, 'api');
});
