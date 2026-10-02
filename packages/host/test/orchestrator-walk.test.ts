import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, type Logger, type ProjectLane, parseDuration } from '@aivi/core';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore } from '../src/dispatcher/leases.ts';
import type { SessionEvents } from '../src/events.ts';
import type { OpenCodeClient } from '../src/opencode.ts';
import { RunLedger } from '../src/orchestrator/ledger.ts';
import type { TicketFeed } from '../src/orchestrator/orchestrator.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { Store } from '../src/store.ts';

/** The walk over a scripted board: real orchestrator, real dispatcher, real
 *  ledger — only OpenCode and the tracker are faked, because the walk's
 *  decisions are the point and they must not need a platform to be pinned. */

const noEvents: SessionEvents = { watch: () => () => {} };
const quiet = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  getChild: () => quiet,
  with: () => quiet,
} as unknown as Logger;

interface Fake {
  client: OpenCodeClient;
  /** Every prompt the workers were started with, in order. */
  prompts: { sessionID: string; text: string }[];
  sessions: Map<string, { agent: string; directory: string }>;
  /** Sessions that are spending: what `active` answers with. */
  busy: Set<string>;
  interrupted: string[];
  /** The elicitations: askTool opens one, an answer closes it. */
  forms: { id: string; sessionID: string; answered?: unknown }[];
}

function fakeOpenCode(): Fake {
  const sessions = new Map<string, { agent: string; directory: string }>();
  const busy = new Set<string>();
  const fake: Fake = {
    client: undefined as unknown as OpenCodeClient,
    prompts: [],
    sessions,
    busy,
    interrupted: [],
    forms: [],
  };
  fake.client = {
    agent: { list: async () => ({ data: [{ id: 'dev', model: { providerID: 'agentprov', id: 'agentmodel' } }] }) },
    session: {
      create: async (body: { id: string; agent: string; location: { directory: string } }) => {
        sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`session ${sessionID} not found`);
        return { agent: session.agent, location: { directory: session.directory } };
      },
      active: async () => Object.fromEntries([...busy].map(id => [id, {}])),
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        fake.interrupted.push(sessionID);
        busy.delete(sessionID);
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        fake.prompts.push({ sessionID: input.sessionID, text: input.text });
      },
      form: {
        create: async (input: { sessionID: string }) => {
          const id = `form_${fake.forms.length + 1}`;
          fake.forms.push({ id, sessionID: input.sessionID });
          return { id };
        },
        list: async ({ sessionID }: { sessionID: string }) =>
          fake.forms.filter(f => f.sessionID === sessionID && f.answered === undefined),
        reply: async (input: { sessionID: string; formID: string; answer: unknown }) => {
          const form = fake.forms.find(f => f.id === input.formID && f.answered === undefined);
          if (!form) throw new Error(`no open form ${input.formID}`);
          form.answered = input.answer;
          return form;
        },
      },
    },
  } as unknown as OpenCodeClient;
  return fake;
}

interface Scripted extends TicketFeed {
  /** Everything the walk did to the board: queue pickups arrive as moves. */
  moves: string[];
  /** How many prompts existed when each move was said — the proof of
   *  move-then-start: the lane says it before the worker does. */
  moveDepths: number[];
  retire(ticketId: string): void;
}

