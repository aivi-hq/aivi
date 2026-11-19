import { mock } from 'node:test';
import type { Logger, ProjectLane, PromptName } from '@aivi/core';
import type { Forge, ForgeProject, PrFacts, RepoRef, ReviewFacts } from '@aivi/plugin/forge';
import type { OpenCodeClient, SessionEventListener } from '@aivi/plugin/module';
import type { RunPlan, RunQuestion, RunView, WorkRequest } from '@aivi/plugin/run';
import type { Tracker, WorkEntry } from '@aivi/plugin/tracker';
import { boundary } from '../../voice/test/boundary.ts';
import type { Dispatcher, DispatcherLease } from '../src/dispatcher/dispatcher.ts';
import { Forges } from '../src/forges.ts';
import { RunLedger } from '../src/orchestrator/ledger.ts';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator/orchestrator.ts';
import { Store } from '../src/store.ts';

/**
 * The orchestrator over targeted stand-ins: a dispatcher that grants what the
 * test scripts, a tracker whose stages are mock functions, an OpenCode
 * client that records what it was sent, and a log that keeps its lines. The
 * ledger is real (in-memory SQLite): the run's state machine is the point.
 * Every stand-in call is a `watched` mock: `.mock.calls` says what happened,
 * and `.next()` waits for the next call nobody has read yet, so a test waits
 * for the operation itself and never sleeps.
 */

/** A mock function whose calls can be waited on: `next()` resolves with the
 *  arguments of the next call nobody has read yet, made or still to come.
 *  `does` changes the answer from then on and keeps the boundary. */
export function watched<A extends unknown[], R>(impl: (...args: A) => R) {
  const reached = boundary<A>();
  let answer = impl;
  const fn = mock.fn((...args: A): R => {
    reached.reach(...args);
    return answer(...args);
  });
  return Object.assign(fn, {
    next: reached.next,
    does: (replacement: (...args: A) => R) => {
      answer = replacement;
    },
  });
}

/** What a mock was called with, call by call. */
export const calls = <A extends unknown[]>(fn: { mock: { calls: { arguments: A }[] } }): A[] =>
  fn.mock.calls.map(call => call.arguments);

/** An answer that refuses, for a stand-in to give from then on: `does(fails(error))`. */
export const fails = (failure: Error) => async (): Promise<never> => {
  throw failure;
};

type Line = Record<string, unknown>;

/** A logger that keeps its lines, as `recorder()` does, but `next(event)`
 *  settles with the next unread line of that event: the same event can be
 *  waited on again. */
function trail() {
  const lines: Line[] = [];
  const reached = new Map<string, ReturnType<typeof boundary<[Line]>>>();
  const at = (event: string) => reached.get(event) ?? reached.set(event, boundary<[Line]>()).get(event)!;
  const say = (level: string) => (event: string, fields?: Line) => {
    const line = { ...fields, level, event };
    lines.push(line);
    at(event).reach(line);
  };
  const log = {
    debug: say('debug'),
    info: say('info'),
    warn: say('warn'),
    error: say('error'),
    getChild: () => log,
    with: () => log,
  } as unknown as Logger;
  return {
    log,
    said: (level: string) => lines.filter(line => line.level === level),
    next: async (event: string) => (await at(event).next())[0],
  };
}

type Grant = ReturnType<Dispatcher['request']>;
type Hear = (requestId: string, lease: DispatcherLease) => void;

/** The part of the dispatcher the orchestrator talks to. `request` answers
 *  from `script` (a lease when the script is empty); `fulfil` is the
 *  dispatcher telling the orchestrator that a waiting request became a
 *  lease. A released lease is gone, and releasing it again rejects, as the
 *  real one does. */
function fakeDispatcher() {
  let minted = 0;
  let hear: Hear = () => {};
  const held = new Map<string, DispatcherLease>();
  const script: Grant[] = [];
  const grant = (input: { pool?: string; resume?: string }): DispatcherLease => {
    const lease: DispatcherLease = {
      id: `lease_${++minted}`,
      kind: 'session',
      service: 'orchestrator',
      pool: input.pool ?? 'default',
      state: 'preparing',
      activityAt: 0,
      createdAt: 0,
    };
    held.set(lease.id, lease);
    return lease;
  };
  const dispatcher = {
    leases: { get: (leaseId: string) => held.get(leaseId) },
    registerCallback: (_service: string, callback: Hear) => {
      hear = callback;
    },
    request: watched((input: { service: string; pool?: string; resume?: string }): Grant => {
      return script.shift() ?? { lease: grant(input) };
    }),
    provide: watched(async (leaseId: string, _work: { agent: string; directory: string }) => {
      const lease: DispatcherLease = { ...held.get(leaseId)!, state: 'active', sessionId: `ses_${leaseId}` };
      held.set(leaseId, lease);
      return lease;
    }),
    release: watched(async (leaseId: string) => {
      const lease = held.get(leaseId);
      if (!lease) throw new Error(`Lease ${leaseId} was already gone`);
      held.delete(leaseId);
      return { ended: lease };
    }),
    cancel: watched((_requestId: string) => {}),
    activity: watched((_leaseId: string) => {}),
  };
  return Object.assign(dispatcher, {
    held,
    script,
    grant,
    fulfil: (requestId: string, lease: DispatcherLease = grant({})) => {
      hear(requestId, lease);
      return lease;
    },
  });
}

