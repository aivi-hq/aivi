import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Config, configSchema } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore, UNLIMITED } from '../src/dispatcher/leases.ts';
import { Store } from '../src/store.ts';
import { recorder } from './support.ts';

/** The dispatcher's whole client surface is create, get, active, interrupt
 *  and the agent file's model — so the fake is those five, honestly. */
interface Fake {
  client: OpenCodeClient;
  sessions: Map<string, { agent: string; directory: string; model?: unknown }>;
  /** Sessions that are **spending**: what `active` answers with. */
  busy: Set<string>;
  interrupted: string[];
  /** false: OpenCode does not answer at all — the whole server, not a 404. */
  reachable: { value: boolean };
  /** false: the interrupt lands but the session keeps spending (unconfirmed). */
  killWorks: { value: boolean };
  created: { id: string; model?: unknown }[];
  /** What a create does: `lost` makes the session and loses the answer;
   *  `refused` makes nothing. */
  creates: { value: 'answered' | 'lost' | 'refused' };
  /** Every create waits for this first: the window a revoke can land in. */
  createGate: { value?: Promise<void> };
}

function fakeOpenCode(agentModel: unknown = { providerID: 'agentprov', id: 'agentmodel' }): Fake {
  const sessions = new Map<string, { agent: string; directory: string; model?: unknown }>();
  const busy = new Set<string>();
  const fake: Fake = {
    client: undefined as unknown as OpenCodeClient,
    sessions,
    busy,
    interrupted: [],
    reachable: { value: true },
    killWorks: { value: true },
    created: [],
    creates: { value: 'answered' },
    createGate: {},
  };
  fake.client = {
    agent: { list: async () => ({ data: [{ id: 'dev', ...(agentModel ? { model: agentModel } : {}) }] }) },
    session: {
      create: async (body: { id: string; agent: string; location: { directory: string }; model?: unknown }) => {
        await fake.createGate.value;
        if (fake.creates.value === 'refused') throw new Error('create refused');
        sessions.set(body.id, {
          agent: body.agent,
          directory: body.location.directory,
          ...(body.model ? { model: body.model } : {}),
        });
        fake.created.push({ id: body.id, ...(body.model ? { model: body.model } : {}) });
        if (fake.creates.value === 'lost') throw new Error('socket hang up');
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!fake.reachable.value) throw new Error('ECONNREFUSED');
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`session ${sessionID} not found`);
        return { agent: session.agent, location: { directory: session.directory }, model: session.model };
      },
      active: async () => {
        if (!fake.reachable.value) throw new Error('ECONNREFUSED');
        return Object.fromEntries([...busy].map(id => [id, {}]));
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        fake.interrupted.push(sessionID);
        if (fake.killWorks.value) busy.delete(sessionID);
      },
    },
  } as unknown as OpenCodeClient;
  return fake;
}

const dispatcherConfig = (written: Record<string, unknown>): Config['dispatcher'] =>
  configSchema.parse({ version: 1, ...written }).dispatcher;

/** The unit's clocks, in milliseconds: a test that watches a timeout fires
 *  hands 30ms straight in, one that does not never gets an unexpected strike. */
interface Clocks {
  idleMs?: number;
  prepareMs?: number;
}

function harness(
  written: Record<string, unknown>,
  fake = fakeOpenCode(),
  clocks: Clocks = {},
  leases = new LeaseStore(new Store(':memory:')),
) {
  const ended: { id: string; reason: string; code?: string }[] = [];
  const { log, said } = recorder();
  let ending = Promise.withResolvers<void>();
  const dispatcher = new Dispatcher({
    leases,
    dispatcher: dispatcherConfig(written),
    idleMs: clocks.idleMs ?? 60_000,
    prepareMs: clocks.prepareMs ?? 300_000,
    opencode: async () => fake.client,
    log,
    onEnded: (lease, reason, code) => {
      ended.push({ id: lease.id, reason, ...(code ? { code } : {}) });
      ending.resolve();
      ending = Promise.withResolvers<void>();
    },
  });
  /** Settles when the dispatcher next tells an owner that a lease ended. Take it before the clock moves. */
  const nextEnding = () => ending.promise;
  /** Every warning the dispatcher said so far, with its fields. */
  const warned = () => said('warn');
  return { leases, dispatcher, ended, warned, nextEnding, fake };
}

test('unlimited mode grants everything, and the agent file alone decides the model', async () => {
  const { leases, dispatcher, fake } = harness({});
  assert.equal(dispatcher.moderated, false);
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }), 'unlimited mode always grants');
  const lease = granted;
  assert.equal(lease.pool, UNLIMITED);
  assert.equal(lease.state, 'preparing', 'granted before the session exists');

  const provided = await dispatcher.provide(lease.id, { agent: 'dev', directory: '/w' });
  assert.equal(provided.state, 'active');
  assert.equal(fake.created.length, 1);
  assert.deepEqual(
    fake.created[0]!.model,
    { providerID: 'agentprov', id: 'agentmodel' },
    'no pool names one: the agent file wins',
  );

  await dispatcher.release(lease.id);
  assert.equal(leases.held(UNLIMITED), 0);
  assert.equal(fake.sessions.size, 1, 'ending a lease never deletes the session');
});

