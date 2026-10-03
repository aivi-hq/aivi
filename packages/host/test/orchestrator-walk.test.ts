import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { configSchema, type Logger, type ProjectLane, type PromptName, readPrompt } from '@aivi/core';
import type { Tracker } from '@aivi/plugin';
import type { OpenCodeClient, SessionEvents } from '@aivi/plugin/module';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore } from '../src/dispatcher/leases.ts';
import { Forges } from '../src/forges.ts';
import { RunLedger } from '../src/orchestrator/ledger.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { Store } from '../src/store.ts';
import { ToolError } from '../src/tools.ts';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
/** A git read as its trimmed stdout, for assertions that speak in values. */
const gitOut = async (cwd: string, ...args: string[]): Promise<string> => (await git(cwd, ...args)).stdout.trim();

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
  /** The elicitations: askTool opens one, an answer closes it. The escalation
   *  form's title is recorded too: the words an edited `escalation` prompt
   *  speaks must be visible from here. */
  forms: { id: string; sessionID: string; title?: string; answered?: unknown }[];
  /** Test switches: OpenCode down at the exact moment of a prompt (the
   *  answer delivery's failure paths, ruled 2026-10-03). */
  ctl: { promptFails: boolean };
  /** Prompts OpenCode refused while `promptFails` stood: the test's signal
   *  that a delivery was attempted and failed. */
  rejected: string[];
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
    ctl: { promptFails: false },
    rejected: [],
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
        if (fake.ctl.promptFails) {
          fake.rejected.push(input.sessionID);
          throw new Error('OpenCode is down');
        }
        fake.prompts.push({ sessionID: input.sessionID, text: input.text });
      },
      form: {
        create: async (input: { sessionID: string; title?: string }) => {
          const id = `form_${fake.forms.length + 1}`;
          fake.forms.push({ id, sessionID: input.sessionID, ...(input.title ? { title: input.title } : {}) });
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

interface Scripted extends Tracker {
  /** Everything the walk did to the board: queue pickups arrive as moves. */
  moves: string[];
  /** How many prompts existed when each move was said — the proof of
   *  move-then-start: the lane says it before the worker does. */
  moveDepths: number[];
  /** Every stage call and move, in order: the proof of the operator's flow
   *  — open, ready, close, move — pinned without a platform. */
  stages: string[];
  retire(ticketId: string): void;
}

function boardFeed(fake: Fake, board: Record<string, { id: string; blocked?: boolean }[]>): Scripted {
  const lanes = new Map(Object.entries(board).map(([lane, tickets]) => [lane, tickets.map(t => ({ ...t }))]));
  const scripted: Scripted = {
    id: 'test-tracker',
    moves: [],
    moveDepths: [],
    stages: [],
    projects: () => ['p'],
    tickets: async (_projectId, state) =>
      (lanes.get(state) ?? []).map(t => ({ id: t.id, blocked: t.blocked ?? false })),
    moveTo: async (_projectId, ticketId, state) => {
      scripted.moves.push(`move:${ticketId}->${state}`);
      scripted.moveDepths.push(fake.prompts.length);
      scripted.stages.push(`move:${ticketId}->${state}`);
      for (const tickets of lanes.values()) {
        const at = tickets.findIndex(t => t.id === ticketId);
        if (at >= 0) tickets.splice(at, 1);
      }
      const entering = lanes.get(state) ?? [];
      entering.push({ id: ticketId });
      lanes.set(state, entering);
    },
    ticketLane: async (_projectId, ticketId) => {
      for (const [lane, tickets] of lanes) if (tickets.some(t => t.id === ticketId)) return lane;
      return undefined; // retired by a person: gone from the walked board
    },
    // The platform-side opening: the summary is the ticket's words, and the
    // orchestrator composes the worker's first prompt around it.
    initWork: async run => {
      scripted.stages.push(`init:${run.ticketId}`);
      return { summary: `do ${run.ticketId} in ${run.lane}`, branch: `me/${run.ticketId}` };
    },
    ready: run => {
      scripted.stages.push(`ready:${run.sessionId}`);
    },
    question: run => {
      scripted.stages.push(`question:${run.ticketId}`);
    },
    endWork: async run => {
      scripted.stages.push(`end:${run.ticketId}:${run.outcome?.kind ?? run.state}`);
    },
    retire: ticketId => {
      // What a person does after a stop: moves the ticket off the walked
      // board (or labels it for human hands) so the next pass asks for
      // another one. Stop itself remembers nothing (ruled 2026-10-02).
      for (const tickets of lanes.values()) {
        const at = tickets.findIndex(t => t.id === ticketId);
        if (at >= 0) tickets.splice(at, 1);
      }
    },
  };
  return scripted;
}

function harness(
  lanes: ProjectLane[],
  written: Record<string, unknown>,
  work: Tracker,
  fake = fakeOpenCode(),
  abort = new AbortController(),
  forges = new Forges(),
  directory: (projectId: string) => string = () => '/checkout',
  prompt?: (name: PromptName) => Promise<string>,
) {
  // The unit's clocks, in ms: a test that watches the keep-alive expire
  // writes `clocks: { keepAliveMs: 30 }` into the harness block instead of
  // a config duration — the strings are the person's surface, numbers are
  // the unit's. Whatever is left goes to the config schema untouched.
  const { clocks = {}, ...configWritten } = written as {
    clocks?: { idleMs?: number; prepareMs?: number; keepAliveMs?: number };
  } & Record<string, unknown>;
  const store = new Store(':memory:');
  const ledger = new RunLedger(store);
  const dispatcher = new Dispatcher({
    leases: new LeaseStore(store),
    dispatcher: configSchema.parse({ version: 1, ...configWritten }).dispatcher,
    idleMs: clocks.idleMs ?? 60_000,
    prepareMs: clocks.prepareMs ?? 300_000,
    opencode: async () => fake.client,
    signal: abort.signal,
    // The application's wiring: the dispatcher ends a lease, and the claim
    // that mirrored it clears through the orchestrator.
    onEnded: (lease, reason, code) => void orchestrator.leaseEnded(lease, reason, code),
  });
  const orchestrator = new Orchestrator({
    ledger,
    opencode: async () => fake.client,
    events: noEvents,
    log: quiet,
    signal: abort.signal,
    lanes: () => lanes,
    keepAliveMs: clocks.keepAliveMs ?? 300_000,
    directory,
    identity: async () => ({ name: 't', email: 't@t' }),
    dispatcher,
    forges,
    ...(prompt ? { prompt } : {}),
  });
  orchestrator.addTracker(work);
  return { ledger, dispatcher, orchestrator, fake, forges };
}

const lane = (name: string, extra: Partial<ProjectLane> = {}): ProjectLane => ({
  name,
  queue: false,
  worktree: false,
  ...extra,
});

const until = async (check: () => boolean, what: string, tries = 500) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise(r => setTimeout(r, 5));
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
  // exactly this reason (the real tracker-linear now does, ruled
  // 2026-10-03; the fake retires the ticket the same way the HITL label
  // does on a real board).
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
  assert.equal(fake.prompts.length, 2, 'd2 waits in the queue: one place per pool');
  for (const asked of ['do d1 in Doing', 'do l1 in Later'])
    assert.ok(
      fake.prompts.some(p => p.text.includes(asked)),
      `${asked} got its worker; the other waits`,
    );
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

test('blocked tickets wait, and a ticket gone by initWork fails its run visibly and gives its slot back', async () => {
  const fake = fakeOpenCode();
  const work: Tracker = {
    id: 'test-tracker',
    projects: () => ['p'],
    tickets: async () => [
      { id: 'blocked-1', blocked: true },
      { id: 'gone-1', blocked: false },
    ],
    moveTo: async () => {},
    ticketLane: async (_projectId, ticketId) => (ticketId === 'gone-1' ? undefined : 'In Progress'),
    initWork: async run => {
      if (run.ticketId === 'gone-1') throw new Error('the ticket is gone from the board (deleted by a person)');
      return { summary: 'never asked' };
    },
    ready: () => {},
    question: () => {},
    endWork: async () => {},
  };
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('In Progress', { agent: 'dev' })],
    { dispatcher: { pools: { default: { capacity: 2 } } } },
    work,
    fake,
  );
  await orchestrator.wake('p');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(fake.prompts, [], 'the blocked ticket waits; the gone ticket never reaches a prompt');
  assert.equal(dispatcher.leases.held('default'), 0, 'the grant made for the gone ticket is given back');
  const gone = ledger.activeByTicket('test-tracker', 'gone-1');
  assert.equal(gone, undefined, 'the claimed run ended and is not active');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(ledger.moveOwed('test-tracker').length, 0, 'a failed opening owes no move');
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
      summary: `delegated ${ticketId}`,
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
  const order = ['do w1 in In Progress', 'do q1 in In Progress', 'do q2 in In Progress'];
  assert.deepEqual(
    fake.prompts.map(p => order.filter(w => p.text.includes(w))[0]),
    order,
    'working tickets first, then the queue in board order — all at once',
  );
  assert.deepEqual(feed.moves, ['move:q1->In Progress', 'move:q2->In Progress']);
});