function boardFeed(fake: Fake, board: Record<string, { id: string; blocked?: boolean }[]>): Scripted {
  const lanes = new Map(Object.entries(board).map(([lane, tickets]) => [lane, tickets.map(t => ({ ...t }))]));
  const moves: string[] = [];
  const moveDepths: number[] = [];
  return {
    moves,
    moveDepths,
    projects: () => ['p'],
    tickets: async (projectId, state) => (lanes.get(state) ?? []).map(t => ({ id: t.id, blocked: t.blocked ?? false })),
    moveTo: async (projectId, ticketId, state) => {
      moves.push(`move:${ticketId}->${state}`);
      moveDepths.push(fake.prompts.length);
      for (const tickets of lanes.values()) {
        const at = tickets.findIndex(t => t.id === ticketId);
        if (at >= 0) tickets.splice(at, 1);
      }
      const entering = lanes.get(state) ?? [];
      entering.push({ id: ticketId });
      lanes.set(state, entering);
    },
    firstMessage: async (projectId, ticketId, lane) => `do ${ticketId} in ${lane.name}`,
    retire: ticketId => {
      // What the module's stop-memory does to its board: a ticket a person
      // stopped is not on it, whatever lane still holds the issue.
      for (const tickets of lanes.values()) {
        const at = tickets.findIndex(t => t.id === ticketId);
        if (at >= 0) tickets.splice(at, 1);
      }
    },
  };
}

function harness(
  lanes: ProjectLane[],
  written: Record<string, unknown>,
  feed: TicketFeed,
  fake = fakeOpenCode(),
  abort = new AbortController(),
) {
  const store = new Store(':memory:');
  const ledger = new RunLedger(store);
  const dispatcher = new Dispatcher({
    leases: new LeaseStore(store),
    dispatcher: configSchema.parse({ version: 1, ...written }).dispatcher,
    opencode: async () => fake.client,
    signal: abort.signal,
    // The application's wiring: the dispatcher ends a lease, and the claim
    // that mirrored it clears through the orchestrator.
    onEnded: (lease, reason) => void orchestrator.leaseEnded(lease, reason),
  });
  const orchestrator = new Orchestrator({
    ledger,
    opencode: async () => fake.client,
    events: noEvents,
    log: quiet,
    signal: abort.signal,
    lanes: () => lanes,
    keepAliveMs: parseDuration(configSchema.parse({ version: 1, ...written }).orchestrator.elicitationKeepAlive),
    directory: () => '/checkout',
    dispatcher,
  });
  orchestrator.addFeed('test-tracker', feed);
  return { ledger, dispatcher, orchestrator, fake };
}

const lane = (name: string, extra: Partial<ProjectLane> = {}): ProjectLane => ({
  name,
  queue: false,
  worktree: false,
  ...extra,
});

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(check(), what);
};

test('the walk reads the board right to left, the queue bottom last, and moves a picked ticket before starting it', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, {
    Todo: [{ id: 't-fresh' }],
    'In Progress': [{ id: 't-working' }],
    'In Review': [{ id: 't-review' }],
  });
  const lanes = [
    lane('Backlog'),
    lane('Todo', { queue: true }),
    lane('In Progress', { agent: 'dev' }),
    lane('In Review', { agent: 'dev' }),
  ];
  const { ledger, dispatcher, orchestrator } = harness(
    lanes,
    { dispatcher: { pools: { default: { capacity: 1 } } } },
    feed,
    fake,
  );

  await orchestrator.wake('p');
  await until(() => fake.prompts.length === 1, 'one worker starts under capacity 1');
  assert.match(
    fake.prompts[0]!.text,
    /do t-review in In Review/,
    'the lane closest to done is picked from first; working and fresh wait their turn',
  );
  const review = ledger.activeByTicket('test-tracker', 't-review')!;
  assert.ok(review.leaseId, 'the claim mirrors a lease');
  assert.equal(dispatcher.leases.require(review.leaseId!).service, 'orchestrator');

  // The stop-memory answer goes on the board **before** the stop: the
  // ending wakes the walk in the same breath, and a pass must never read
  // the stopped ticket back — the module marks its stop synchronously for
  // exactly this reason.
  feed.retire('t-review');
  await orchestrator.stop(review.id, 'the test is done with it');
  await until(() => fake.prompts.length === 2, 'the ending wakes the walk again');
  assert.match(
    fake.prompts[1]!.text,
    /do t-working in In Progress/,
    'work already started comes before work waiting in the queue',
  );

  const working = ledger.activeByTicket('test-tracker', 't-working')!;
  feed.retire('t-working');
  await orchestrator.stop(working.id, 'the test is done with it');
  await until(() => fake.prompts.length === 3, 'and again');
  assert.match(fake.prompts[2]!.text, /do t-fresh in In Progress/);
  assert.deepEqual(feed.moves, ['move:t-fresh->In Progress'], 'the queue pickup moves the ticket into the worker lane');
  assert.deepEqual(feed.moveDepths, [2], 'the move is said before the worker starts: move-then-start');
  const fresh = ledger.activeByTicket('test-tracker', 't-fresh')!;
  assert.equal(fresh.lane, 'In Progress', 'the claim is for the lane it entered, not the queue');
  assert.equal(fake.sessions.size, 3);
});