test('capacity is the pool’s: slots fill, the fallback takes the overflow, and a full walk refuses by name', async () => {
  const { dispatcher, fake } = harness({
    dispatcher: { pools: { default: { capacity: 1, fallback: 'overflow' }, overflow: { capacity: 1 } } },
  });
  const first = dispatcher.request({ service: 'orchestrator' });
  assert.equal('lease' in first ? first.lease.pool : '', 'default');
  const second = dispatcher.request({ service: 'orchestrator' });
  assert.equal(
    'lease' in second ? second.lease.pool : '',
    'overflow',
    'a new session is created in the fallback pool when the first is full',
  );
  const third = dispatcher.request({ service: 'orchestrator' });
  assert.deepEqual(
    third,
    { refused: 'full', pool: 'default' },
    'the refusal names the pool asked for, so the caller can stop asking it',
  );
  void fake;
});

test('the pool decides the model at session create; the agent file wins only where no pool names one', async () => {
  const owned = harness({ dispatcher: { pools: { default: { capacity: 2, model: 'poolprov/poolmodel#fast' } } } });
  const granted = owned.dispatcher.request({ service: 'orchestrator' });
  if (!('lease' in granted)) throw assert.fail('granted');
  await owned.dispatcher.provide(granted.lease.id, { agent: 'dev', directory: '/w' });
  assert.deepEqual(
    owned.fake.created[0]!.model,
    { providerID: 'poolprov', id: 'poolmodel', variant: 'fast' },
    'the pool’s model, in OpenCode’s own spelling, over the agent file’s',
  );

  const bare = harness({ dispatcher: { pools: { quiet: { capacity: 2 } } } });
  const quiet = bare.dispatcher.request({ service: 'orchestrator', pool: 'quiet' });
  if (!('lease' in quiet)) throw assert.fail('granted');
  await bare.dispatcher.provide(quiet.lease.id, { agent: 'dev', directory: '/w' });
  assert.deepEqual(bare.fake.created[0]!.model, { providerID: 'agentprov', id: 'agentmodel' });
});

test('a pool model that is no model reference is said at startup, by OpenCode’s own parser', async () => {
  // The `@` spelling was ours and wrong: OpenCode's parser never splits on
  // it, so `#high` rode inside the model id and the wire answered
  // `Model unavailable` (live, 2026-10-06). The one spelling is OpenCode's:
  // provider/model#variant, and its parser is the startup gate.
  assert.throws(
    () => harness({ dispatcher: { pools: { default: { capacity: 1, model: 'poolprov/poolmodel#' } } } }),
    /Invalid model reference/,
  );
  const good = harness({ dispatcher: { pools: { default: { capacity: 1, model: 'poolprov/poolmodel#fast' } } } });
  assert.ok(good.dispatcher, 'the # spelling is a reference, said never');
});

test('a session keeps its pool for life: a resume returns to the original pool even when only the fallback has room', async () => {
  const { dispatcher, leases } = harness({
    dispatcher: { pools: { home: { capacity: 1, fallback: 'away' }, away: { capacity: 5 } } },
  });
  const first = dispatcher.request({ service: 'orchestrator', pool: 'home' });
  if (!('lease' in first)) throw assert.fail('granted');
  const provided = await dispatcher.provide(first.lease.id, { agent: 'dev', directory: '/w' });
  const sessionId = provided.sessionId!;
  await dispatcher.release(first.lease.id);

  // The session goes quiet; its lease is over. Someone else takes the one home slot.
  const other = dispatcher.request({ service: 'orchestrator', pool: 'home' });
  if (!('lease' in other)) throw assert.fail('granted');
  assert.equal(other.lease.pool, 'home');

  // Now the old session returns — the answer to an elicitation. Home is full
  // and away is wide open; a resume is never moved, so it waits.
  const resume = dispatcher.request({ service: 'orchestrator', resume: sessionId });
  assert.deepEqual(resume, { refused: 'full', pool: 'home' });

  await dispatcher.release(other.lease.id);
  const back = dispatcher.request({ service: 'orchestrator', resume: sessionId });
  if (!('lease' in back)) throw assert.fail('granted');
  assert.equal(back.lease.pool, 'home', 'back to its own pool');
  assert.equal(back.lease.state, 'active', 'a resume is granted with its session already attached');
  assert.equal(leases.sessionPool(sessionId), 'home');
});