test('an open elicitation holds its slot for the keep-alive, then gives the slot back with the session alive — and the answer resumes the same session', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, { Doing: [{ id: 't-1' }] });
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('Doing', { agent: 'dev', pool: 'a' })],
    { dispatcher: { pools: { a: { capacity: 1 } } }, clocks: { keepAliveMs: 30 } },
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
    summary: 'do t-1 in Doing',
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
      clocks: { keepAliveMs: 30 },
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
    summary: 'do t-1',
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
    summary: 'do t-2',
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

test('an answer OpenCode will not take leaves the run parked: the books did not move, and the answer is giveable again', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, { Doing: [{ id: 't-1' }] });
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('Doing', { agent: 'dev', pool: 'a' })],
    { dispatcher: { pools: { a: { capacity: 1 } } }, clocks: { keepAliveMs: 30 } },
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
    summary: 'do t-1',
  });
  await until(() => fake.prompts.length === 1, 'the worker starts');
  const sessionId = ledger.get(runId)!.sessionId!;
  await orchestrator.askTool({ sessionId, input: { question: 'Which shade?' } });
  const form = fake.forms.find(f => f.sessionID === sessionId)!;
  const leaseId = ledger.get(runId)!.leaseId!;

  // OpenCode goes down at the exact moment of the answer.
  fake.ctl.promptFails = true;
  await assert.rejects(
    () => orchestrator.answer(sessionId, 'the deep one', form.id),
    'the failed delivery reaches the caller, who says it to the person',
  );
  const parked = ledger.get(runId)!;
  assert.equal(parked.state, 'awaiting_input', 'the books did not move: still parked on its form');
  assert.equal(parked.leaseId, leaseId, 'and it stands on the slot it had');
  assert.equal(form.answered, undefined, 'the question stands open: the answer is giveable again');

  // The re-armed keep-alive stands the wait as before — ring, slot back —
  // and a later answer lands on the same session.
  fake.ctl.promptFails = false;
  await until(() => dispatcher.leases.held('a') === 0, 'the re-armed keep-alive rang and gave the slot back');
  const answered = await orchestrator.answer(sessionId, 'the deep one', form.id);
  assert.deepEqual(answered, { resumed: true }, 'a later answer walks back into the same session');
  assert.match(fake.prompts.at(-1)!.text, /The person answered your question: the deep one/);
  assert.deepEqual(form.answered, { answer: 'the deep one' }, 'and the form closes as the record');
});

