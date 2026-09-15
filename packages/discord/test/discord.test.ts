import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import { Store, TurnNotStarted } from '@aivi/host';
import { authorized, discordConfigSchema } from '../src/config.ts';
import { DiscordEngine, splitReply } from '../src/engine.ts';
import { DiscordStore } from '../src/store.ts';

const config = discordConfigSchema.parse({
  version: 1,
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
const scheduler = configSchema.parse({ version: 1 }).scheduler;
const message = (id: string, channel = 'dm-a') => ({
  id,
  channel,
  user: '10000000000000002',
  name: 'Speaker',
  text: `Question ${id}`,
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
        version: 1,
        applicationId: '10000000000000001',
        directory: '/l',
        access: { channels: [{ id: '10000000000000004' }] },
      }),
    /messageContent/,
  );
  assert.equal(config.access.channels[0]!.trigger, 'mention-to-start', 'natural thread behaviour is the default');
});

test('deduplicated turns retain channel sessions; reset cannot evade pending work', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new DiscordStore(core, 'binding');
  assert.equal(store.enqueue(message('one'), 10), true);
  assert.equal(store.enqueue(message('one'), 10), false);
  store.enqueue({ ...message('two'), user: 'second-speaker' }, 10);
  store.enqueue(message('three', 'thread-b'), 10);
  const rows = store.list();
  assert.equal(rows[0]!.session, rows[1]!.session);
  assert.notEqual(rows[0]!.session, rows[2]!.session);
  assert.throws(() => store.reset('dm-a'), /unresolved/);
  const first = store.claim(scheduler, config.resource)!;
  store.ready(first.channel);
  store.sent(first.id);
  const second = store.claim(scheduler, config.resource)!;
  assert.equal(second.ready, true);
  store.sent(second.id);
  store.reset('dm-a');
  store.enqueue(message('four'), 10);
  assert.notEqual(store.list().at(-1)!.session, first.session);
  assert.equal(store.list()[0]!.text, ''); // delivered payload is not another transcript archive
  // A rebind is refused while work is pending, and otherwise rotates every conversation's session.
  assert.throws(() => new DiscordStore(core, 'different-agent'), /binding changed while 2 turn\(s\) are pending/);
  for (const pending of store.list().filter(t => t.state === 'queued')) {
    store.claim(scheduler, config.resource);
    store.sent(pending.id);
  }
  const before = new Map(store.list().map(t => [t.channel, t.session]));
  const rebound = new DiscordStore(core, 'different-agent');
  assert.equal(rebound.rebound, true);
  rebound.enqueue(message('five', 'dm-a'), 10);
  rebound.enqueue(message('six', 'thread-b'), 10);
  for (const turn of rebound.list().filter(t => ['five', 'six'].includes(t.id))) {
    assert.notEqual(turn.session, before.get(turn.channel), `${turn.channel} starts a fresh session`);
    assert.equal(turn.ready, false);
  }
  assert.equal(new DiscordStore(core, 'different-agent').rebound, false, 'same binding again is not a rebind');
});

test('Discord leases and scheduler claims enforce the same global capacity', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new DiscordStore(core, 'binding');
  core.enqueue({ kind: 'system.check' }, 'local-model', 'scheduled');
  const job = core.claim('host', 1, scheduler.resources)!;
  store.enqueue(message('one'), 10);
  assert.equal(store.claim(scheduler, config.resource), null);
  core.finish(job.id, 'host', 'succeeded', {}, 'done');
  const turn = store.claim(scheduler, config.resource)!;
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
  const store = new DiscordStore(core, 'binding');
  store.enqueue(message('one'), 10);
  store.enqueue(message('two'), 10);
  store.enqueue(message('three', 'dm-b'), 10);
  store.claim(scheduler, config.resource);
  const second = store.claim({ ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } }, config.resource)!;
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
  assert.ok(store.claim(scheduler, config.resource), 'the queued message can start at once');
  assert.equal(store.claim(scheduler, config.resource), null, 'capacity is one');
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
  const store = new DiscordStore(core, 'binding');
  store.enqueue(message('one'), 10);
  store.enqueue(message('two'), 10);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  let asks = 0;
  const sends: string[] = [];
  const engine = new DiscordEngine(
    store,
    config,
    scheduler,
    async () => {
      asks++;
      await pending;
      return 'Answer';
    },
    async (_channel, text) => {
      sends.push(text);
      throw new Error('Ambiguous Discord response');
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
  const store = new DiscordStore(core, 'binding');
  store.enqueue(message('one', 'dm-a'), 10);
  store.enqueue(message('two', 'dm-b'), 10);
  const sent: string[] = [];
  const engine = new DiscordEngine(
    store,
    { ...config, maxConcurrent: 2 },
    { ...scheduler, maxConcurrent: 2, resources: { 'local-model': 2 } },
    async turn => {
      if (turn.id === 'one') throw new TurnNotStarted(new Error('No running OpenCode v2 service found'));
      throw new Error('lost after prompt');
    },
    async (_channel, text) => void sent.push(text),
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

test('reply splitting preserves Unicode and respects Discord UTF-16 message limits', () => {
  const text = `${'a'.repeat(1899)}${'🦊'.repeat(1000)}\nlast`;
  const chunks = splitReply(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(c => c.length <= 1900 && c.isWellFormed()));
});