test('a resume whose pool the config dropped is said, and the session continues in the pool its caller asks for', async () => {
  // The session was created in pool "a". The operator renamed the pools since.
  const { dispatcher, leases, warned } = harness({
    dispatcher: { pools: { b: { capacity: 1 }, c: { capacity: 3 } } },
  });
  leases.record('ses_born', 'a');

  const resumed = mustGrant(dispatcher.request({ service: 'orchestrator', pool: 'b', resume: 'ses_born' }));
  assert.equal(resumed.pool, 'b', 'the first try failed on its pool: the second runs on the config as it is now');
  assert.equal(resumed.state, 'active', 'still a resume: the session rides the grant');
  assert.equal(resumed.sessionId, 'ses_born');
  assert.equal(leases.sessionPool('ses_born'), 'b', 'the session belongs to that pool from here on');
  assert.deepEqual(
    warned().map(w => [w.event, w.session, w.pool, w.moved]),
    [['resume.pool-gone', 'ses_born', 'a', 'b']],
    'a config that outran a session is said',
  );

  // From here it is an ordinary resume: its own pool outranks what is asked, and nothing is said twice.
  await dispatcher.release(resumed.id);
  const again = mustGrant(dispatcher.request({ service: 'orchestrator', pool: 'c', resume: 'ses_born' }));
  assert.equal(again.pool, 'b');
  assert.equal(warned().length, 1);
});

test('a moved resume waits in the queue of its new pool like any other resume', async () => {
  const { dispatcher, leases } = harness({ dispatcher: { pools: { b: { capacity: 1 } } } });
  const told = registrar(dispatcher, 'orchestrator');
  leases.record('ses_born', 'a');
  const holder = mustGrant(dispatcher.request({ service: 'other', pool: 'b' }));

  const waiting = dispatcher.request({ service: 'orchestrator', pool: 'b', resume: 'ses_born' });
  assert.ok('queued' in waiting, 'the pool it moved to is full: it waits there');
  await dispatcher.release(holder.id);
  assert.deepEqual(
    told.map(t => t.pool),
    ['b'],
  );
  assert.equal(leases.sessionPool('ses_born'), 'b');
});

test('a resume whose pool is gone, asked into a pool the config does not name either, is an error', () => {
  const { dispatcher, leases, warned } = harness({ dispatcher: { pools: { b: { capacity: 1 } } } });
  leases.record('ses_born', 'a');
  assert.throws(
    () => dispatcher.request({ service: 'orchestrator', resume: 'ses_born' }),
    /pool "default" is not configured; name one of b/,
    'the second try fails too: that is the error',
  );
  assert.equal(leases.sessionPool('ses_born'), 'a', 'nothing moved');
  assert.deepEqual(warned(), [], 'and no move is said that did not happen');
});