test('a queued answer whose delivery fails: the slot goes back, the run parks again — no silence bought', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, {});
  const { ledger, dispatcher, orchestrator } = harness(
    [lane('Doing', { agent: 'dev', pool: 'a' })],
    { dispatcher: { pools: { a: { capacity: 1 } } }, clocks: { keepAliveMs: 30 } },
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
    summary: 'do t-1',
  });
  await until(() => fake.prompts.length === 1, 'the worker starts');
  const sessionId = ledger.get(first.runId)!.sessionId!;
  await orchestrator.askTool({ sessionId, input: { question: 'Which shade?' } });
  await until(() => dispatcher.leases.held('a') === 0, 'the keep-alive gives the slot back');
  const form = fake.forms.find(f => f.sessionID === sessionId)!;

  // Another ticket takes the opened slot, so the answer queues for it.
  const second = await orchestrator.requestWork({
    projectId: 'p',
    trackerId: 'test-tracker',
    ticketId: 't-2',
    lane: 'Doing',
    agent: 'dev',
    directory: '/checkout',
    summary: 'do t-2',
  });
  await until(() => fake.prompts.length === 2, 'the next ticket works');
  const waiting = await orchestrator.answer(sessionId, 'the deep one', form.id);
  assert.ok('queued' in waiting, 'the answer waits for its slot');

  // The slot opens — and OpenCode is down at the delivery. Before the
  // 2026-10-03 ordering this was the stuck case: the books had flipped to
  // `working` before the prompt, the lease went back with the failure, and
  // nothing — no turn, no clock — would ever move the run again.
  fake.ctl.promptFails = true;
  await orchestrator.stop(second.runId, 'done with it');
  await until(() => fake.rejected.length === 1, 'the queued delivery was attempted and refused');
  const parked = ledger.get(first.runId)!;
  assert.equal(parked.state, 'awaiting_input', 'the books did not move: no working run with no lease and no clock');
  assert.equal(parked.leaseId, undefined, 'the reacquired slot went straight back');
  assert.equal(dispatcher.leases.held('a'), 0, 'the pool serves the board again');
  assert.equal(form.answered, undefined, 'the question stands open for the person to answer again');

  // And it does: the next answer lands on the same session.
  fake.ctl.promptFails = false;
  const answered = await orchestrator.answer(sessionId, 'the deep one', form.id);
  assert.deepEqual(answered, { resumed: true }, 'a later answer walks back into the same session');
  assert.ok(
    fake.prompts.some(p => p.text === 'The person answered your question: the deep one'),
    'the worker got the words',
  );
});

test('two answers in the same instant: both persons’ words reach the worker, the books flip once', async () => {
  const fake = fakeOpenCode();
  const feed = boardFeed(fake, { Doing: [{ id: 't-1' }] });
  const { ledger, orchestrator } = harness(
    [lane('Doing', { agent: 'dev', pool: 'a' })],
    { dispatcher: { pools: { a: { capacity: 1 } } }, clocks: { keepAliveMs: 30 } },
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
    summary: 'do t-1',
  });
  await until(() => fake.prompts.length === 1, 'the worker starts');
  const sessionId = ledger.get(runId)!.sessionId!;
  await orchestrator.askTool({ sessionId, input: { question: 'Which shade?' } });
  const form = fake.forms.find(f => f.sessionID === sessionId)!;

  // The same instant, twice: both deliveries pass the parked check before
  // either book flips. The ruling (2026-10-03) keeps both persons' words —
  // both are true answers — and the guard miss says so: the loser touches
  // the books, the clocks and the form not at all.
  const [first, second] = await Promise.all([
    orchestrator.answer(sessionId, 'the deep one', form.id),
    orchestrator.answer(sessionId, 'the deep one', form.id),
  ]);
  assert.deepEqual(first, { resumed: true });
  assert.deepEqual(second, { resumed: true }, 'both deliveries reached the worker');
  assert.equal(ledger.get(runId)!.state, 'working', 'the books flipped once and stand');
  assert.equal(
    fake.prompts.filter(p => p.text === 'The person answered your question: the deep one').length,
    2,
    'the worker reads both — by design, both are a person’s true words',
  );
  assert.deepEqual(form.answered, { answer: 'the deep one' }, 'the form closed once, as the record');
});

/** A forge backed by real git against a local-path remote: bytes really
 *  move, so the smart push is tested against real divergence — a fast-
 *  forward, a person's commit to merge, a conflict to resolve, a rebase to
 *  force — and not against a scripted opinion of any of them. */
/** The mutable review conversation behind the fake forge: threads a person
 *  (or the worker) resolves between reads, comments that ride the reads,
 *  and the posts the tools made. */
interface ReviewStore {
  threads: Map<string, { path?: string; question: string; resolved: boolean }>;
  comments: { login: string; body: string; createdAt: string }[];
  resolves: { threadId: string; text: string }[];
  plain: string[];
  reviews: unknown[];
}