test('a full pool queues one ticket of its own and stops the pass asking twice, while other pools walk on — and the queue walks in when a slot opens', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, { Doing: [{ id: 'd1' }, { id: 'd2' }], Later: [{ id: 'l1' }] });
  const lanes = [lane('Doing', { agent: 'dev', pool: 'a' }), lane('Later', { agent: 'dev', pool: 'b' })];
  const { ledger, dispatcher, orchestrator } = harness(
    lanes,
    { dispatcher: { pools: { a: { capacity: 1 }, b: { capacity: 1 } } } },
    feed,
    fake,
  );
  await orchestrator.wake('p');
  await until(
    () => fake.prompts.length === 2,
    'l1 (pool b) and d1 (pool a): the second Doing ticket never asks pool a twice',
  );
  const firsts = fake.prompts.map(p => p.text.split('\n')[0]).sort();
  assert.deepEqual(firsts, ['do d1 in Doing', 'do l1 in Later'], 'd2 waits in the queue: one place per pool');
  assert.equal(dispatcher.leases.held('a'), 1);
  assert.equal(dispatcher.leases.held('b'), 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fake.prompts.length, 2, 'd2 holds a queue place, not a slot: it does not start');

  // Pool b's slot opens: nothing to do with d2, which waits for pool a.
  // (The board retires each stopped ticket first — what the module's
  // stop-memory does to its own feed.)
  const l1Run = ledger.activeByTicket('test-tracker', 'l1')!;
  feed.retire('l1');
  await orchestrator.stop(l1Run.id, 'the test is done with it');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fake.prompts.length, 2, 'd2 waits its own pool, not whichever slot opens');

  // Pool a's slot opens: the queue walks in — no one asks again.
  const d1Run = ledger.activeByTicket('test-tracker', 'd1')!;
  feed.retire('d1');
  await orchestrator.stop(d1Run.id, 'the test is done with it');
  await until(() => fake.prompts.length === 3, 'the waiting ticket gets the freed slot by itself');
  assert.match(fake.prompts[2]!.text, /do d2 in Doing/);
  assert.equal(dispatcher.leases.held('a'), 1, 'the queue place became a lease');
});

test('blocked tickets wait, and a ticket gone since the listing gives its slot back', async () => {
  const fake = fakeOpenCode();
  const feed: TicketFeed = {
    projects: () => ['p'],
    tickets: async () => [
      { id: 'blocked-1', blocked: true },
      { id: 'gone-1', blocked: false },
    ],
    moveTo: async () => {},
    firstMessage: async (projectId, ticketId) => (ticketId === 'gone-1' ? undefined : 'never asked'),
  };
  const { dispatcher, orchestrator } = harness(
    [lane('In Progress', { agent: 'dev' })],
    { dispatcher: { pools: { default: { capacity: 2 } } } },
    feed,
    fake,
  );
  await orchestrator.wake('p');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(fake.prompts, [], 'the blocked ticket waits; the gone ticket never reaches a prompt');
  assert.equal(dispatcher.leases.held('default'), 0, 'the grant made for the gone ticket is given back');
});