/** The ticket desk is required of every tracker; the orchestrator never calls it. */
const noDesk = (): never => {
  throw new Error('the ticket desk is not the orchestrator’s');
};

/** A tracker whose every stage is a mock. The board is empty and the ticket
 *  always sits in the lane `Doing`. */
function fakeTracker(id = 'test-tracker') {
  return {
    id,
    desk: {
      read: noDesk,
      comments: noDesk,
      labels: noDesk,
      edit: noDesk,
      comment: noDesk,
      create: noDesk,
      label: noDesk,
    },
    projects: () => ['p'],
    tickets: watched(async (_project: string, _lane: string): Promise<{ id: string; blocked: boolean }[]> => []),
    moveTo: watched(async (_project: string, _ticket: string, _lane: string): Promise<void> => {}),
    ticketLane: watched(async (_project: string, _ticket: string): Promise<string | undefined> => 'Doing'),
    initWork: watched(async (run: RunView): Promise<WorkEntry> => ({ summary: `do ${run.ticketId}` })),
    ready: watched((_run: RunView): void => {}),
    startWork: watched((_run: RunView): void => {}),
    question: watched((_run: RunView, _question: RunQuestion): void => {}),
    plan: watched((_run: RunView, _plan: RunPlan): void => {}),
    endWork: watched(async (_run: RunView): Promise<void> => {}),
  } satisfies Tracker;
}

/** The OpenCode calls a worker's run reaches: prompts, interrupts, forms, permission replies. */
function fakeOpenCode() {
  let forms = 0;
  const session = {
    prompt: watched(
      async (_input: { sessionID: string; id: string; text: string; delivery: string }, _request?: unknown) => {},
    ),
    interrupt: watched(async (_input: { sessionID: string }) => {}),
    form: {
      create: watched(async (_input: { sessionID: string; title: string; fields: unknown[] }) => ({
        id: `form_${++forms}`,
      })),
      list: watched(async (_input: { sessionID: string }): Promise<{ id: string }[]> => []),
      reply: watched(async (_input: { sessionID: string; formID: string; answer: unknown }) => {}),
    },
  };
  const permission = {
    reply: watched(async (_input: { sessionID: string; requestID: string; decision: string; message: string }) => {}),
  };
  return Object.assign({ session, permission }, { client: { session, permission } as unknown as OpenCodeClient });
}

/** The OpenCode event stream: `emit` is the server putting an event on the wire for a watched session. */
function fakeEvents() {
  const listeners = new Map<string, SessionEventListener[]>();
  return {
    watch: (sessionID: string, listener: SessionEventListener) => {
      listeners.set(sessionID, [...(listeners.get(sessionID) ?? []), listener]);
      return () => {};
    },
    emit: (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
      for (const listener of listeners.get(sessionID) ?? []) listener({ type, data: { sessionID, ...data } });
    },
  };
}

export const lane = (name: string, extra: Partial<ProjectLane> = {}): ProjectLane => ({
  name,
  queue: false,
  worktree: false,
  ...extra,
});

interface WorldOptions {
  lanes?: ProjectLane[];
  /** Whatever the orchestrator is built with besides the stand-ins. */
  deps?: Partial<OrchestratorDeps>;
}

/** An orchestrator with one tracker (`test-tracker`, project `p`) and one worker lane, `Doing`. */
export function world(options: WorldOptions = {}) {
  const lanes = options.lanes ?? [lane('Doing', { agent: 'dev' })];
  const log = trail();
  const ledger = new RunLedger(new Store(':memory:'));
  const dispatcher = fakeDispatcher();
  const tracker = fakeTracker();
  const opencode = fakeOpenCode();
  const events = fakeEvents();
  const forges = new Forges();
  const orchestrator = new Orchestrator({
    ledger,
    opencode: async () => opencode.client,
    events,
    log: log.log,
    signal: new AbortController().signal,
    lanes: () => lanes,
    directory: () => '/checkout',
    identity: async () => ({ name: 't', email: 't@t' }),
    dispatcher: dispatcher as unknown as Dispatcher,
    forges,
    keepAliveMs: 60_000,
    turnEndDebounceMs: 1,
    ...options.deps,
  });
  orchestrator.addTracker(tracker);
  return { orchestrator, ledger, dispatcher, tracker, opencode, events, forges, lanes, log };
}
export type World = ReturnType<typeof world>;