function localForge(
  origin: string,
  seen: { pushes: { branch: string; lease?: string }[]; opens: string[] },
  prs: Map<string, string>,
  review?: ReviewStore,
) {
  return {
    async repoFor(project: { id: string }) {
      return project.id === 'site' ? { id: 'acme/site', remote: origin } : undefined;
    },
    async fetchBranch(_repo: unknown, directory: string, branch: string) {
      await exec('git', [
        '-C',
        directory,
        'fetch',
        '-q',
        origin,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]).catch(() => {});
    },
    async fetchRefs(_repo: unknown, directory: string) {
      await exec('git', ['-C', directory, 'fetch', '-q', '--prune', origin, '+refs/heads/*:refs/remotes/origin/*']);
    },
    async push(_repo: unknown, directory: string, branch: string, options?: { lease?: string }) {
      seen.pushes.push({ branch, ...(options?.lease ? { lease: options.lease } : {}) });
      await exec('git', [
        '-C',
        directory,
        'push',
        '-q',
        ...(options?.lease ? [`--force-with-lease=refs/heads/${branch}:${options.lease}`] : []),
        origin,
        `HEAD:refs/heads/${branch}`,
      ]);
    },
    async prForBranch(_repo: unknown, branch: string) {
      const state = prs.get(branch);
      return state
        ? { id: 'pr-1', url: `https://github.com/acme/site/pull/1`, title: 'Widget', state, branch }
        : undefined;
    },
    async openPr(_repo: unknown, branch: string) {
      seen.opens.push(branch);
      prs.set(branch, 'open');
      return { id: 'pr-1', url: 'https://github.com/acme/site/pull/1', title: 'Widget', state: 'open', branch };
    },
    ...(review
      ? {
          async reviewFeedback(
            _repo: unknown,
            pr: { id: string; url: string; title: string; state: string; branch: string },
          ) {
            return {
              pr: { ...pr, mergeable: 'clean' },
              reviews: [],
              threads: [...review.threads].flatMap(([id, t]) =>
                t.resolved
                  ? []
                  : [{ id, ...(t.path ? { path: t.path } : {}), state: 'open', question: t.question, replies: [] }],
              ),
              comments: review.comments.map(c => ({
                author: { login: c.login, bot: c.login.endsWith('[bot]') },
                body: c.body,
                createdAt: c.createdAt,
              })),
            };
          },
          async resolveThread(_repo: unknown, _pr: unknown, threadId: string, reply: { text: string }) {
            const thread = review.threads.get(threadId);
            if (!thread || thread.resolved) throw new Error(`no open thread ${threadId}`);
            thread.resolved = true;
            review.resolves.push({ threadId, text: reply.text });
          },
          async commentPr(_repo: unknown, _pr: unknown, comment: { text: string }) {
            review.plain.push(comment.text);
          },
          async submitReview(_repo: unknown, _pr: unknown, submitted: unknown) {
            review.reviews.push(submitted);
          },
        }
      : {}),
  };
}

/** A project, a run on a ticket branch, and the git tools' registry. */
/** The two repository fixtures, each built once per file run and copied per
 *  test: a fixture that pays eleven `git` spawns per test pays them for
 *  nothing — a copy plus one `remote set-url` (the copy's `origin` must name
 *  its own upstream) is the same starting point. Real git stays where it
 *  earns its keep: the merges, conflicts and pushes the assertions watch.
 */
async function buildRepo(name: string, branch: string, widget: boolean) {
  const root = await mkdtemp(join(tmpdir(), `aivi-${name}-template-`));
  const upstream = join(root, 'upstream');
  await mkdir(upstream);
  await writeFile(join(upstream, 'README.md'), 'one');
  await git(upstream, 'init', '-q', '-b', 'main');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'one');
  const source = join(root, 'site');
  await git(root, 'clone', '-q', 'upstream', 'site');
  // A GitHub clone carries `origin/HEAD`; say it by hand, and give the
  // checkout an identity: a merge commit needs one, as in real life (the
  // worktree mark or the person's own config).
  await git(source, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(source, 'config', 'user.email', 'dev@example.com');
  await git(source, 'config', 'user.name', 'Dev');
  await git(source, 'checkout', '-q', '-b', branch);
  if (widget) {
    await writeFile(join(source, 'widget.md'), 'a widget');
    await git(source, 'add', '.');
    await git(source, 'commit', '-q', '-m', 'the widget');
  }
  return root;
}