test('expire kills before it frees: an unconfirmed kill holds the slot, the confirmation releases it and tells the owner', async () => {
  const { dispatcher, leases, ended, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const granted = dispatcher.request({ service: 'orchestrator' });
  if (!('lease' in granted)) throw assert.fail('granted');
  const provided = await dispatcher.provide(granted.lease.id, { agent: 'dev', directory: '/w' });
  fake.busy.add(provided.sessionId!);

  fake.killWorks.value = false; // the session ignores the interrupt and keeps spending
  const pending = await dispatcher.expire(provided.id, 'idle beyond the timeout');
  assert.equal('pending' in pending, true);
  assert.deepEqual(fake.interrupted, [provided.sessionId], 'the kill went first');
  assert.equal(leases.held('default'), 1, 'an unconfirmed kill keeps the slot unavailable');
  assert.equal(leases.require(provided.id).state, 'expiring');
  assert.deepEqual(dispatcher.request({ service: 'orchestrator' }), { refused: 'full', pool: 'default' });
  assert.deepEqual(ended, [], 'nothing was announced yet');

  fake.killWorks.value = true; // the same kill, confirmed this time
  const done = await dispatcher.expire(provided.id, 'idle beyond the timeout');
  assert.equal('ended' in done, true);
  assert.equal(leases.held('default'), 0);
  assert.deepEqual(ended, [{ id: provided.id, reason: 'idle beyond the timeout' }], 'the owner is told');
});

test('a release mid-expiry confirms the kill first — an unconfirmed release never hands the slot to the queue', async () => {
  const { dispatcher, leases, ended, fake } = harness(
    { dispatcher: { pools: { default: { capacity: 1 } } } },
    undefined,
    { idleMs: 3_600_000 }, // the release re-arms its confirmation clock; this test is the one that reads it
  );
  const granted = dispatcher.request({ service: 'orchestrator' });
  if (!('lease' in granted)) throw assert.fail('granted');
  const provided = await dispatcher.provide(granted.lease.id, { agent: 'dev', directory: '/w' });
  fake.busy.add(provided.sessionId!);
  fake.killWorks.value = false; // the dispatcher began its kill; the session ignores it
  const pending = await dispatcher.expire(provided.id, 'idle beyond the timeout');
  assert.equal('pending' in pending, true);

  // The run ends while the kill stands unconfirmed — the old release took
  // the lease at face value and drained the pool: the queue got a slot
  // whose session was still spending. Now the release confirms first.
  const told = registrar(dispatcher, 'other');
  const waiting = dispatcher.request({ service: 'other' });
  assert.ok('queued' in waiting, 'the pool is full: the next ask waits');
  const outcome = await dispatcher.release(provided.id);
  assert.equal('pending' in outcome, true, 'unconfirmed: the release stays a pending');
  assert.equal(leases.require(provided.id).state, 'expiring', 'the lease stays where the retry can find it');
  assert.equal(leases.held('default'), 1, 'the slot never went to the queue');
  assert.deepEqual(told, [], 'the waiter heard nothing: no slot was handed out');
  assert.deepEqual(ended, [], 'nothing was announced yet');

  fake.killWorks.value = true; // the same kill, confirmed this time
  const done = await dispatcher.expire(provided.id, 'the confirmation lands');
  assert.equal('ended' in done, true);
  assert.equal(told.length, 1, 'the confirmed kill is what opens the slot to the queue');
  const [second] = leases.all().filter(l => l.pool === 'default' && l.id !== provided.id);
  assert.ok(second, 'the waiter got its own fresh lease');
  assert.equal(second.state, 'preparing');
  await dispatcher.release(second.id);
  assert.equal(leases.held('default'), 0, 'and both leases are off the books now');
});

test('a lease without a session is revoked past the prepare timeout, and no interrupt is sent for nothing', async () => {
  const { dispatcher, leases, ended, fake } = harness({
    dispatcher: { pools: { default: { capacity: 2 } } },
  });
  const granted = dispatcher.request({ service: 'orchestrator' });
  if (!('lease' in granted)) throw assert.fail('granted');
  const result = await dispatcher.expire(granted.lease.id, 'no session was provided within the prepare timeout');
  assert.equal('ended' in result, true);
  assert.deepEqual(fake.interrupted, [], 'there was no session to kill');
  assert.equal(leases.held('default'), 0);
  assert.deepEqual(ended, [{ id: granted.lease.id, reason: 'no session was provided within the prepare timeout' }]);
});

test('boot reconcile: gone sessions release, alive ones stand, expired kills confirm, and a silent OpenCode defers the whole pass', async () => {
  const { dispatcher, leases, ended, fake } = harness({ dispatcher: { pools: { default: { capacity: 4 } } } });
  const alive = await dispatcher.provide(mustGrant(dispatcher.request({ service: 'orchestrator' })).id, {
    agent: 'dev',
    directory: '/w',
  });
  const gone = await dispatcher.provide(mustGrant(dispatcher.request({ service: 'orchestrator' })).id, {
    agent: 'dev',
    directory: '/w',
  });
  const dying = await dispatcher.provide(mustGrant(dispatcher.request({ service: 'orchestrator' })).id, {
    agent: 'dev',
    directory: '/w',
  });
  mustGrant(dispatcher.request({ service: 'orchestrator' })); // preparing, no session
  // A kill that never got confirmed: the session ignored the interrupt.
  fake.busy.add(dying.sessionId!);
  fake.killWorks.value = false;
  await dispatcher.expire(dying.id, 'idle beyond the timeout');
  assert.equal(leases.require(dying.id).state, 'expiring');
  fake.killWorks.value = true;
  fake.busy.delete(dying.sessionId!); // by boot time the kill did land

  fake.sessions.delete(gone.sessionId!); // OpenCode restarted without that session
  const result = await dispatcher.reconcile(Date.now() + 6 * 60_000);
  assert.equal(result.deferred, false);
  assert.deepEqual(result.ended.map(e => e.reason).sort(), [
    'its OpenCode session is gone',
    'no session was provided within the prepare timeout',
    'the kill was confirmed',
  ]);
  assert.equal(leases.get(alive.id)?.state, 'active', 'a live attached lease stands as it was');
  assert.equal(leases.held('default'), 1, 'only the survivor holds a slot');
  assert.equal(fake.sessions.has(alive.sessionId!), true);
  void ended;

  // And the same store against a server that does not answer at all: nothing moves.
  fake.reachable.value = false;
  const deferred = await dispatcher.reconcile();
  assert.deepEqual(deferred, { ended: [], deferred: true });
  assert.equal(leases.get(alive.id)?.state, 'active', 'silence is not proof of death');
});

test('a lease is provided once: a second session for the same lease is refused as loudly as a double release', async () => {
  const { dispatcher } = harness({});
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  await dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' });
  await assert.rejects(dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' }), /only a preparing lease/);
  await dispatcher.release(granted.id);
  await assert.rejects(dispatcher.release(granted.id), /already gone/);
});

test('an unknown pool is said at the request, not silently treated as pressure', () => {
  const { dispatcher } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  assert.throws(
    () => dispatcher.request({ service: 'orchestrator', pool: 'nowhere' }),
    /pool "nowhere" is not configured/,
  );
});

const mustGrant = (r: { lease?: unknown } | { queued?: unknown } | { refused?: unknown }, why = 'expected a grant') => {
  if ('lease' in r && r.lease) return r.lease as ReturnType<LeaseStore['require']>;
  throw assert.fail(why);
};

/** Register a service's callback namespace: everything the queue fulfils
 *  for it is heard here. */
function registrar(dispatcher: Dispatcher, service: string) {
  const heard: { request: string; lease: string; pool: string }[] = [];
  dispatcher.registerCallback(service, (requestId, lease) => {
    heard.push({ request: requestId, lease: lease.id, pool: lease.pool });
  });
  return heard;
}

const queuedId = (r: { queued?: string }) => {
  if (r.queued) return r.queued;
  throw assert.fail('expected a queued request');
};

test('a full pool accepts into its queue, one place per service, and the service is told with its request id', async () => {
  const { dispatcher } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const told = registrar(dispatcher, 'caller');
  const first = mustGrant(dispatcher.request({ service: 'first' }), 'a free slot grants at once');
  const waiting = dispatcher.request({ service: 'caller' });
  assert.ok('queued' in waiting, 'a full pool accepts the request into its queue');
  const refused = dispatcher.request({ service: 'caller' });
  assert.deepEqual(
    refused,
    { refused: 'waiting', pool: 'default' },
    'a service holds one queue place per pool: the second ask is refused',
  );
  await dispatcher.release(first.id);
  assert.equal(told.length, 1, 'the callback is the wake: it hears when the request becomes a lease');
  assert.equal(told[0]!.request, queuedId(waiting), 'told with the very request id it asked under');
  assert.equal(told[0]!.pool, 'default');
  assert.equal(dispatcher.leases.held('default'), 1, 'the freed slot went straight to the queue');
});

test('the queue walks in order, and a cancelled request only loses its place', async () => {
  const { dispatcher } = harness({ dispatcher: { pools: { default: { capacity: 2 } } } });
  const heard = registrar(dispatcher, 'second');
  registrar(dispatcher, 'third');
  registrar(dispatcher, 'later');
  const one = mustGrant(dispatcher.request({ service: 'one' }));
  const two = mustGrant(dispatcher.request({ service: 'two' }));
  const second = dispatcher.request({ service: 'second' });
  const third = dispatcher.request({ service: 'third' });
  assert.ok('queued' in second && 'queued' in third, 'the full pool takes both asks');
  dispatcher.cancel(queuedId(third));
  await dispatcher.release(one.id);
  assert.equal(heard.length, 1, 'the one still waiting walks in; the cancelled one does not');
  assert.equal(heard[0]!.request, queuedId(second));
  assert.equal(dispatcher.leases.held('default'), 2, 'second took the slot; the cancelled third stayed out');
  const after = dispatcher.request({ service: 'later' });
  assert.ok('queued' in after, 'and the queue goes on taking asks in the order they come');
  await dispatcher.release(two.id);
  assert.equal(heard.length, 1, 'second was already told: the drain went to the next, not twice to one');
  void after;
});

test('a resume waits in its own pool and returns there, never into the fallback that had room', async () => {
  const { leases, dispatcher } = harness({
    dispatcher: { pools: { home: { capacity: 1, fallback: 'away' }, away: { capacity: 5 } } },
  });
  const told = registrar(dispatcher, 'orchestrator');
  const own = mustGrant(dispatcher.request({ service: 'orchestrator', pool: 'home' }));
  await dispatcher.provide(own.id, { agent: 'dev', directory: '/w' });
  const sessionId = leases.require(own.id).sessionId!;

  // Someone else takes the fallback on their own ask; home still holds ours.
  const other = mustGrant(dispatcher.request({ service: 'other', pool: 'home' }), 'the chain walks for a new session');
  assert.equal(other.pool, 'away');

  const waiting = dispatcher.request({ service: 'orchestrator', resume: sessionId });
  assert.ok('queued' in waiting, 'a full original pool queues the resume — the fallback is not its answer');

  await dispatcher.release(own.id);
  assert.equal(told.length, 1, 'the resume walks in the moment its own pool opens');
  assert.equal(told[0]!.pool, 'home', 'back into its own pool, where its model and cache live');
  assert.equal(leases.held('home'), 1);
  assert.equal(leases.held('away'), 1, 'the other lease stands untouched');
  assert.equal(leases.sessionPool(sessionId), 'home', 'the session never changed pools, queue or no queue');
});

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};

test('the idle monitor kills a silent worker, confirms the kill, and frees the slot', async () => {
  const { dispatcher, ended, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } }, undefined, {
    idleMs: 30,
  });
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  await dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' });
  const sessionId = dispatcher.leases.require(granted.id).sessionId!;
  fake.busy.add(sessionId);

  await until(() => ended.length === 1, 'the silence ends the lease at its known instant');
  assert.match(ended[0]!.reason, /idle timeout/);
  assert.deepEqual(fake.interrupted, [sessionId], 'the kill went first');
  assert.equal(dispatcher.leases.held('default'), 0, 'the slot came back once the kill was confirmed');
});