/** A delegation for `Doing`, as a tracker's push door sends it. */
export const delegation = (ticketId: string, extra: Partial<WorkRequest> = {}): WorkRequest => ({
  projectId: 'p',
  trackerId: 'test-tracker',
  ticketId,
  lane: 'Doing',
  agent: 'dev',
  directory: '/checkout',
  summary: `delegated ${ticketId}`,
  ...extra,
});

/** A run through the whole start: granted, prepared, prompted, `working`.
 *  The start's prompt is read, so the next one waited on is the next sent. */
export async function started(w: World, ticketId = 't-1', extra: Partial<WorkRequest> = {}) {
  const { runId } = await w.orchestrator.requestWork(delegation(ticketId, extra));
  await w.tracker.startWork.next();
  await w.opencode.session.prompt.next();
  return w.ledger.get(runId)!;
}

/** A working run put straight into the ledger, with a session and no lease. */
export function seeded(
  w: World,
  extra: { ticketId?: string; session?: string; trackerId?: string; directory?: string } = {},
) {
  const { ticketId = 't-1', session = 'ses_1', trackerId = w.tracker.id, directory = '/checkout' } = extra;
  const { run } = w.ledger.request({ projectId: 'p', trackerId, ticketId, lane: 'Doing', agent: 'dev' });
  return w.ledger.attachSession(run.id, session, directory);
}

/** Short words for the editable prompts, so a test can read what was composed. */
const wording: Record<PromptName, string> = {
  'worker-contract': 'CONTRACT {directory}',
  nudge: 'NUDGE',
  'permission-denied': 'DENIED {action}: {resources}',
  'feedback-loop': 'REVIEWED {pull}',
  'review-posture': 'POSTURE',
  'pr-body': 'PRBODY',
  escalation: 'ASK {pull}\n{list}',
  'job-result': 'RESULT {text}',
};
export const words =
  (extra: Partial<Record<PromptName, string>> = {}) =>
  async (name: PromptName) =>
    ({ ...wording, ...extra })[name];

/** The tool call a worker's session makes. */
export const call = (run: { sessionId?: string }, input: Record<string, unknown> = {}) => ({
  sessionId: run.sessionId!,
  input,
});

export const repo: RepoRef = { id: 'acme/site', remote: 'https://github.com/acme/site.git' };

export const pull = (extra: Partial<PrFacts> = {}): PrFacts => ({
  id: 'pr-1',
  url: 'https://github.com/acme/site/pull/1',
  title: 'Widget',
  state: 'open',
  branch: 'me/t-1',
  ...extra,
});

/** A forge that owns every project and does nothing: a registrant to script. */
export function fakeForge() {
  return {
    repoFor: watched(async (_project: ForgeProject): Promise<RepoRef | undefined> => repo),
    prForBranch: watched(async (_repo: RepoRef, _branch: string): Promise<PrFacts | undefined> => undefined),
    reviewFeedback: watched(
      async (_repo: RepoRef, pr: PrFacts): Promise<ReviewFacts> => ({ pr, reviews: [], threads: [], comments: [] }),
    ),
    resolveThread: watched(
      async (_repo: RepoRef, _pr: PrFacts, _threadId: string, _reply: { author: string; text: string }) => {},
    ),
    commentPr: watched(async (_repo: RepoRef, _pr: PrFacts, _comment: { author: string; text: string }) => {}),
    submitReview: watched(async (_repo: RepoRef, _pr: PrFacts, _review: unknown) => {}),
    syncSource: watched(async (_repo: RepoRef, _directory: string) => ({ state: 'current' as const })),
    fetchBranch: watched(async (_repo: RepoRef, _directory: string, _branch: string) => {}),
    push: watched(async (_repo: RepoRef, _worktree: string, _branch: string, _options?: { lease?: string }) => {}),
    openPr: watched(async (_repo: RepoRef, branch: string, _pr: { author: string; title: string; body: string }) =>
      pull({ branch }),
    ),
    fetchRefs: watched(async (_repo: RepoRef, _directory: string) => {}),
  } satisfies Forge;
}

export type GitAnswers = Record<string, string | { fail: string }>;

/** What git answers to one command, from a table keyed by its arguments. A
 *  command nobody scripted fails the test loudly. */
function answerGit(answers: GitAnswers, args: string[]) {
  const reply = answers[args.join(' ')];
  if (reply === undefined) throw new Error(`git ${args.join(' ')} was not scripted`);
  return typeof reply === 'string' ? { ok: true as const, stdout: reply } : { ok: false as const, message: reply.fail };
}

/** The git crossing the tools read through, scripted. */
export const scriptedGit = (answers: GitAnswers) =>
  watched(async (_cwd: string, args: string[], _signal?: AbortSignal) => answerGit(answers, args));