/** The template as a fresh copy, `origin` re-pointed at its own upstream. */
async function copiedRepo(template: Promise<string>, name: string, t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), `aivi-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(await template, root, { recursive: true });
  const upstream = join(root, 'upstream');
  await git(join(root, 'site'), 'remote', 'set-url', 'origin', upstream);
  return { root, upstream, source: join(root, 'site') };
}

const pushTemplate = buildRepo('push', 'me/eng-9-widget', true);
const gateTemplate = buildRepo('gate', 'me/t-gate', false);

async function pushFixture(t: { after: (fn: () => Promise<unknown>) => void }, name: string) {
  const { root, upstream, source } = await copiedRepo(pushTemplate, name, t);

  const fake = fakeOpenCode();
  const lanes = [lane('In Progress', { agent: 'dev' })];
  const forges = new Forges();
  const { ledger, orchestrator } = harness(lanes, {}, boardFeed(fake, {}), fake, new AbortController(), forges);
  const { run } = ledger.request({
    projectId: 'site',
    trackerId: 'linear',
    ticketId: 't-pr',
    lane: 'In Progress',
    agent: 'dev',
  });
  ledger.attachSession(run.id, 'ses_git', source);
  const call = (input: Record<string, unknown>) => ({ sessionId: 'ses_git', input });
  return { root, upstream, source, forges, orchestrator, call };
}

test('no forge is a plain answer, not a failure: every git tool says who is missing', async t => {
  const { orchestrator, call } = await pushFixture(t, 'noforge');
  for (const [tool, input] of [
    [orchestrator.pushTool, {}],
    [orchestrator.syncTool, {}],
    [orchestrator.prTool, { title: 'Widget' }],
  ] as const)
    await assert.rejects(
      () => tool(call(input)),
      (error: unknown) => error instanceof ToolError && /no forge for its remote/.test(String(error)),
      'a research project gets its plain answer',
    );
});

test('aivi_push fast-forwards, refuses to repeat itself, merges a person’s work in, and lets a conflict be resolved', async t => {
  const { root, upstream, source, forges, orchestrator, call } = await pushFixture(t, 'pushflow');
  const seen = { pushes: [] as { branch: string; lease?: string }[], opens: [] as string[] };
  const prs = new Map<string, string>();
  forges.register(localForge(join(root, 'upstream'), seen, prs) as never);

  const first = await orchestrator.pushTool(call({}));
  assert.deepEqual(first, { pushed: true, branch: 'me/eng-9-widget' });
  assert.equal(
    await gitOut(upstream, 'rev-parse', 'refs/heads/me/eng-9-widget'),
    await gitOut(source, 'rev-parse', 'HEAD'),
    'the fast-forward moved the remote branch',
  );

  await assert.rejects(
    () => orchestrator.pushTool(call({})),
    (error: unknown) => error instanceof ToolError && /Nothing to push/.test(String(error)),
    'every commit is already there: said, not pushed twice',
  );

  // A person pushes to the branch from their own clone, and the worker has
  // a commit of its own: real divergence, safely mergeable.
  const person = join(root, 'person');
  await git(root, 'clone', '-q', 'upstream', 'person');
  await git(person, 'checkout', '-q', '-b', 'me/eng-9-widget', 'origin/me/eng-9-widget');
  await writeFile(join(person, 'note.md'), 'the person’s note\n');
  await git(person, 'add', '.');
  await git(person, 'commit', '-q', '-m', 'a note from the person');
  await git(person, 'push', '-q', 'origin', 'me/eng-9-widget');
  await writeFile(join(source, 'mine.md'), 'mine\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '-m', 'my commit');

  const merged = await orchestrator.pushTool(call({}));
  assert.deepEqual(merged, { pushed: true, branch: 'me/eng-9-widget' }, 'safely mergeable: merged in and pushed');
  assert.equal(
    await gitOut(upstream, 'show', 'me/eng-9-widget:note.md'),
    'the person’s note',
    'the person’s work stands on the remote, not overwritten',
  );

  // And a real conflict: both sides edit the same line. The person pulls
  // the worker's merge in first, then disagrees.
  await git(person, 'pull', '-q', '--rebase', 'origin', 'me/eng-9-widget');
  await writeFile(join(person, 'widget.md'), 'the person’s widget');
  await git(person, 'commit', '-q', '-am', 'the person disagrees');
  await git(person, 'push', '-q', 'origin', 'me/eng-9-widget');
  await writeFile(join(source, 'widget.md'), 'my widget');
  await git(source, 'commit', '-q', '-am', 'I disagree');
  await assert.rejects(
    () => orchestrator.pushTool(call({})),
    (error: unknown) =>
      error instanceof ToolError && /conflicts in widget\.md/.test(String(error)) && /resolve them/.test(String(error)),
    'the conflict is named, with the file',
  );
  assert.ok(
    (await git(source, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')).stdout.trim(),
    'the merge stays in progress for the worker to resolve',
  );
  await writeFile(join(source, 'widget.md'), 'our widget');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '--no-edit');
  const resolved = await orchestrator.pushTool(call({}));
  assert.deepEqual(resolved, { pushed: true, branch: 'me/eng-9-widget' }, 'resolved, committed, pushed');
});

test('a rebased branch pushes through: the rewrite is patch-equivalent, so the force goes through quietly', async t => {
  const { root, upstream, source, forges, orchestrator, call } = await pushFixture(t, 'rebase');
  const seen = { pushes: [] as { branch: string; lease?: string }[], opens: [] as string[] };
  const prs = new Map<string, string>();
  forges.register(localForge(join(root, 'upstream'), seen, prs) as never);
  await orchestrator.pushTool(call({}));

  // main moves under the branch; the worker syncs, then rebases with its
  // own git.
  await git(upstream, 'commit', '-q', '--allow-empty', '-m', 'main moved');
  await orchestrator.syncTool(call({}));
  await git(source, 'rebase', '-q', 'origin/main');

  const moved = await orchestrator.pushTool(call({}));
  assert.deepEqual(moved, { pushed: true, branch: 'me/eng-9-widget' }, 'the rebase re-push is not chatter');
  const rewrite = seen.pushes.at(-1)!;
  assert.ok(rewrite.lease, 'the force rode a lease keyed on the fetched tip: a person’s newer commit could not burn');
  assert.equal(
    await gitOut(upstream, 'log', '-1', '--format=%s', 'me/eng-9-widget'),
    'the widget',
    'the rewritten branch stands on the remote',
  );
});

test('aivi_sync answers behind and ahead through the forge, and guards name what a pull request cannot stand for', async t => {
  const { root, upstream, source, forges, orchestrator, call } = await pushFixture(t, 'sync');
  const seen = { pushes: [] as { branch: string; lease?: string }[], opens: [] as string[] };
  const prs = new Map<string, string>();
  forges.register(localForge(join(root, 'upstream'), seen, prs) as never);

  const absent = await orchestrator.syncTool(call({}));
  assert.deepEqual(absent, { synced: true, branch: 'me/eng-9-widget', remoteBranch: 'absent' });

  await orchestrator.pushTool(call({}));
  const person = join(root, 'person');
  await git(root, 'clone', '-q', 'upstream', 'person');
  await git(person, 'checkout', '-q', '-b', 'me/eng-9-widget', 'origin/me/eng-9-widget');
  await writeFile(join(person, 'their.md'), 'theirs\n');
  await git(person, 'add', '.');
  await git(person, 'commit', '-q', '-m', 'their commit');
  await git(person, 'push', '-q', 'origin', 'me/eng-9-widget');
  await writeFile(join(source, 'mine.md'), 'mine\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '-m', 'my commit');
  // And main moved under everyone: worth saying before a rebase is weighed.
  await git(upstream, 'commit', '-q', '--allow-empty', '-m', 'main moved');

  const counts = await orchestrator.syncTool(call({}));
  assert.deepEqual(counts, {
    synced: true,
    branch: 'me/eng-9-widget',
    behind: '1',
    ahead: '1',
    defaultBranch: 'main',
    defaultBehind: '1',
  });

  // The guards the smart push never bargains past.
  await git(source, 'checkout', '-q', 'main');
  await assert.rejects(
    () => orchestrator.pushTool(call({})),
    (error: unknown) => error instanceof ToolError && /default branch/.test(String(error)),
  );
  // Detached HEAD: the same story, git's own words.
  await git(source, 'checkout', '-q', await gitOut(source, 'rev-parse', 'HEAD'), '--detach');
  await assert.rejects(
    () => orchestrator.pushTool(call({})),
    (error: unknown) => error instanceof ToolError && /detached HEAD/.test(String(error)),
  );
});

test('aivi_pr opens the pull request, answers an open one instead of doubling it, and opens fresh after a merge', async t => {
  const { root, upstream, source, forges, orchestrator, call } = await pushFixture(t, 'prtoll');
  const seen = { pushes: [] as { branch: string; lease?: string }[], opens: [] as string[] };
  const prs = new Map<string, string>();
  forges.register(localForge(join(root, 'upstream'), seen, prs) as never);

  const opened = await orchestrator.prTool(call({ title: 'Widget', body: 'Adds the widget.' }));
  assert.deepEqual(opened, { pushed: true, pull: 'https://github.com/acme/site/pull/1', state: 'open' });
  assert.deepEqual(seen.opens, ['me/eng-9-widget'], 'the forge opened it, and the push came first');

  await writeFile(join(source, 'more.md'), 'more\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '-m', 'follow-up work');
  const again = await orchestrator.prTool(call({ title: 'Widget' }));
  assert.deepEqual(again, { pull: 'https://github.com/acme/site/pull/1', state: 'open', commitsPushed: true });
  assert.deepEqual(seen.opens, ['me/eng-9-widget'], 'one pull request over a branch is enough');

  // The person merges; the ticket reopens with new work: a fresh pull request.
  prs.set('me/eng-9-widget', 'merged');
  await assert.rejects(
    () => orchestrator.prTool(call({ title: 'Widget' })),
    (error: unknown) => error instanceof ToolError && /no new commits/.test(String(error)),
    'nothing new to stand for: said, not doubled',
  );
  await writeFile(join(source, 'round-two.md'), 'again\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '-m', 'round two');
  await orchestrator.prTool(call({ title: 'Widget again', body: 'The second round.' }));
  assert.equal(prs.get('me/eng-9-widget'), 'open');
  assert.deepEqual(seen.opens, ['me/eng-9-widget', 'me/eng-9-widget'], 'merged + new commits: a fresh pull request');
  void upstream;
});

test('a worktree lane gets its own git worktree on the ticket’s branch, crossing to origin only through the injected forge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-wt-lane-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'README.md'), 'one');
  await git(source, 'init', '-q', '-b', 'main');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '-m', 'one');

  const fetches: string[] = [];
  const forges = new Forges();
  forges.register({
    async repoFor(project: { id: string }) {
      return project.id === 'p' ? { id: 'acme/site', remote: 'https://github.com/acme/site' } : undefined;
    },
    async fetchBranch(_repo: unknown, _directory: string, branch: string) {
      fetches.push(branch);
    },
  } as never);

  const fake = fakeOpenCode();
  const feed = boardFeed(fake, { Todo: [{ id: 't-1' }] });
  const lanes = [lane('Todo', { queue: true }), lane('In Progress', { agent: 'dev', worktree: true })];
  const { ledger, orchestrator } = harness(
    lanes,
    { dispatcher: { pools: { default: { capacity: 1 } } } },
    feed,
    fake,
    new AbortController(),
    forges,
    () => source,
  );
  await orchestrator.wake('p');
  // A real git fixture on disk: roomier than the in-memory walks' budget.
  await until(() => fake.prompts.length === 1, 'the queued ticket starts in the worktree lane', 3000);

  const run = ledger.activeByTicket('test-tracker', 't-1')!;
  assert.ok(run.worktree, 'the run records where the worker works');
  assert.ok(run.worktree!.startsWith(`${join(root, 'worktrees')}/`), run.worktree);
  assert.equal((await git(run.worktree!, 'symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trim(), 'me/t-1');
  assert.equal(await readFile(join(run.worktree!, 'README.md'), 'utf8'), 'one', 'made from the refs the clone holds');
  assert.deepEqual(fetches, ['me/t-1'], 'the crossing to origin went through the forge, injected');
  assert.match(fake.prompts[0]!.text, /git worktree of the project at/);
  assert.ok(
    [...fake.sessions.values()].some(s => s.directory === run.worktree),
    'the session was created in the worktree, not the checkout',
  );
});

test('a worktree lane whose tracker named no branch fails the run visibly and says so', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-wt-nobran-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeOpenCode();
  const work: Tracker = {
    id: 'test-tracker',
    projects: () => ['p'],
    tickets: async () => [{ id: 't-2', blocked: false }],
    moveTo: async () => {},
    ticketLane: async () => 'In Progress',
    initWork: async () => ({ summary: 'no branch here' }),
    ready: () => {},
    question: () => {},
    endWork: async () => {},
  };
  const { ledger, orchestrator } = harness(
    [lane('In Progress', { agent: 'dev', worktree: true })],
    { dispatcher: { pools: { default: { capacity: 2 } } } },
    work,
    fake,
    new AbortController(),
    new Forges(),
    () => join(root, 'nothing'),
  );
  await orchestrator.wake('p');
  await until(() => ledger.terminalSince('test-tracker', 0).length === 1, 'the run ended visibly');
  const ended = ledger.terminalSince('test-tracker', 0)[0]!;
  assert.equal(ended.state, 'failed');
  assert.equal(ended.outcome?.kind, 'failure');
  assert.match(ended.outcome?.kind === 'failure' ? ended.outcome.reason : '', /named no branch/);
  assert.deepEqual(fake.prompts, [], 'the worker was never started in a directory nobody named');
});

/** The full walk with a forge that answers review: the run starts through
 *  the board (so the gather at start really fires), the checkout directory
 *  is real git, and the review conversation is mutable between reads. */
async function gateFixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  name: string,
  openThreads: Record<string, { path?: string; question: string }>,
  prompt?: (name: PromptName) => Promise<string>,
) {
  const { root, upstream, source } = await copiedRepo(gateTemplate, name, t);
  // The run works in the checkout, on the ticket's branch: that is the
  // branch the gate and the review tools ask the forge about.

  const fake = fakeOpenCode();
  const lanes = [lane('Todo', { queue: true }), lane('In Progress', { agent: 'dev' })];
  const feed = boardFeed(fake, { 'In Progress': [{ id: 't-gate' }] });
  const work = { ...feed, projects: () => ['site'] };
  const forges = new Forges();
  const review: ReviewStore = {
    threads: new Map(Object.entries(openThreads).map(([id, t]) => [id, { ...t, resolved: false }])),
    comments: [],
    resolves: [],
    plain: [],
    reviews: [],
  };
  const seen = { pushes: [] as { branch: string; lease?: string }[], opens: [] as string[] };
  forges.register(localForge(upstream, seen, new Map([['me/t-gate', 'open']]), review) as never);
  const { ledger, orchestrator } = harness(lanes, {}, work, fake, new AbortController(), forges, () => source, prompt);
  await orchestrator.wake('site');
  await until(() => fake.prompts.length === 1, 'the worker starts with its ticket');
  const run = ledger.active()[0]!;
  return {
    root,
    upstream,
    source,
    fake,
    ledger,
    orchestrator,
    feed,
    review,
    seen,
    run,
    call: (input: Record<string, unknown>) => ({ sessionId: run.sessionId!, input }),
  };
}

test('a returning ticket is told what it owes; the gate refuses until it is answered, and the third refusal asks a person', async t => {
  const g = await gateFixture(t, 'gate', { PRRT_1: { path: 'src/header.ts', question: 'Why is this nil?' } });

  // The start: the snapshot is the whole bookkeeping, the guidance rides the prompt.
  assert.match(g.fake.prompts[0]!.text, /returning work/, 'the first prompt says this is returning work');
  assert.match(g.fake.prompts[0]!.text, /Why is this nil\?/, 'and names what is owed');
  assert.deepEqual(g.ledger.get(g.run.id)!.feedback, { openThreadIds: ['PRRT_1'], attempts: 0, escalated: false });

  // Refusals count, and teach the loop in their own words.
  for (const strike of [1, 2]) {
    await assert.rejects(
      () => g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'done' })),
      (error: unknown) =>
        error instanceof ToolError &&
        /owe answers/.test(String(error)) &&
        new RegExp(`${strike} of 3`).test(String(error)),
      `refusal ${strike} says so`,
    );
    assert.equal(g.ledger.get(g.run.id)!.feedback?.attempts, strike);
  }

  // The third: the person is asked — the same durable form aivi_ask makes.
  await assert.rejects(
    () => g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'done' })),
    (error: unknown) => error instanceof ToolError && /person has been asked/.test(String(error)),
  );
  assert.equal(g.fake.forms.length, 1, 'the escalation form stands');
  assert.equal(g.ledger.get(g.run.id)!.state, 'awaiting_input', 'the run parks on the person');
  assert.equal(g.ledger.get(g.run.id)!.feedback?.escalated, true);

  // Never doubled.
  await assert.rejects(
    () => g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'done' })),
    (error: unknown) => error instanceof ToolError && /asked once/.test(String(error)),
  );
  assert.equal(g.fake.forms.length, 1, 'one escalation form per run');

  // The person answers: the strikes reset — "try again with these instructions".
  const formId = g.ledger.get(g.run.id)!.feedback!.formId!;
  const answered = await g.orchestrator.answer(g.run.sessionId!, 'resolve them with a note and ship it', formId);
  assert.deepEqual(answered, { resumed: true });
  assert.deepEqual(g.ledger.get(g.run.id)!.feedback, {
    openThreadIds: ['PRRT_1'],
    attempts: 0,
    escalated: true,
    formId,
  });

  // A person resolving the thread on the platform is authoritative: the gate lets it through.
  g.review.threads.get('PRRT_1')!.resolved = true;
  g.feed.retire('t-gate');
  const ended = await g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'done' }));
  assert.deepEqual(ended, { recorded: true, outcome: 'success' });
});

test('a run that started clean is never chased by feedback arriving mid-run: the reviewing agent posts and finishes', async t => {
  const g = await gateFixture(t, 'clean', {});
  assert.ok(!g.fake.prompts[0]!.text.includes('returning work'), 'a clean start carries no guidance paragraph');
  assert.equal(g.ledger.get(g.run.id)!.feedback, undefined, 'and no snapshot');

  // The review agent posts its findings (threads appear mid-run) and completes
  // freely: those threads are not owed, or it could never finish its own job.
  g.review.threads.set('PRRT_new', { path: 'src/x.ts', question: 'Unbounded loop', resolved: false });
  const ended = await g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'findings posted' }));
  assert.deepEqual(ended, { recorded: true, outcome: 'success' });
});

test('a worker giving up does not have to answer reviewers to hand the ticket back', async t => {
  const g = await gateFixture(t, 'exempt', { PRRT_1: { path: 'a.ts', question: 'Fix this' } });
  const ended = await g.orchestrator.completeTool(g.call({ outcome: 'failure', summary: 'stuck' }));
  assert.deepEqual(ended, { recorded: true, outcome: 'failure' });
  assert.deepEqual(g.review.resolves, [], 'nothing was answered to pass the failure through');
});

test('aivi_review shows what the gate checks, aivi_respond_feedback answers or comments, aivi_submit_review posts findings', async t => {
  const g = await gateFixture(t, 'voice', { PRRT_1: { path: 'src/header.ts', question: 'Why is this nil?' } });

  const facts = (await g.orchestrator.reviewTool(g.call({}))) as {
    pull: string;
    mergeable: string;
    threads: { id: string; question: string }[];
  };
  assert.equal(facts.pull, 'https://github.com/acme/site/pull/1');
  assert.equal(facts.mergeable, 'clean');
  assert.equal(facts.threads[0]!.id, 'PRRT_1');

  // Answer the thread: signed reply, resolved — agree or disagree, both end resolved.
  await g.orchestrator.respondTool(g.call({ threadId: 'PRRT_1', body: 'It is nil until the retry lands.' }));
  assert.deepEqual(g.review.resolves, [{ threadId: 'PRRT_1', text: 'It is nil until the retry lands.' }]);
  await assert.rejects(
    () => g.orchestrator.respondTool(g.call({ threadId: 'PRRT_1', body: 'answering again' })),
    (error: unknown) => error instanceof ToolError && /not open/.test(String(error)),
    'a resolved thread is not answerable: the person who resolved it is authoritative',
  );

  // Without a thread: a plain comment, context only.
  await g.orchestrator.respondTool(g.call({ body: 'Rebased over main.' }));
  assert.deepEqual(g.review.plain, ['Rebased over main.']);

  // The review agent's voice, with the posture in its own args.
  await g.orchestrator.submitReviewTool(
    g.call({
      body: 'Two problems',
      state: 'REQUEST_CHANGES',
      findings: [{ path: 'src/x.ts', line: 7, body: 'Unbounded' }],
    }),
  );
  assert.deepEqual(g.review.reviews, [
    {
      author: 'dev',
      body: 'Two problems',
      state: 'REQUEST_CHANGES',
      comments: [{ path: 'src/x.ts', line: 7, body: 'Unbounded' }],
    },
  ]);
  await assert.rejects(
    () => g.orchestrator.submitReviewTool(g.call({ body: 'ship it', state: 'APPROVE' })),
    (error: unknown) => error instanceof ToolError && /COMMENT or REQUEST_CHANGES/.test(String(error)),
    'approval is not a thing aivi can post',
  );
});

test('the operator’s edited prompts are the words the run speaks: read at use, slot by slot', async t => {
  const words = await mkdtemp(join(tmpdir(), 'aivi-words-'));
  t.after(() => rm(words, { recursive: true, force: true }));
  await mkdir(join(words, 'prompts'));
  await writeFile(
    join(words, 'prompts', 'worker-contract.md'),
    'Work gently in {directory}. Finish with the completion tool.\n',
  );
  await writeFile(
    join(words, 'prompts', 'feedback-loop.md'),
    'The reviewers spoke first on {pull}. Answer each in the thread.\n',
  );
  await writeFile(join(words, 'prompts', 'escalation.md'), 'Human: {pull} still owes:\n{list}\nYour call?\n');
  await writeFile(join(words, 'prompts', 'review-posture.md'), 'Nudge gently at review time.\n');

  const g = await gateFixture(t, 'words', { PRRT_1: { path: 'a.ts', question: 'Why is this nil?' } }, name =>
    readPrompt(words, name),
  );
  const first = g.fake.prompts[0]!.text;
  assert.ok(first.includes(`Work gently in ${g.source}.`), 'the edited contract speaks, slot filled by composition');
  assert.ok(
    !first.includes('aivi_work_complete with outcome'),
    'the built-in contract is gone when the file replaces it',
  );
  assert.match(
    first,
    /The reviewers spoke first on https:\/\/github\.com\/acme\/site\/pull\/1/,
    'the edited feedback-loop opens',
  );
  assert.match(
    first,
    /- \[PRRT_1\] a\.ts: Why is this nil\?/,
    'and the facts still ride under it: composition stays code',
  );
  assert.match(first, /Nudge gently at review time/, 'the edited posture line rides too');
  assert.match(first, /pull request body for a human reviewer/, 'an unedited name keeps its built-in beside them');

  // The third refusal asks the person in the operator's words, slots and all.
  await assert.rejects(() => g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'x' })));
  await assert.rejects(() => g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'x' })));
  await assert.rejects(() => g.orchestrator.completeTool(g.call({ outcome: 'success', summary: 'x' })));
  assert.equal(g.fake.forms.length, 1, 'the escalation form stands');
  const title = g.fake.forms[0]!.title ?? '';
  assert.match(title, /^Human: https:\/\/github\.com\/acme\/site\/pull\/1 still owes:/, 'the edited escalation asks');
  assert.match(title, /- a\.ts: Why is this nil\? \(id PRRT_1\)/, 'with the owed list in place');
});