test('a delegation takes a lease too: a full pool queues it, and the dispatcher ending a lease clears the claim visibly', async () => {
  const fake = fakeOpenCode();
  // The delegated tickets sit on the board where their delegators put them:
  // the fulfilment re-check reads the same board the walk would.
  const feed = boardFeed(fake, { 'In Progress': [{ id: 't-1' }, { id: 't-2' }, { id: 't-3' }] });
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('In Progress', { agent: 'dev' })],
    { dispatcher: { pools: { default: { capacity: 1 } } } },
    feed,
    fake,
  );
  const work = (ticketId: string) =>
    orchestrator.requestWork({
      projectId: 'p',
      trackerId: 'test-tracker',
      ticketId,
      lane: 'In Progress',
      agent: 'dev',
      directory: '/checkout',
      firstMessage: `delegated ${ticketId}`,
    });

  const first = await work('t-1');
  assert.equal(first.created, true);
  await until(() => fake.prompts.length === 1, 'the delegated worker starts');

  const second = await work('t-2');
  assert.ok(second.queued, 'a full pool queues the delegation: acceptance with a waiting id');
  assert.equal(ledger.activeByTicket('test-tracker', 't-2'), undefined, 'a queued delegation has no run yet');

  const third = await work('t-3');
  assert.equal(third.refused, 'waiting', 'one queue place per service per pool: t-3 is refused, never silent');
  assert.equal(ledger.activeByTicket('test-tracker', 't-3'), undefined);

  // The dispatcher ends the lease itself — the idle monitor or a boot
  // reconcile finding the session gone. The claim that mirrored it clears.
  const run = ledger.get(first.runId)!;
  const ended = await dispatcher.expire(run.leaseId!, 'idle beyond the timeout');
  assert.equal('ended' in ended, true);
  await until(() => ledger.get(first.runId)!.state === 'failed', 'the person hears that the worker died');
  const outcome = ledger.get(first.runId)!.outcome!;
  assert.equal(outcome.kind, 'failure', 'the claim clears as a failed run, never silence');
  assert.match('reason' in outcome ? outcome.reason : '', /The dispatcher ended the lease/);

  await until(() => fake.prompts.length === 2, 'the queue walks in when the slot opens');
  assert.match(fake.prompts[1]!.text, /delegated t-2/, 'the waiting delegation got the freed slot');
  const secondRun = ledger.activeByTicket('test-tracker', 't-2')!;
  assert.equal(secondRun.lane, 'In Progress');
  assert.equal(dispatcher.leases.held('default'), 1);
});

test('unlimited mode walks the whole board at once — capacity is not moderated without pools', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, {
    Todo: [{ id: 'q1' }, { id: 'q2' }],
    'In Progress': [{ id: 'w1' }],
  });
  const lanes = [lane('Todo', { queue: true }), lane('In Progress', { agent: 'dev' })];
  const { orchestrator } = harness(lanes, {}, feed, fake);
  await orchestrator.wake('p');
  await until(() => fake.prompts.length === 3, 'every eligible ticket gets its worker');
  const firsts = fake.prompts.map(p => p.text.split('\n')[0]);
  assert.deepEqual(firsts, ['do w1 in In Progress', 'do q1 in In Progress', 'do q2 in In Progress']);
  assert.deepEqual(feed.moves, ['move:q1->In Progress', 'move:q2->In Progress']);
});