test('an unconfirmed kill keeps the slot unavailable and tries again at a known instant', async () => {
  const { dispatcher, ended, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } }, undefined, {
    idleMs: 30,
  });
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  await dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' });
  const sessionId = dispatcher.leases.require(granted.id).sessionId!;
  fake.busy.add(sessionId);
  fake.killWorks.value = false; // the interrupt lands; the session keeps spending

  await until(() => fake.interrupted.length >= 1, 'the monitor struck');
  assert.equal(dispatcher.leases.held('default'), 1, 'capacity that may still be working is never double-booked');
  assert.deepEqual(ended, [], 'no ending without confirmation');

  fake.killWorks.value = true; // the worker dies of the first strike, late
  await until(() => ended.length === 1, 'the retry — a known instant, not a poll — confirms and frees');
  assert.equal(dispatcher.leases.held('default'), 0);
});

test('a session that will not die is given up on at the configured strikes — and the ending says so in machine-readable words', async () => {
  const { dispatcher, ended, fake } = harness(
    {
      dispatcher: {
        pools: { default: { capacity: 1 } },
        killAttempts: 2,
      },
    },
    undefined,
    { idleMs: 30 },
  );
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  await dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' });
  const sessionId = dispatcher.leases.require(granted.id).sessionId!;
  fake.busy.add(sessionId);
  fake.killWorks.value = false; // every strike misses: the session will not die

  await until(() => ended.length === 1, 'the last strike gives up on the session, not on the slot');
  assert.equal(fake.interrupted.length, 2, 'it was struck exactly as hard as configured');
  assert.match(ended[0]!.reason, /did not stop after 2 kill attempts/);
  assert.equal(ended[0]!.code, 'kill-unconfirmed', 'the tracker is told in code, never by reading English');
  assert.equal(dispatcher.leases.held('default'), 0, 'one stubborn session never holds a pool hostage');
});

