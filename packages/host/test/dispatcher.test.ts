import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Config, configSchema } from '@aivi/core';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore, UNLIMITED } from '../src/dispatcher/leases.ts';
import type { OpenCodeClient } from '../src/opencode.ts';
import { Store } from '../src/store.ts';

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
  };
  fake.client = {
    agent: { list: async () => ({ data: [{ id: 'dev', ...(agentModel ? { model: agentModel } : {}) }] }) },
    session: {
      create: async (body: { id: string; agent: string; location: { directory: string }; model?: unknown }) => {
        sessions.set(body.id, {
          agent: body.agent,
          directory: body.location.directory,
          ...(body.model ? { model: body.model } : {}),
        });
        fake.created.push({ id: body.id, ...(body.model ? { model: body.model } : {}) });
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

function harness(written: Record<string, unknown>, fake = fakeOpenCode()) {
  const leases = new LeaseStore(new Store(':memory:'));
  const ended: { id: string; reason: string }[] = [];
  const dispatcher = new Dispatcher({
    leases,
    dispatcher: dispatcherConfig(written),
    opencode: async () => fake.client,
    onEnded: (lease, reason) => ended.push({ id: lease.id, reason }),
  });
  return { leases, dispatcher, ended, fake };
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

  dispatcher.release(lease.id);
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
  const owned = harness({ dispatcher: { pools: { default: { capacity: 2, model: 'poolprov/poolmodel@fast' } } } });
  const granted = owned.dispatcher.request({ service: 'orchestrator' });
  if (!('lease' in granted)) throw assert.fail('granted');
  await owned.dispatcher.provide(granted.lease.id, { agent: 'dev', directory: '/w' });
  assert.deepEqual(
    owned.fake.created[0]!.model,
    { providerID: 'poolprov', id: 'poolmodel', variant: 'fast' },
    'the pool’s model, in the one spelling, over the agent file’s',
  );

  const bare = harness({ dispatcher: { pools: { quiet: { capacity: 2 } } } });
  const quiet = bare.dispatcher.request({ service: 'orchestrator', pool: 'quiet' });
  if (!('lease' in quiet)) throw assert.fail('granted');
  await bare.dispatcher.provide(quiet.lease.id, { agent: 'dev', directory: '/w' });
  assert.deepEqual(bare.fake.created[0]!.model, { providerID: 'agentprov', id: 'agentmodel' });
});

test('a session keeps its pool for life: a resume returns to the original pool even when only the fallback has room', async () => {
  const { dispatcher, leases } = harness({
    dispatcher: { pools: { home: { capacity: 1, fallback: 'away' }, away: { capacity: 5 } } },
  });
  const first = dispatcher.request({ service: 'orchestrator', pool: 'home' });
  if (!('lease' in first)) throw assert.fail('granted');
  const provided = await dispatcher.provide(first.lease.id, { agent: 'dev', directory: '/w' });
  const sessionId = provided.sessionId!;
  dispatcher.release(first.lease.id);

  // The session goes quiet; its lease is over. Someone else takes the one home slot.
  const other = dispatcher.request({ service: 'orchestrator', pool: 'home' });
  if (!('lease' in other)) throw assert.fail('granted');
  assert.equal(other.lease.pool, 'home');

  // Now the old session returns — the answer to an elicitation. Home is full
  // and away is wide open; a resume is never moved, so it waits.
  const resume = dispatcher.request({ service: 'orchestrator', resume: sessionId });
  assert.deepEqual(resume, { refused: 'full', pool: 'home' });

  dispatcher.release(other.lease.id);
  const back = dispatcher.request({ service: 'orchestrator', resume: sessionId });
  if (!('lease' in back)) throw assert.fail('granted');
  assert.equal(back.lease.pool, 'home', 'back to its own pool');
  assert.equal(back.lease.state, 'active', 'a resume is granted with its session already attached');
  assert.equal(leases.sessionPool(sessionId), 'home');
});

test('a resume recorded in a pool that no longer exists is refused by name, not re-homed', () => {
  const born = harness({ dispatcher: { pools: { a: { capacity: 1 } } } });
  const first = born.dispatcher.request({ service: 'orchestrator', pool: 'a' });
  if (!('lease' in first)) throw assert.fail('granted');
  const sessionId = 'ses_born';
  born.leases.record(sessionId, 'a');

  // The operator renames the pools; the session's memory says "a".
  const moved = harness({ dispatcher: { pools: { b: { capacity: 3 } } } }, born.fake);
  moved.leases.record(sessionId, 'a');
  const resume = moved.dispatcher.request({ service: 'orchestrator', resume: sessionId });
  assert.deepEqual(resume, { refused: 'pool-gone', pool: 'a' });
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

test('a lease without a session is revoked past the prepare timeout, and no interrupt is sent for nothing', async () => {
  const { dispatcher, leases, ended, fake } = harness({
    dispatcher: { pools: { default: { capacity: 2 } } },
  });
  const granted = dispatcher.request({ service: 'orchestrator' });
  if (!('lease' in granted)) throw assert.fail('granted');
  const future = Date.now() + 5 * 60_000 + 1; // the prepare default is 5m
  const result = await dispatcher.expire(
    granted.lease.id,
    'no session was provided within the prepare timeout',
    future,
  );
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
  const waiting = mustGrant(dispatcher.request({ service: 'orchestrator' })); // preparing, no session
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
  dispatcher.release(granted.id);
  assert.throws(() => dispatcher.release(granted.id), /already gone/);
});

test('an unknown pool is said at the request, not silently treated as pressure', () => {
  const { dispatcher } = harness({ dispatcher: { pools: { default: { capacity: 1 } } } });
  assert.throws(
    () => dispatcher.request({ service: 'orchestrator', pool: 'nowhere' }),
    /pool "nowhere" is not configured/,
  );
});

const mustGrant = (r: { lease?: unknown } | { refused?: unknown }, why = 'expected a grant') => {
  if ('lease' in r && r.lease) return r.lease as ReturnType<LeaseStore['require']>;
  throw assert.fail(why);
};
