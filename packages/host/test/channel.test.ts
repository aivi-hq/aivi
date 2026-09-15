import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import type { ChannelPlatform } from '../src/channel/contract.ts';
import { ChannelEngine, splitReply } from '../src/channel/engine.ts';
import { ConversationStore } from '../src/channel/store.ts';
import { TurnNotStarted } from '../src/session.ts';
import { Store } from '../src/store.ts';

/** Discord's shape, so the ids and tables asserted here are the ones existing databases hold. */
const platform: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
const limits = { resource: 'local-model', maxConcurrent: 1, turnTimeoutMs: 300_000 };
const scheduler = configSchema.parse({ version: 1 }).scheduler;
const message = (id: string, channel = 'dm-a') => ({
  id,
  channel,
  user: '10000000000000002',
  name: 'Speaker',
  text: `Question ${id}`,
});

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
  const first = store.claim(scheduler, limits.resource)!;
  store.ready(first.channel);
  store.sent(first.id);
  const second = store.claim(scheduler, limits.resource)!;
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
    store.claim(scheduler, limits.resource);
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
  slack.claim({ ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } }, 'local-model');
  discord.claim({ ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } }, 'local-model');
  assert.deepEqual(
    core
      .leases()
      .map(l => [l.id, l.owner])
      .sort(),
    [
      ['discord:one', 'discord'],
      ['slack:C1:1.0', 'slack'],
    ],
  );
  assert.throws(() => slack.enqueue(message('C1:2.0', 'C1'), 1), /The Slack queue is full/);
});

test('conversation leases and scheduler claims enforce the same global capacity', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  core.enqueue({ kind: 'system.check' }, 'local-model', 'scheduled');
  const job = core.claim('host', 1, scheduler.resources)!;
  store.enqueue(message('one'), 10);
  assert.equal(store.claim(scheduler, limits.resource), null);
  core.finish(job.id, 'host', 'succeeded', {}, 'done');
  const turn = store.claim(scheduler, limits.resource)!;
  core.enqueue({ kind: 'system.check' }, 'local-model', 'next');
  assert.equal(core.claim('host', 1, scheduler.resources), null);
  store.block(turn.id);
  assert.equal(core.claim('host', 1, scheduler.resources), null);
  store.resolve(turn.id, 'Inspected native session; all work stopped');
  assert.ok(core.claim('host', 1, scheduler.resources));
});

test('restart discards interrupted turns, releases their capacity, reports who to tell; queued work survives', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one'), 10);
  store.enqueue(message('two'), 10);
  store.enqueue(message('three', 'dm-b'), 10);
  store.claim(scheduler, limits.resource);
  const second = store.claim({ ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } }, limits.resource)!;
  store.result(second.id, 'half sent');
  assert.deepEqual(store.recover(), [
    { id: 'one', channel: 'dm-a', state: 'running' },
    { id: 'three', channel: 'dm-b', state: 'replying' },
  ]);
  assert.equal(store.list()[0]!.state, 'discarded');
  assert.equal(store.list()[0]!.error, 'Interrupted by a restart');
  assert.equal(store.list()[1]!.state, 'queued', 'the next message in the conversation is untouched');
  assert.equal(store.list()[2]!.state, 'discarded');
  assert.equal(core.leases().length, 0, 'interrupted turns hold no capacity');
  assert.ok(store.claim(scheduler, limits.resource), 'the queued message can start at once');
  assert.equal(store.claim(scheduler, limits.resource), null, 'capacity is one');
  assert.throws(() => store.resolve('two', 'Not blocked'), /Only a blocked/);
  assert.equal(store.list('dm-a').length, 2);
  assert.equal(store.list('other').length, 0);
});

test('failed inbox transition rolls back the capacity reservation', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  assert.throws(
    () =>
      core.acquireLease('one', 'discord', 'local-model', 1, scheduler.resources, () => {
        throw new Error('disk failure');
      }),
    /disk failure/,
  );
  assert.equal(core.leases().length, 0);
});

test('turns queue behind a slow answer; delivery failures retain results and never auto-resend', async t => {
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
  const engine = new ChannelEngine(
    store,
    limits,
    scheduler,
    async () => {
      asks++;
      await pending;
      return 'Answer';
    },
    {
      async send(_channel, text) {
        sends.push(text);
        throw new Error('Ambiguous Discord response');
      },
    },
  );
  engine.tick();
  await Promise.resolve();
  engine.tick();
  assert.equal(asks, 1);
  release();
  await engine.drain();
  engine.tick();
  await engine.drain();
  assert.equal(sends.filter(s => s === 'Answer').length, 1, 'the answer is delivered once and never resent');
  assert.match(sends[1]!, /operator has been notified/, 'the person is told, even if that send fails too');
  assert.equal(store.list()[0]!.result, 'Answer');
  assert.equal(store.list()[0]!.state, 'blocked');
  assert.equal(store.list()[1]!.state, 'queued');
  assert.equal(core.leases().length, 1);
});

test('a turn that never reached the agent is discarded with its capacity released; a blocked one keeps it; both tell the user', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  store.enqueue(message('one', 'dm-a'), 10);
  store.enqueue(message('two', 'dm-b'), 10);
  const sent: string[] = [];
  const engine = new ChannelEngine(
    store,
    { ...limits, maxConcurrent: 2 },
    { ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } },
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
  assert.equal(two!.state, 'blocked');
  assert.deepEqual(
    core.leases().map(l => l.id),
    ['discord:two'],
    'only the blocked turn still holds capacity',
  );
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /send that again/);
  assert.match(sent[1]!, /operator has been notified/);
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
  const first = store.claim(scheduler, limits.resource)!;
  assert.equal(first.id, 'one', 'the person’s message goes first');
  assert.equal(store.claim(scheduler, limits.resource), null, 'one turn per thread at a time');
  store.ready(first.channel);
  store.sent(first.id);
  const result = store.claim(scheduler, limits.resource)!;
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
  const a = store.claim({ ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } }, limits.resource)!;
  assert.deepEqual(
    [a.session, a.ready, a.agent, a.directory, a.seed],
    ['ses_aivi_job1', true, 'coder', '/other', null],
  );
  store.sent(a.id);
  const s = store.claim(scheduler, limits.resource)!;
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