test('the prepare timeout revokes a lease nobody provided a session for — capacity counted or not', async () => {
  const { dispatcher, ended, fake } = harness({}, undefined, { prepareMs: 30 });
  mustGrant(dispatcher.request({ service: 'orchestrator' }));
  await until(() => ended.length === 1, 'the preparation window closes');
  assert.match(ended[0]!.reason, /prepare timeout/);
  assert.equal(dispatcher.leases.held(UNLIMITED), 0, 'the slot is given back');
  assert.deepEqual(fake.interrupted, [], 'nothing to kill: a revoke needs no kill');
});

test('activity re-arms the clock: a worker that keeps talking never dies of silence', async () => {
  const { dispatcher, ended, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } }, undefined, {
    idleMs: 30,
  });
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  await dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' });
  const sessionId = dispatcher.leases.require(granted.id).sessionId!;
  fake.busy.add(sessionId);

  for (let at = 0; at < 6; at++) {
    await new Promise(r => setTimeout(r, 10)); // 60ms: past the idle clock in total
    dispatcher.activity(granted.id); // each sign of life restarts the silence clock
  }
  assert.deepEqual(ended, [], 'the worker lived through every instant the clock once pointed at');
  await until(() => ended.length === 1, 'and it strikes once the signs stop');
});

/** A lease with its session attached, in the default pool. */
const working = async (dispatcher: Dispatcher, service = 'orchestrator') =>
  dispatcher.provide(mustGrant(dispatcher.request({ service })).id, { agent: 'dev', directory: '/w' });

test('a session the dispatcher has never seen resumes in the pool its caller asks for, at once or from the queue', async () => {
  const { dispatcher, leases } = harness({ dispatcher: { pools: { a: { capacity: 1 } } } });
  const told = registrar(dispatcher, 'discord');
  const first = mustGrant(dispatcher.request({ service: 'discord', pool: 'a', resume: 'ses_adopted' }));
  assert.equal(first.pool, 'a');
  assert.equal(first.state, 'active', 'a resume: the session rides the grant');
  assert.equal(leases.sessionPool('ses_adopted'), 'a', 'its first appearance here is the pool it keeps');

  const waiting = dispatcher.request({ service: 'discord', pool: 'a', resume: 'ses_other' });
  assert.ok('queued' in waiting, 'the pool is full: the unknown session waits where it was asked');
  await dispatcher.release(first.id);
  assert.deepEqual(
    told.map(t => t.pool),
    ['a'],
  );
  assert.equal(leases.sessionPool('ses_other'), 'a');
});

test('a pool model that names no variant is passed on without one', async () => {
  const { dispatcher, fake } = harness({
    dispatcher: { pools: { default: { capacity: 1, model: 'poolprov/poolmodel' } } },
  });
  await working(dispatcher);
  assert.deepEqual(fake.created[0]!.model, { providerID: 'poolprov', id: 'poolmodel' });
});