test('an open elicitation holds its slot for the keep-alive, then gives the slot back with the session alive — and the answer resumes the same session', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, { Doing: [{ id: 't-1' }] });
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('Doing', { agent: 'dev', pool: 'a' })],
    { dispatcher: { pools: { a: { capacity: 1 } } }, orchestrator: { elicitationKeepAlive: '1s' } },
    feed,
    fake,
  );
  const { runId } = await orchestrator.requestWork({
    projectId: 'p',
    trackerId: 'test-tracker',
    ticketId: 't-1',
    lane: 'Doing',
    agent: 'dev',
    directory: '/checkout',
    firstMessage: 'do t-1 in Doing',
  });
  await until(() => fake.prompts.length === 1, 'the worker starts');
  const sessionId = ledger.get(runId)!.sessionId!;

  await orchestrator.askTool({ sessionId, input: { question: 'Which shade?' } });
  assert.equal(ledger.get(runId)!.state, 'awaiting_input', 'the run parks on the person');
  assert.equal(dispatcher.leases.held('a'), 1, 'the elicitation holds its slot');

  await until(() => dispatcher.leases.held('a') === 0, 'the keep-alive ends and the slot goes');
  const parked = ledger.get(runId)!;
  assert.equal(parked.state, 'awaiting_input', 'the wait goes on without the slot: the claim stands');
  assert.equal(parked.leaseId, undefined, 'no lease mirrors a slot that is gone');
  assert.deepEqual(fake.interrupted, [], 'released, not expired: nobody killed the worker');
  assert.ok(fake.sessions.has(sessionId), 'the session waits with its form');

  const form = fake.forms.find(f => f.sessionID === sessionId)!;
  const answered = await orchestrator.answer(sessionId, 'the deep one', form.id);
  assert.deepEqual(answered, { resumed: true }, 'a free slot lets the answer back at once');
  assert.equal(ledger.get(runId)!.state, 'working', 'the same session works again');
  assert.ok(ledger.get(runId)!.leaseId, 'the answer reacquired capacity — in a fresh lease');
  assert.match(fake.prompts.at(-1)!.text, /The person answered your question: the deep one/);
  assert.deepEqual(form.answered, { answer: 'the deep one' }, 'the form closes as the record');
});

test('the answer reacquires capacity in its own pool and waits there — the fallback never applies to a resume', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, {});
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('Doing', { agent: 'dev', pool: 'a' })],
    {
      dispatcher: { pools: { a: { capacity: 1, fallback: 'b' }, b: { capacity: 5 } } },
      orchestrator: { elicitationKeepAlive: '1s' },
    },
    feed,
    fake,
  );
  const first = await orchestrator.requestWork({
    projectId: 'p',
    trackerId: 'test-tracker',
    ticketId: 't-1',
    lane: 'Doing',
    agent: 'dev',
    directory: '/checkout',
    firstMessage: 'do t-1',
  });
  await until(() => fake.prompts.length === 1, 'the worker starts');
  const sessionId = ledger.get(first.runId)!.sessionId!;
  await orchestrator.askTool({ sessionId, input: { question: 'Which shade?' } });
  await until(() => dispatcher.leases.held('a') === 0, 'the keep-alive gives the slot back');
  const form = fake.forms.find(f => f.sessionID === sessionId)!;

  // Another ticket takes the opened slot before the answer arrives.
  const second = await orchestrator.requestWork({
    projectId: 'p',
    trackerId: 'test-tracker',
    ticketId: 't-2',
    lane: 'Doing',
    agent: 'dev',
    directory: '/checkout',
    firstMessage: 'do t-2',
  });
  await until(() => fake.prompts.length === 2, 'the next ticket works');

  const waiting = await orchestrator.answer(sessionId, 'the deep one', form.id);
  assert.ok('queued' in waiting, 'the answer waits for its slot instead of losing the worker');
  assert.equal(dispatcher.leases.held('a'), 1, 'the other ticket holds pool a');
  assert.equal(dispatcher.leases.held('b'), 0, 'pool b had five slots: the fallback is not a resume’s answer');
  assert.equal(ledger.get(first.runId)!.state, 'awaiting_input', 'the answer waits with the request');

  // The other ticket ends: the queue drains, and the resume walks into its own pool.
  await orchestrator.stop(second.runId, 'done with it');
  await until(() => ledger.get(first.runId)!.state === 'working', 'the answer resumed its session');
  assert.equal(dispatcher.leases.require(ledger.get(first.runId)!.leaseId!).pool, 'a');
  assert.match(fake.prompts.at(-1)!.text, /The person answered your question: the deep one/);
  assert.equal(dispatcher.leases.held('b'), 0, 'and still nobody moved pools');
});