test('provide attaches a session its caller brings by id without creating one, and refuses a session that is not that work', async () => {
  const { dispatcher, leases, fake } = harness({ dispatcher: { pools: { default: { capacity: 3 } } } });
  fake.sessions.set('ses_kept', { agent: 'dev', directory: '/w' });

  const granted = mustGrant(dispatcher.request({ service: 'plugin' }));
  const attached = await dispatcher.provide(granted.id, { agent: 'dev', directory: '/w', sessionId: 'ses_kept' });
  assert.equal(attached.state, 'active');
  assert.equal(attached.sessionId, 'ses_kept');
  assert.deepEqual(fake.created, [], 'the session existed: nothing was created and no model was decided again');
  assert.equal(leases.sessionPool('ses_kept'), 'default', 'its pool is recorded where it first appears');

  const other = mustGrant(dispatcher.request({ service: 'plugin' }));
  await assert.rejects(
    dispatcher.provide(other.id, { agent: 'review', directory: '/w', sessionId: 'ses_kept' }),
    /session ses_kept no longer runs agent review in \/w/,
  );
  await assert.rejects(
    dispatcher.provide(other.id, { agent: 'dev', directory: '/elsewhere', sessionId: 'ses_kept' }),
    /session ses_kept no longer runs agent dev in \/elsewhere/,
  );
  await assert.rejects(
    dispatcher.provide(other.id, { agent: 'dev', directory: '/w', sessionId: 'ses_missing' }),
    /session ses_missing not found/,
    'a session OpenCode does not have is the caller’s error, never a quiet create',
  );
  assert.equal(leases.require(other.id).state, 'preparing', 'a refused provide leaves the lease as it was');
  await assert.rejects(
    dispatcher.provide('lease_unknown', { agent: 'dev', directory: '/w' }),
    /No lease lease_unknown/,
  );
});

test('a create whose answer was lost keeps the session that landed; a create that made nothing is the caller’s error', async () => {
  const { dispatcher, leases, fake } = harness({ dispatcher: { pools: { default: { capacity: 3 } } } });
  fake.creates.value = 'lost';
  const landed = mustGrant(dispatcher.request({ service: 'jobs' }));
  const attached = await dispatcher.provide(landed.id, {
    agent: 'dev',
    directory: '/w',
    sessionId: 'ses_job',
    create: true,
  });
  assert.equal(attached.sessionId, 'ses_job', 'the id the caller allocated is kept, not re-imagined');
  assert.equal(attached.state, 'active');

  fake.creates.value = 'refused';
  const refused = mustGrant(dispatcher.request({ service: 'jobs' }));
  const create = (sessionId: string) =>
    dispatcher.provide(refused.id, { agent: 'dev', directory: '/w', sessionId, create: true });
  await assert.rejects(create('ses_never'), /create refused/);
  // The id exists, but as other work: a failed create is never answered with somebody else's session.
  fake.sessions.set('ses_reviewing', { agent: 'review', directory: '/w' });
  await assert.rejects(create('ses_reviewing'), /create refused/);
  fake.sessions.set('ses_elsewhere', { agent: 'dev', directory: '/elsewhere' });
  await assert.rejects(create('ses_elsewhere'), /create refused/);
  assert.equal(leases.require(refused.id).state, 'preparing');
});

test('a session born for a lease that was revoked in the meantime is not attached', async () => {
  const { dispatcher, leases, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const gate = Promise.withResolvers<void>();
  fake.createGate.value = gate.promise;
  const granted = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  const providing = dispatcher.provide(granted.id, { agent: 'dev', directory: '/w' });
  // The prepare window closes while the create is still on the wire.
  await dispatcher.expire(granted.id, 'no session was provided within the prepare timeout');
  gate.resolve();
  await assert.rejects(providing, /was not preparing; nothing attached/);
  assert.equal(leases.held('default'), 0, 'the revoked slot stays free');
});

test('the lease store refuses to act on a lease that is not there', () => {
  const { leases } = harness({});
  const lease = leases.grant({ kind: 'session', service: 'direct', pool: 'p' })!;
  leases.attach(lease.id, 'ses_1');
  assert.throws(() => leases.attach(lease.id, 'ses_2'), /was not preparing; nothing attached/);
  leases.release(lease.id);
  assert.throws(() => leases.release(lease.id), /was already gone/);
  assert.throws(() => leases.beginExpiry(lease.id), /was already gone/);
  assert.equal(leases.get(lease.id), undefined);
});

test('a release of a lease whose kill was pending ends it once the kill confirms', async () => {
  const { dispatcher, leases, ended, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const provided = await working(dispatcher);
  fake.busy.add(provided.sessionId!);
  fake.killWorks.value = false;
  await dispatcher.expire(provided.id, 'idle beyond the timeout');
  fake.killWorks.value = true; // the worker gives in by the time its owner lets go

  const outcome = await dispatcher.release(provided.id);
  assert.ok('ended' in outcome, 'confirmed: the release ends the lease');
  assert.equal(leases.held('default'), 0);
  assert.deepEqual(fake.interrupted, [provided.sessionId, provided.sessionId], 'it struck again before it freed');
  assert.equal(ended.length, 1, 'the owner is told once');
});

test('boot pass: a kill that is still unconfirmed is struck again — confirmed on that retry it ends, otherwise it stands', async () => {
  const { dispatcher, leases, fake } = harness({ dispatcher: { pools: { default: { capacity: 2 } } } });
  const stubborn = await working(dispatcher);
  fake.busy.add(stubborn.sessionId!);
  fake.killWorks.value = false;
  await dispatcher.expire(stubborn.id, 'idle beyond the timeout');

  // The host restarts. The session is still spending and still will not die.
  assert.deepEqual(await dispatcher.reconcile(), { ended: [], deferred: false });
  assert.equal(leases.require(stubborn.id).state, 'expiring', 'unconfirmed: the slot stays held');
  assert.equal(fake.interrupted.length, 2, 'the boot pass struck again');

  fake.killWorks.value = true; // the next boot's strike lands
  const done = await dispatcher.reconcile();
  assert.deepEqual(
    done.ended.map(e => e.reason),
    ['the kill was confirmed on retry'],
  );
  assert.equal(leases.held('default'), 0);
});

test('boot pass: a lease still inside its prepare window stands', async () => {
  const { dispatcher, leases } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const fresh = mustGrant(dispatcher.request({ service: 'orchestrator' }));
  assert.deepEqual(await dispatcher.reconcile(), { ended: [], deferred: false });
  assert.equal(leases.require(fresh.id).state, 'preparing', 'its caller still has time to bring the session');
});

test('an active set that cannot be read is never a confirmation', async () => {
  const { dispatcher, leases, ended, warned, fake } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const provided = await working(dispatcher);
  fake.reachable.value = false; // the interrupt goes out, but nobody can say what still runs

  const outcome = await dispatcher.expire(provided.id, 'idle beyond the timeout');
  assert.ok('pending' in outcome);
  assert.equal(leases.require(provided.id).state, 'expiring');
  assert.equal(leases.held('default'), 1, 'the slot stays held rather than risk a double booking');
  assert.deepEqual(ended, []);
  assert.deepEqual(
    warned().map(w => w.event),
    ['active.set.unreadable', 'expire.unconfirmed'],
  );
});

test('one freed slot serves the first in line; the next keeps waiting for its own', async () => {
  const { dispatcher } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const first = registrar(dispatcher, 'first');
  const second = registrar(dispatcher, 'second');
  const holder = mustGrant(dispatcher.request({ service: 'holder' }));
  assert.ok('queued' in dispatcher.request({ service: 'first' }));
  assert.ok('queued' in dispatcher.request({ service: 'second' }));

  await dispatcher.release(holder.id);
  assert.equal(first.length, 1, 'the first to ask walks in');
  assert.deepEqual(second, [], 'the pool is full again: the next in line waits on');
  await dispatcher.release(first[0]!.lease);
  assert.equal(second.length, 1, 'and gets the slot after that');
});

test('cancelling the only waiting request empties the line; an id nobody holds is nothing', async () => {
  const { dispatcher } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  const told = registrar(dispatcher, 'caller');
  const holder = mustGrant(dispatcher.request({ service: 'holder' }));
  const waiting = dispatcher.request({ service: 'caller' });
  assert.ok('queued' in waiting, 'the pool is full: the ask waits');
  dispatcher.cancel('req_from_before_a_restart'); // the queue is ephemeral: an unknown id was already lost
  dispatcher.cancel(waiting.queued);
  dispatcher.cancel(waiting.queued); // twice is once

  await dispatcher.release(holder.id);
  assert.deepEqual(told, [], 'nobody is handed a slot they stopped waiting for');
  assert.equal(dispatcher.held(), 0);
  assert.ok('lease' in dispatcher.request({ service: 'caller' }), 'and the slot is there to ask for again');
});

test('one strike is all a session gets when the config says so, and the ending counts it in the singular', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { dispatcher, ended, nextEnding, fake } = harness(
    { dispatcher: { pools: { default: { capacity: 1 } }, killAttempts: 1 } },
    undefined,
    { idleMs: 1_000 },
  );
  const provided = await working(dispatcher);
  fake.busy.add(provided.sessionId!);
  fake.killWorks.value = false; // the session will not die

  const ending = nextEnding();
  t.mock.timers.tick(1_000);
  await ending;
  assert.deepEqual(ended, [
    { id: provided.id, reason: 'the session did not stop after 1 kill attempt', code: 'kill-unconfirmed' },
  ]);
  assert.deepEqual(fake.interrupted, [provided.sessionId]);
  assert.equal(dispatcher.held(), 0, 'the slot comes back even though the session did not');
});
