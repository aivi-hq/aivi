/**
 * What the Linear module decides, one unit at a time. The module is started
 * over fakes — the services the host hands it, Linear's platform with its I/O
 * answered here, and the board — and each test calls what the module
 * registered: the tracker's stages, the event sink, the channel entry and the
 * delivery the engine is handed. The engine is the host's real one over a
 * dispatcher whose pool is always full, so a turn the module queues is asked
 * for and never started; `@aivi/host` is a module mock only so that the test
 * can read what the module builds the engine with. Nothing here reaches Linear,
 * OpenCode or a socket: the platform behind the tracker is
 * `test/tracker-decisions.test.ts`'s subject, and `test/module.test.ts` runs
 * module and orchestrator together.
 */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import * as host from '@aivi/host';
import type { AiviServices, RunView } from '@aivi/plugin';
import type { Tracker, TrackerChange, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import { recorder } from '../../host/test/support.ts';
import { LinearApiError, type LinearClient } from '../src/client.ts';
import { linearSchema } from '../src/config.ts';
import { RunLinks } from '../src/links.ts';
import { createLinearPlatform } from '../src/tracker.ts';
import type { LinearIssueWords } from '../src/work.ts';

const built: { engine: host.ChannelEngine; args: ConstructorParameters<typeof host.ChannelEngine> }[] = [];
class RecordingEngine extends host.ChannelEngine {
  constructor(...args: ConstructorParameters<typeof host.ChannelEngine>) {
    super(...args);
    built.push({ engine: this, args });
  }
}
mock.module('@aivi/host', { exports: { ...host, ChannelEngine: RecordingEngine } });

const { createLinearModule, describeWorkers, LINEAR, openLinearStore } = await import('../src/module.ts');

const HOME = '/aivi';

const lanes = [
  { name: 'Backlog', queue: true },
  { name: 'Todo', agent: 'dev' },
  { name: 'In Progress', agent: 'dev' },
  { name: 'Done' },
];

/** The config as the module reads it: projects with their Linear teams and lanes. */
const homeConfig = (written: Record<string, string[]> = { site: ['team-1'] }, agent?: string) =>
  ({
    path: `${HOME}/config.json`,
    sources: [],
    projects: Object.keys(written).map(id => ({ id, directory: `${HOME}/projects/${id}/source`, lanes })),
    config: {
      projects: Object.fromEntries(Object.entries(written).map(([id, teams]) => [id, { 'tracker-linear': { teams } }])),
      projectDefaults: {},
      plugins: { 'tracker-linear': agent ? { agent } : {} },
    },
  }) as unknown as LoadedConfig;

const runOf = (over: Partial<RunView> = {}): RunView =>
  ({
    id: 'run-1',
    projectId: 'site',
    trackerId: 'tracker-linear',
    ticketId: 'iss-47',
    lane: 'Todo',
    agent: 'dev',
    state: 'working',
    updatedAt: 1,
    sessionId: 'ses_worker',
    ...over,
  }) as RunView;

const issueOf = (over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: 'iss-47',
  identifier: 'ENG-47',
  title: 'Fix it',
  description: 'please',
  branchName: 'me/eng-47-fix-it',
  url: 'https://linear.app/acme/issue/ENG-47',
  state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
  teamId: 'team-1',
  labels: [],
  delegateId: null,
  assignee: null,
  archived: false,
  completed: false,
  blockedBy: [],
  ...over,
});

const wordsOf = (over: Partial<LinearIssueWords> = {}): LinearIssueWords => ({
  identifier: 'ENG-47',
  title: 'Fix it',
  description: 'please',
  teamId: 'team-1',
  stateName: 'Todo',
  branchName: 'me/eng-47-fix-it',
  ...over,
});

const goneError = () => new LinearApiError('Entity not found: Issue', 200);

/** The conversation of the agent session `initWork` opened, and of one a person brought. */
const SESSION = 'dev:as-1';
const BROUGHT = 'dev:as-9';
const DOSSIER = '<issue identifier="ENG-47"><title>Fix it</title><description>please</description></issue>';

const brought = (over: Partial<Extract<TrackerEvent, { kind: 'started' }>> = {}): TrackerEvent => ({
  kind: 'started',
  conversation: BROUGHT,
  issueId: 'iss-47',
  ...over,
});

const prompted = (over: Partial<Extract<TrackerEvent, { kind: 'prompted' }>> = {}): TrackerEvent => ({
  kind: 'prompted',
  id: 'act-7',
  conversation: SESSION,
  body: 'use main',
  ...over,
});

const updated = (changed: TrackerChange[]): TrackerEvent => ({
  kind: 'updated',
  conversation: 'dev',
  issueId: 'iss-47',
  changed,
});

/** Everything the module is started over, before it is started: a test that
 *  must seed the store or script a fake first takes the world, then starts it. */
async function world(t: TestContext, written?: Record<string, string[]>, agent?: string) {
  t.mock.property(process, 'env', {
    ...process.env,
    LINEAR_CLIENT_ID: 'cid',
    LINEAR_CLIENT_SECRET: 'sec',
    LINEAR_WEBHOOK_SECRET: 'whsec',
  });
  const lines = recorder();
  const loaded = homeConfig(written, agent);
  const store = new host.Store(':memory:');
  /** The modules a test started, stopped in turn before the store they run on is closed. */
  const stops: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    store.close();
  });
  const controller = new AbortController();
  const app = { viewer: async () => ({ id: 'app-user', organizationId: 'org-1' }) } as unknown as LinearClient;
  const routes = {
    register: mock.fn((..._route: unknown[]) => () => {}),
  };
  // The platform's I/O is answered here; its conversation words (`idFor`,
  // `parts`, `ownerOf`, `orgOf`) stay its own.
  const tracker = await createLinearPlatform(
    linearSchema.parse({ apps: { dev: {} } }),
    routes,
    new Map([['dev', app]]),
    lines.log,
  );
  const sinks: ((event: TrackerEvent) => Promise<void>)[] = [];
  const off = { events: mock.fn(), channel: mock.fn(), wake: mock.fn() };
  const io = {
    comment: mock.method(tracker, 'comment', async (..._said: unknown[]): Promise<string | undefined> => undefined),
    unassign: mock.method(tracker, 'unassign', async (..._undone: unknown[]) => {}),
    notify: mock.method(tracker, 'notify', async (..._told: unknown[]) => {}),
    apply: mock.method(tracker, 'apply', async (..._applied: unknown[]) => {}),
    resultShown: mock.method(tracker, 'resultShown', async (..._asked: unknown[]) => false),
    closingNote: mock.method(tracker, 'closingNote', async (..._noted: unknown[]) => {}),
    startSession: mock.method(
      tracker,
      'startSession',
      async (_conversation: string, _issueId: string): Promise<string | null> => 'as-1',
    ),
    ask: mock.method(tracker, 'ask', async (..._asked: unknown[]) => {}),
    plan: mock.method(tracker, 'plan', async (..._planned: unknown[]) => {}),
    issue: mock.method(tracker, 'issue', async (..._read: unknown[]) => issueOf()),
    events: mock.method(tracker, 'events', (sink: (event: TrackerEvent) => Promise<void>) => {
      sinks.push(sink);
      return off.events;
    }),
  };
  const board = {
    projects: mock.fn(() => ['site']),
    tickets: mock.fn(async (..._asked: unknown[]) => [] as { id: string; blocked: boolean }[]),
    moveTo: mock.fn(async (..._moved: unknown[]) => {}),
    issue: mock.fn(async (..._read: unknown[]): Promise<LinearIssueWords | undefined> => wordsOf()),
  };
  const form = { id: 'frm_1' };
  const session = {
    form: { list: mock.fn(async (..._listed: unknown[]) => [] as { id: string }[]) },
    prompt: mock.fn(async (..._prompted: unknown[]) => {}),
    interrupt: mock.fn(async (..._interrupted: unknown[]) => {}),
  };
  const unwatch = mock.fn();
  const wakeListeners: (() => void)[] = [];
  /** A pool that is always full: the engine asks for every waiting turn and
   *  never holds a place or starts one. */
  const dispatcher = {
    registerCallback: mock.fn(),
    request: mock.fn((..._asked: unknown[]) => ({ refused: 'full' })),
    cancel: mock.fn(),
  };
  const fakes = {
    opencode: mock.fn(async () => ({ session })),
    events: { watch: mock.fn((..._watched: unknown[]) => unwatch) },
    channels: { register: mock.fn((..._module: unknown[]) => off.channel) },
    routes,
    orchestrator: {
      addTracker: mock.fn((_tracker: Tracker) => {}),
      wake: mock.fn(async (..._woken: unknown[]) => {}),
      stop: mock.fn(async (..._stopped: unknown[]) => {}),
      answer: mock.fn(
        async (..._answered: unknown[]): Promise<{ resumed: boolean; queued?: string; refused?: string }> => ({
          resumed: true,
        }),
      ),
      activeRun: mock.fn((..._asked: unknown[]): RunView | undefined => undefined),
      runBySession: mock.fn((..._asked: unknown[]): RunView | undefined => undefined),
      cancelWaiting: mock.fn(),
    },
    wake: mock.fn(),
    onWake: mock.fn((listener: () => void) => {
      wakeListeners.push(listener);
      return off.wake;
    }),
    fail: mock.fn(),
  };
  const services = {
    ...fakes,
    loaded,
    store,
    knowledge: {},
    signal: controller.signal,
    log: lines.log,
    dispatcher,
    tasks: {},
    tools: {},
    forges: {},
    voice: {},
  } as unknown as AiviServices;
  return {
    lines,
    loaded,
    store,
    controller,
    tracker,
    io,
    off,
    sinks,
    board,
    form,
    session,
    unwatch,
    dispatcher,
    stops,
    fakes,
    services,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Start the module over a world, with the stages and the engine's delivery in hand. */
async function start(w: World, config: Record<string, unknown> = {}) {
  const running = await createLinearModule(
    linearSchema.parse({ apps: { dev: {} }, ...config }),
    async () => w.tracker,
    () => w.board,
  ).start(w.services);
  w.stops.push(running.stop);
  const engine = built.at(-1)!;
  return {
    ...w,
    running,
    engine: engine.engine,
    limits: engine.args[1],
    delivery: engine.args[4],
    work: w.fakes.orchestrator.addTracker.mock.calls[0]!.arguments[0] as Tracker,
    convos: openLinearStore(w.store),
    links: new RunLinks(w.store),
    /** One delivery of the tracker's normalized events, as the platform makes it. */
    sink: (event: TrackerEvent) => w.sinks[0]!(event),
    said: (level: string) => w.lines.said(level).map(line => line.event),
    /** The slots the engine has asked the dispatcher for, as it asked. */
    asked: () => w.dispatcher.request.mock.calls.map(call => call.arguments[0]),
  };
}

type Started = Awaited<ReturnType<typeof start>>;

const started = async (t: TestContext, config: Record<string, unknown> = {}) => start(await world(t), config);

/** The pair `initWork` opened and `ready` attached: the run can be spoken for. */
function pair(h: Started, ticket = 'iss-47', agentSession = 'as-1', session = 'ses_worker') {
  h.links.bind(agentSession, ticket);
  h.links.attach(ticket, session);
}

const ended = (over: Partial<RunView> = {}) =>
  runOf({ state: 'completed', outcome: { kind: 'success', summary: 'Shipped it.' }, ...over });

test('by default the module speaks through Linear’s own tracker, asked who aivi is with the environment’s credentials, and reads the config’s board', async t => {
  const w = await world(t);
  const sent: { url: string; authorization: unknown; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, authorization: (init.headers as Record<string, string>).authorization, body: init.body });
    return url.endsWith('/oauth/token')
      ? Response.json({ access_token: 'tok', expires_in: 86_399 })
      : Response.json({ data: { viewer: { id: 'app-user', organization: { id: 'org-1' } } } });
  });
  const running = await createLinearModule(linearSchema.parse({ apps: { dev: {} } })).start(w.services);
  w.stops.push(running.stop);
  assert.deepEqual(
    sent.map(call => [call.url, call.authorization]),
    [
      ['https://api.linear.app/oauth/token', `Basic ${Buffer.from('cid:sec').toString('base64')}`],
      ['https://api.linear.app/graphql', 'Bearer tok'],
    ],
    'the app proves itself once, then asks who it is',
  );
  assert.match(String(sent[1]!.body), /viewer/);
  assert.deepEqual(
    w.fakes.routes.register.mock.calls.map(call => call.arguments[0]),
    ['/linear/webhooks/app/dev'],
    'and takes its app’s webhook route',
  );
  const work = w.fakes.orchestrator.addTracker.mock.calls[0]!.arguments[0];
  assert.deepEqual(work.projects(), ['site'], 'the projects that name a Linear team');
});

test('a config with no Linear app is a configuration error, said before any tracker is built', async t => {
  const w = await world(t);
  await assert.rejects(
    createLinearModule(linearSchema.parse({ apps: {} })).start(w.services),
    /linear\.apps is empty: configure a Linear app/,
  );
});

test('two projects that claim one team stop the start before anything is built', async t => {
  const w = await world(t, { site: ['team-1'], docs: ['team-1'] });
  const makeTracker = mock.fn(async () => w.tracker);
  await assert.rejects(
    createLinearModule(linearSchema.parse({ apps: { dev: {} } }), makeTracker, () => w.board).start(w.services),
    /Linear config: projects\.docs\.tracker-linear\.teams: this Linear team is already mapped to project site/,
  );
  assert.equal(makeTracker.mock.callCount(), 0, 'no connection was made for a config that cannot work');
});

test('an assistant turn asks the dispatcher for a slot in the module’s pool, as the Linear service', async t => {
  const h = await started(t, { pool: 'assistants' });
  assert.deepEqual(h.asked(), [], 'nothing waits, so nothing is asked for');
  await h.sink(brought());
  assert.deepEqual(h.asked(), [{ service: 'linear', pool: 'assistants' }]);
  assert.deepEqual(h.limits, { pool: 'assistants' });
});

test('a turn a restart cut off is blocked, and each conversation is told, even when Linear refuses one notice', async t => {
  const w = await world(t);
  const convos = openLinearStore(w.store);
  for (const [session, turn] of [
    ['as-4', 'turn-1'],
    ['as-5', 'turn-2'],
  ] as const) {
    convos.bind(`dev:${session}`, { agent: 'assistant', directory: HOME, project: null });
    convos.enqueue({ id: turn, channel: `dev:${session}`, user: 'app-user', name: 'Linear', text: 'hi' }, 100);
    convos.claimTurn(turn);
  }
  w.io.comment.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  const h = await start(w);
  assert.deepEqual(
    h.convos.list().map(turn => turn.state),
    ['blocked', 'blocked'],
    'nobody knows if the agent stopped',
  );
  assert.deepEqual(h.said('warn'), ['turns.interrupted', 'notify.failed']);
  assert.deepEqual(w.lines.said('warn')[0], { level: 'warn', event: 'turns.interrupted', blocked: 2 });
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => [call.arguments[0], call.arguments[2]]),
    [
      ['dev:as-4', 'outcome'],
      ['dev:as-5', 'outcome'],
    ],
    'both conversations are told, the second after the first notice failed',
  );
  assert.match(
    String(h.io.comment.mock.calls[1]!.arguments[1]),
    /restarted while I was working.*an operator must inspect/,
  );
});

test('the channel entry owns the assistant’s sessions, takes a job’s outcome into its conversation, and is no place to report to', async t => {
  const h = await started(t);
  const entry = h.fakes.channels.register.mock.calls[0]!.arguments[0] as any;
  assert.equal(entry.id, 'linear');
  assert.equal(entry.accepts(), false, 'no chat message is addressed here');
  assert.equal(await entry.channelOf(), undefined);
  h.convos.bind('dev:as-4', { agent: 'assistant', directory: HOME, project: null });
  const { session } = h.convos.sessionOf('dev:as-4')!;
  assert.equal(entry.ownsSession(session), true);
  assert.equal(entry.ownsSession('ses_elsewhere'), false);
  await entry.reenter(session, 'The job said hello.', { run: { id: 'run-9' } });
  assert.deepEqual(
    h.convos.list().map(turn => [turn.id, turn.kind, turn.channel, turn.text]),
    [['run:run-9', 'job', 'dev:as-4', 'The job said hello.']],
  );
  assert.deepEqual(
    h.asked(),
    [{ service: 'linear', pool: 'default' }],
    'the engine asks for the turn it was just handed',
  );
  await assert.rejects(entry.post(), /Linear is not a report destination; report to a chat channel instead/);
});

test('the engine’s delivery speaks through the platform: answers as answers, progress as progress, notices as outcomes', async t => {
  const h = await started(t);
  const said = () => h.io.comment.mock.calls.map(call => call.arguments);
  h.io.comment.mock.mockImplementationOnce(async () => 'act-1');
  assert.equal(await h.delivery.send(SESSION, 'The fix is in.'), 'act-1', 'the platform’s id for the activity');
  h.io.comment.mock.mockImplementationOnce(async () => 'act-2');
  assert.equal(await h.delivery.placeholder!(SESSION, 'working…'), 'act-2');
  await h.delivery.edit!(SESSION, 'act-2', 'still working…');
  await h.delivery.notice!(SESSION, 'going offline');
  assert.deepEqual(said(), [
    [SESSION, 'The fix is in.', 'answer'],
    [SESSION, 'working…', 'progress'],
    [SESSION, 'still working…', 'progress'],
    [SESSION, 'going offline', 'outcome'],
  ]);
  await h.delivery.delete!(SESSION, 'act-2');
  assert.equal(said().length, 4, 'the response that follows replaces the ephemeral thought: nothing to delete');
});

test('the events the platform delivers are routed by kind, and one the module cannot handle is logged and dropped', async t => {
  const h = await started(t);
  await h.sink({ kind: 'updated', conversation: 'dev', issueId: 'iss-47', changed: [] });
  assert.equal(h.io.issue.mock.callCount(), 0, 'an update that changed nothing routing keys on reads nothing');
  await h.sink(brought({ issueId: '' }));
  assert.deepEqual(h.io.comment.mock.calls.at(-1)!.arguments, [
    BROUGHT,
    'I only work on issues; this session has none.',
    'outcome',
  ]);
  await h.sink(prompted({ body: '   ' }));
  assert.equal(h.io.comment.mock.callCount(), 1, 'a message with no words is nothing');
  h.io.issue.mock.mockImplementationOnce(async () => {
    throw new Error('502 bad gateway');
  });
  await h.sink(updated(['labels']));
  assert.deepEqual(h.said('warn'), ['event.failed']);
});

test('the host’s abort stops the engine, and no event is heard after it', async t => {
  const h = await started(t);
  const stop = t.mock.method(h.engine, 'stop');
  h.controller.abort();
  assert.equal(stop.mock.callCount(), 1, 'a module that is going down lets the engine go');
  await h.sink(brought());
  assert.equal(h.io.issue.mock.callCount(), 0, 'and answers nobody');
});

test('stopping lets go of everything the start took, then tells the turns still waiting', async t => {
  const w = await world(t);
  const convos = openLinearStore(w.store);
  convos.bind(SESSION, { agent: 'assistant', directory: HOME, project: null });
  convos.enqueue({ id: 'turn-1', channel: SESSION, user: 'ann', name: 'ann', text: 'hello' }, 100);
  const h = await start(w);
  assert.equal(h.asked().length, 1, 'the waiting turn is asked for once the engine is built');
  await h.running.stop();
  assert.deepEqual(
    [h.off.events, h.off.channel, h.off.wake].map(off => off.mock.callCount()),
    [1, 1, 1],
    'events, channel entry and wake listener are all given back',
  );
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => call.arguments),
    [[SESSION, LINEAR.notices!.offlineQueued, 'outcome']],
    'and the stop did not return before the waiting conversation was told',
  );
});

test('stopping while a run is followed falls its progress silent', async t => {
  const h = await started(t);
  pair(h);
  h.work.ready(runOf());
  assert.equal(h.unwatch.mock.callCount(), 0);
  await h.running.stop();
  assert.equal(h.unwatch.mock.callCount(), 1, 'nothing mirrors the worker’s session into the agent session any more');
});

test('the tracker the module registers is Linear’s: the board the walk reads, the ticket desk, and the stages', async t => {
  const h = await started(t);
  assert.equal(h.work.id, 'tracker-linear');
  assert.equal(h.work.projects, h.board.projects);
  assert.equal(h.work.tickets, h.board.tickets);
  assert.equal(h.work.moveTo, h.board.moveTo);
  assert.deepEqual(await h.work.desk.read(runOf()), {
    identifier: 'ENG-47',
    title: 'Fix it',
    description: 'please',
    lane: 'Todo',
    labels: [],
    url: 'https://linear.app/acme/issue/ENG-47',
  });
  assert.deepEqual(h.io.issue.mock.calls[0]!.arguments, ['dev', 'iss-47'], 'the desk speaks through the primary app');
});

test('a config with no app cannot give the desk anyone to speak through, so the start fails', async t => {
  const w = await world(t);
  await assert.rejects(
    createLinearModule(
      linearSchema.parse({ apps: {} }),
      async () => w.tracker,
      () => w.board,
    ).start(w.services),
    /the tracker has no primary Linear app/,
  );
});

test('the lane a ticket sits in is the board’s own word; gone, unmapped or off the board there is none', async t => {
  const h = await started(t);
  const laneWhen = async (answer: LinearIssueWords | undefined) => {
    h.board.issue.mock.mockImplementationOnce(async () => answer);
    return h.work.ticketLane('site', 'iss-47');
  };
  assert.equal(await laneWhen(wordsOf({ stateName: 'In Progress' })), 'In Progress');
  assert.equal(await laneWhen(undefined), undefined, 'a ticket a person deleted');
  assert.equal(await laneWhen(wordsOf({ teamId: 'team-9' })), undefined, 'a team this project does not map');
  assert.equal(await h.work.ticketLane('nowhere', 'iss-47'), undefined, 'a project that maps no Linear team');
  h.board.issue.mock.mockImplementationOnce(async () => {
    throw goneError();
  });
  assert.equal(await h.work.ticketLane('site', 'iss-47'), undefined, '"Entity not found" says deleted in other words');
  h.board.issue.mock.mockImplementationOnce(async () => {
    throw new Error('502 bad gateway');
  });
  await assert.rejects(h.work.ticketLane('site', 'iss-47'), /502 bad gateway/, 'anything else is a retry, not a lane');
});

test('a run opens with the delegation: the pair is recorded before anything else, the session hears first, the branch is Linear’s', async t => {
  const h = await started(t);
  assert.deepEqual(await h.work.initWork(runOf()), { summary: DOSSIER, branch: 'me/eng-47-fix-it' });
  assert.deepEqual(h.io.startSession.mock.calls[0]!.arguments, ['dev', 'iss-47']);
  assert.deepEqual(h.links.byAgentSession('as-1'), { agentSession: 'as-1', ticketId: 'iss-47' });
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [SESSION, 'Preparing the workspace…', 'progress']);
  h.board.issue.mock.mockImplementationOnce(async () => wordsOf({ branchName: '' }));
  assert.deepEqual(
    await h.work.initWork(runOf()),
    { summary: DOSSIER },
    'a ticket Linear names no branch for has none',
  );
});

test('a ticket that is gone from the board fails the run before the delegation is made', async t => {
  const h = await started(t);
  h.board.issue.mock.mockImplementationOnce(async () => undefined);
  await assert.rejects(h.work.initWork(runOf()), /the ticket is gone from the board \(deleted by a person\)/);
  assert.equal(h.io.startSession.mock.callCount(), 0);
});

test('a delegation that fails or makes no session is said on the ticket itself, then fails the run in the same words', async t => {
  const h = await started(t);
  h.io.startSession.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  await assert.rejects(h.work.initWork(runOf()), /the delegation failed: 502/);
  assert.deepEqual(h.io.notify.mock.calls[0]!.arguments, [
    'dev',
    'iss-47',
    'I could not start work on this ticket: the delegation failed: 502',
  ]);
  assert.equal(h.links.byAgentSession('as-1'), undefined, 'no pair is recorded for a session that never opened');
  h.io.startSession.mock.mockImplementationOnce(async () => null);
  h.io.notify.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  await assert.rejects(
    h.work.initWork(runOf()),
    /Linear made no agent session for the delegation\. If aivi still holds/,
  );
  assert.match(
    String(h.io.notify.mock.calls[1]!.arguments[2]),
    /^I could not start work on this ticket: Linear made no agent session/,
  );
  assert.deepEqual(h.said('warn'), ['initWork.notice.failed'], 'a word that cannot land is logged, never silence');
});

test('ready joins the worker’s session to the pair and follows its progress once, however often it is told', async t => {
  const h = await started(t);
  h.links.bind('as-1', 'iss-47');
  h.work.ready(runOf());
  assert.equal(h.links.byAgentSession('as-1')?.opencodeSession, 'ses_worker');
  assert.deepEqual(
    h.fakes.events.watch.mock.calls.map(call => call.arguments[0]),
    ['ses_worker'],
    'the worker’s own session is the one mirrored into the agent session',
  );
  h.work.ready(runOf());
  assert.deepEqual(
    h.lines.said('debug').map(line => line.event),
    ['ready.replayed'],
    'a replay says nothing but this',
  );
  assert.equal(h.fakes.events.watch.mock.callCount(), 1, 'one follower for the run');
});

test('a run with no session yet is said and left alone; a silent config follows nothing', async t => {
  const h = await started(t, { progress: 'silent' });
  h.work.ready(runOf({ sessionId: undefined as never }));
  assert.deepEqual(h.said('warn'), ['ready.sessionless']);
  h.links.bind('as-1', 'iss-47');
  h.work.ready(runOf());
  assert.equal(h.links.byAgentSession('as-1')?.opencodeSession, 'ses_worker', 'the pair is joined all the same');
  assert.equal(h.fakes.events.watch.mock.callCount(), 0, 'but nothing mirrors the session into the agent session');
});

test('a worker whose pair was never opened cannot be spoken for: the stage says so', async t => {
  const h = await started(t);
  await assert.rejects(async () => h.work.ready(runOf()), /run run-1 has no agent-session pair to speak through/);
  await assert.rejects(async () => h.work.question(runOf(), { question: 'Which branch?' }), /no agent-session pair/);
  await assert.rejects(async () => h.work.plan!(runOf(), { steps: [] }), /no agent-session pair/);
  await assert.rejects(
    async () => h.work.question(runOf({ sessionId: undefined as never }), { question: 'Which branch?' }),
    /no agent-session pair/,
    'a run that has no session has no pair either',
  );
  assert.equal(h.io.ask.mock.callCount() + h.io.plan.mock.callCount(), 0);
});

test('a question parks the progress line and is put to the people through the run’s conversation', async t => {
  const h = await started(t);
  pair(h);
  h.work.ready(runOf());
  const question = { question: 'Which branch?', options: [{ label: 'main', value: 'main' }] };
  await h.work.question(runOf(), question);
  assert.equal(h.unwatch.mock.callCount(), 1, 'nothing happens while a person thinks');
  assert.deepEqual(h.io.ask.mock.calls[0]!.arguments, [SESSION, question]);
});

test('a question for a run that never streamed is simply asked, and the plan is rendered whole', async t => {
  const h = await started(t);
  pair(h);
  await h.work.question(runOf(), { question: 'Which branch?' });
  assert.equal(h.unwatch.mock.callCount(), 0);
  assert.deepEqual(h.io.ask.mock.calls[0]!.arguments, [SESSION, { question: 'Which branch?' }]);
  const plan = { steps: [{ content: 'read the code', status: 'completed' as const }] };
  await h.work.plan!(runOf(), plan);
  assert.deepEqual(h.io.plan.mock.calls[0]!.arguments, [SESSION, plan]);
});

test('a closing is spoken in order: the progress falls silent, the result lands, then the note, then the delegate goes', async t => {
  const h = await started(t);
  pair(h);
  h.work.ready(runOf());
  const order: string[] = [];
  const reached = Promise.withResolvers<void>();
  const landed = Promise.withResolvers<void>();
  h.io.comment.mock.mockImplementationOnce(async () => {
    order.push('result');
    reached.resolve();
    await landed.promise;
    return undefined;
  });
  h.io.closingNote.mock.mockImplementationOnce(async () => {
    order.push('note');
  });
  h.io.unassign.mock.mockImplementationOnce(async () => {
    order.push('unassign');
  });
  const ending = h.work.endWork(ended());
  await reached.promise;
  assert.equal(h.unwatch.mock.callCount(), 1, 'the progress stream is silent before the closing speaks');
  landed.resolve();
  await ending;
  assert.deepEqual(order, ['result', 'note', 'unassign']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [SESSION, 'Shipped it.', 'answer']);
  assert.deepEqual(h.io.closingNote.mock.calls[0]!.arguments, [SESSION, 'iss-47', 'Shipped it.']);
  assert.deepEqual(h.io.unassign.mock.calls[0]!.arguments, [SESSION, 'iss-47']);
  assert.notEqual(h.links.byAgentSession('as-1')?.endedAt, undefined, 'the pair is settled: no boot asks again');
  assert.deepEqual(h.lines.said('info').at(-1), {
    level: 'info',
    event: 'run.caughtup',
    run: 'run-1',
    ticket: 'iss-47',
  });
});

test('a result Linear already shows is not said again: the result is skipped, the rest still lands', async t => {
  const h = await started(t);
  pair(h);
  h.io.resultShown.mock.mockImplementationOnce(async () => true);
  await h.work.endWork(ended());
  assert.equal(h.io.comment.mock.callCount(), 0);
  assert.equal(h.io.closingNote.mock.callCount(), 1);
  assert.equal(h.io.unassign.mock.callCount(), 1);
});

test('a failed run says its reason as an outcome; one that ended with no outcome says that', async t => {
  const h = await started(t);
  pair(h);
  pair(h, 'iss-48', 'as-2', 'ses_two');
  await h.work.endWork(runOf({ state: 'failed', outcome: { kind: 'failure', reason: 'the tests would not pass' } }));
  await h.work.endWork(runOf({ id: 'run-2', state: 'failed', ticketId: 'iss-48', sessionId: 'ses_two' }));
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => call.arguments),
    [
      [SESSION, 'the tests would not pass', 'outcome'],
      ['dev:as-2', 'The run ended without an outcome.', 'outcome'],
    ],
  );
  assert.equal(h.io.apply.mock.callCount(), 0, 'a failure the worker reported is no cause to call a person');
});

test('a run with no pair is said as an error and its debt dropped: nothing keeps it to retry', async t => {
  const h = await started(t);
  await h.work.endWork(ended({ sessionId: undefined as never }));
  await h.work.endWork(ended());
  assert.deepEqual(
    h.said('error'),
    ['closing.unpaired', 'closing.unpaired'],
    'the debt was dropped, so the second ending is a fresh one',
  );
  assert.equal(h.io.resultShown.mock.callCount(), 0, 'nothing was asked of Linear: there is no session to ask about');
});

test('a ticket a person deleted takes its debt with it: the pair is retired, nobody is called to a grave', async t => {
  const h = await started(t);
  pair(h);
  h.io.closingNote.mock.mockImplementationOnce(async () => {
    throw goneError();
  });
  await h.work.endWork(ended());
  assert.equal(h.links.byAgentSession('as-1'), undefined);
  assert.deepEqual(h.said('warn'), ['closing.dropped']);
  assert.equal(h.io.apply.mock.callCount(), 0, 'no label on a grave');
});

test('a closing Linear refuses cries once, marks the ticket for a person, and stays owed', async t => {
  const h = await started(t);
  pair(h);
  h.io.closingNote.mock.mockImplementationOnce(async () => {
    throw new Error('502 bad gateway');
  });
  await assert.rejects(h.work.endWork(ended()), /502 bad gateway/);
  assert.deepEqual(h.said('error'), ['closing.failed']);
  assert.deepEqual(h.io.comment.mock.calls[1]!.arguments, [
    SESSION,
    'I could not finish reporting this run: 502 bad gateway. The issue is marked for a person — help is on the way.',
    'outcome',
  ]);
  assert.deepEqual(h.io.apply.mock.calls[0]!.arguments, [
    SESSION,
    'iss-47',
    { kind: 'label', label: 'needs-human', on: true },
  ]);
  assert.equal(h.links.byAgentSession('as-1')?.endedAt, undefined, 'still owed');
});

test('a label Linear refuses is logged, and what it was marking for goes on', async t => {
  const h = await started(t);
  pair(h);
  h.io.closingNote.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  h.io.apply.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  await assert.rejects(h.work.endWork(ended()), /502/);
  assert.deepEqual(h.said('warn'), ['help.label.failed']);
  assert.equal(h.io.comment.mock.callCount(), 2, 'the person was told all the same');
});

test('a worker that may still be loose is said once, in the words of why, and the ticket is marked for a person', async t => {
  const h = await started(t);
  pair(h);
  pair(h, 'iss-48', 'as-2', 'ses_two');
  pair(h, 'iss-49', 'as-3', 'ses_three');
  const failure = (over: Partial<RunView>, code?: 'kill-unconfirmed' | 'stop-unconfirmed') =>
    runOf({
      state: 'failed',
      outcome: { kind: 'failure', reason: 'the worker would not stop', ...(code ? { code } : {}) },
      ...over,
    });
  await h.work.endWork(failure({}, 'kill-unconfirmed'));
  await h.work.endWork(failure({ id: 'run-2', ticketId: 'iss-48', sessionId: 'ses_two' }, 'stop-unconfirmed'));
  await h.work.endWork(failure({ id: 'run-3', ticketId: 'iss-49', sessionId: 'ses_three' }));
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => call.arguments).filter(call => call[1] !== 'the worker would not stop'),
    [
      [
        SESSION,
        'The dispatcher could not stop my worker session, so one may still be loose. I have marked this issue for a person.',
        'outcome',
      ],
      [
        'dev:as-2',
        'A person asked me to stop this worker, but my agent runtime would not answer the interrupt — it may still be running. I have marked this issue for a person.',
        'outcome',
      ],
    ],
    'a failure with no such code needs no help: the third run says nothing more',
  );
  assert.deepEqual(
    h.io.apply.mock.calls.map(call => [call.arguments[0], call.arguments[1]]),
    [
      [SESSION, 'iss-47'],
      ['dev:as-2', 'iss-48'],
    ],
  );
});

test('a closing already owed is left to its first driver: a second ending of the run drives nothing', async t => {
  const h = await started(t);
  pair(h);
  h.io.closingNote.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  await assert.rejects(h.work.endWork(ended()), /502/);
  await h.work.endWork(ended());
  assert.equal(h.io.resultShown.mock.callCount(), 1, 'the second ending found the debt owed and drove nothing');
});

test('a ticket brought to us is held by the assistant: bound to its project, acknowledged, its dossier queued', async t => {
  const h = await started(t);
  await h.sink(brought());
  const binding = h.convos.sessionOf(BROUGHT)!;
  assert.deepEqual(
    { agent: binding.agent, directory: binding.directory, project: binding.project },
    { agent: 'assistant', directory: `${HOME}/projects/site/source`, project: 'site' },
  );
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [BROUGHT, 'One moment — reading ENG-47.', 'progress']);
  const [turn] = h.convos.list();
  assert.deepEqual(
    [turn!.id, turn!.channel, turn!.user, turn!.name, turn!.state],
    ['created:as-9', BROUGHT, 'app-user', 'Linear', 'queued'],
  );
  assert.equal(
    turn!.text,
    `[platform: linear; issue: ENG-47 "Fix it"; project: site; came by: a person brought you the issue]\n\n${DOSSIER}`,
  );
  assert.deepEqual(h.asked(), [{ service: 'linear', pool: 'default' }], 'the engine asks for the turn queued for it');
});

test('what a person arrived with rides instead of the dossier', async t => {
  const h = await started(t);
  await h.sink(brought({ promptContext: '<issue identifier="ENG-47">can you look at this?</issue>' }));
  assert.equal(h.convos.list()[0]!.text.endsWith('\n\n<issue identifier="ENG-47">can you look at this?</issue>'), true);
});

test('the assistant is the configured agent, and a ticket of no project is held in the home', async t => {
  const h = await start(await world(t, undefined, 'helper'));
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ teamId: 'team-9' }));
  await h.sink(brought());
  const binding = h.convos.sessionOf(BROUGHT)!;
  assert.deepEqual(
    { agent: binding.agent, directory: binding.directory, project: binding.project },
    { agent: 'helper', directory: HOME, project: null },
  );
  assert.match(h.convos.list()[0]!.text, /^\[platform: linear; issue: ENG-47 "Fix it"; project: none; came by:/);
});

test('a conversation the module holds, a pair it recorded or a ticket a run is working is a redelivery: nothing starts twice', async t => {
  const h = await started(t);
  h.convos.bind(BROUGHT, { agent: 'assistant', directory: HOME, project: null });
  await h.sink(brought());
  h.links.bind('as-2', 'iss-48');
  await h.sink(brought({ conversation: 'dev:as-2', issueId: 'iss-48' }));
  h.fakes.orchestrator.activeRun.mock.mockImplementationOnce(() => runOf({ ticketId: 'iss-49' }));
  await h.sink(brought({ conversation: 'dev:as-3', issueId: 'iss-49' }));
  assert.equal(h.io.issue.mock.callCount(), 0, 'the ticket is not even read');
  assert.equal(h.io.comment.mock.callCount(), 0);
});

test('a ticket a person deleted gets nothing at all: no refusal, no conversation', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ archived: true }));
  await h.sink(brought());
  assert.equal(h.io.comment.mock.callCount(), 0);
  assert.equal(h.convos.has(BROUGHT), false);
  assert.deepEqual(
    h.lines.said('debug').map(line => line.event),
    ['session.archived'],
  );
});

test('a ticket with the human label is refused for any agent, in the words of which label', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ labels: [{ id: 'l1', name: 'needs-human' }] }));
  await h.sink(brought());
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    BROUGHT,
    'ENG-47 carries the `needs-human` label, so a person handles it. Remove the label to let me work on it.',
    'outcome',
  ]);
  assert.deepEqual(h.lines.said('info').at(-1), {
    level: 'info',
    event: 'session.refused',
    conversation: BROUGHT,
    why: h.io.comment.mock.calls[0]!.arguments[1],
  });
  assert.equal(h.convos.has(BROUGHT), false, 'no conversation starts');
});

test('a hand delegation gets one fixed answer: the delegate un-taken, and said on the session — unless the ticket is finished', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'app-user' }));
  await h.sink(brought());
  assert.deepEqual(h.io.unassign.mock.calls[0]!.arguments, [BROUGHT, 'iss-47']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    BROUGHT,
    'I looked into ENG-47, and there is nothing I can do at this time: work reaches me through the board, not through a delegation: I start a worker myself once the ticket sits in a lane I work. I have removed myself as delegate — @mention me if you want to talk about it.',
    'answer',
  ]);
  assert.equal(h.convos.has(BROUGHT), false);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'app-user', completed: true }));
  await h.sink(brought({ conversation: 'dev:as-8' }));
  assert.deepEqual(h.io.comment.mock.calls[1]!.arguments, [
    'dev:as-8',
    'ENG-47 is already finished as far as work goes; nothing to start.',
    'outcome',
  ]);
  assert.equal(h.io.unassign.mock.callCount(), 1, 'a finished ticket’s delegate is left as it stands');
});

test('a clearing or a word Linear refuses is logged; the refusal is never lost to silence', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'app-user' }));
  h.io.unassign.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  h.io.comment.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  await h.sink(brought());
  assert.deepEqual(h.said('warn'), ['delegate.undone', 'notify.failed']);
});

test('a person’s message in a session nothing knows is refused plainly; a message with no words is nothing', async t => {
  const h = await started(t);
  const { body: _body, ...bodiless } = prompted() as Extract<TrackerEvent, { kind: 'prompted' }>;
  await h.sink(bodiless);
  assert.equal(h.io.comment.mock.callCount(), 0);
  const stranger =
    'I do not know this session (it started before aivi did, or its state is gone). Delegate the issue to me again.';
  await h.sink(prompted({ conversation: 'dev' }));
  await h.sink(prompted());
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => call.arguments),
    [
      ['dev', stranger, 'outcome'],
      [SESSION, stranger, 'outcome'],
    ],
    'a bare app conversation and a session no pair names are alike strangers',
  );
});

test('a message in a conversation the assistant holds is queued behind its turn', async t => {
  const h = await started(t);
  h.convos.bind(SESSION, { agent: 'assistant', directory: HOME, project: null });
  await h.sink(prompted({ id: 'act-9', body: '  and one more thing  ' }));
  const [turn] = h.convos.list();
  assert.deepEqual(
    [turn!.id, turn!.channel, turn!.user, turn!.name, turn!.text],
    ['act-9', SESSION, 'linear', 'a person in Linear', 'and one more thing'],
  );
  assert.equal(h.asked().length, 1, 'the engine asks for the turn queued behind');
});

test('a message on a pair that never met a session is nobody’s run: the assistant is not asked either', async t => {
  const h = await started(t);
  h.links.bind('as-1', 'iss-47');
  await h.sink(prompted());
  assert.equal(h.fakes.orchestrator.runBySession.mock.callCount(), 0, 'a pair with no session names no run');
  assert.equal(h.io.comment.mock.calls[0]!.arguments[2], 'outcome');
});

test('a message in a finished run’s conversation is a follow-up: the assistant answers with how the run ended', async t => {
  const h = await started(t);
  const endings: [number, RunView][] = [
    [47, runOf({ state: 'completed', outcome: { kind: 'success', summary: 'Shipped it' } })],
    [
      48,
      runOf({
        state: 'failed',
        ticketId: 'iss-48',
        sessionId: 'ses_48',
        outcome: { kind: 'failure', reason: 'the tests would not pass' },
      }),
    ],
    [49, runOf({ state: 'cancelled', ticketId: 'iss-49', sessionId: 'ses_49' })],
  ];
  for (const [number, run] of endings) pair(h, `iss-${number}`, `as-${number}`, run.sessionId!);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(
    session => endings.find(([, run]) => run.sessionId === session)?.[1],
  );
  for (const [number] of endings) await h.sink(prompted({ conversation: `dev:as-${number}`, body: 'is it live?' }));
  assert.deepEqual(
    h.convos.list().map(turn => turn.text.split('\n\n').at(-1)),
    [
      '[follow-up: the run on this ticket ended (completed): Shipped it. The person now says: is it live?]',
      '[follow-up: the run on this ticket ended (failed): the tests would not pass. The person now says: is it live?]',
      '[follow-up: the run on this ticket ended (cancelled). The person now says: is it live?]',
    ],
  );
  assert.deepEqual(
    h.io.issue.mock.calls.map(call => call.arguments),
    endings.map(([number]) => [`dev:as-${number}`, `iss-${number}`]),
    'the ticket is read afresh for each',
  );
});

test('a message on a live run with a form open is the answer: the orchestrator delivers it, and the progress follows the work again', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(() => runOf());
  h.work.ready(runOf());
  await h.work.question(runOf(), { question: 'Which branch?' });
  h.session.form.list.mock.mockImplementationOnce(async () => [h.form]);
  await h.sink(prompted());
  assert.deepEqual(h.session.form.list.mock.calls[0]!.arguments, [{ sessionID: 'ses_worker' }]);
  assert.deepEqual(h.fakes.orchestrator.answer.mock.calls[0]!.arguments, ['ses_worker', 'use main', 'frm_1']);
  assert.equal(h.fakes.events.watch.mock.callCount(), 2, 'the follower that parked with the question resumes');
  assert.deepEqual(h.lines.said('info').at(-1), {
    level: 'info',
    event: 'run.answered',
    run: 'run-1',
    form: 'frm_1',
    resumed: true,
  });
});

test('an answer that finds no slot is queued and said so; one the pool refuses is said, and the question stands', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(() => runOf());
  h.session.form.list.mock.mockImplementation(async () => [h.form]);
  h.fakes.orchestrator.answer.mock.mockImplementationOnce(async () => ({ resumed: false, queued: 'q1' }));
  await h.sink(prompted());
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    SESSION,
    'I have your answer. No slot is free to wake that worker yet, so it wakes the moment one opens.',
    'progress',
  ]);
  assert.deepEqual(h.lines.said('info').at(-1), {
    level: 'info',
    event: 'run.answered',
    run: 'run-1',
    form: 'frm_1',
    resumed: false,
    queued: 'q1',
  });
  h.fakes.orchestrator.answer.mock.mockImplementationOnce(async () => ({ resumed: false, refused: 'full' }));
  await h.sink(prompted({ id: 'act-8' }));
  assert.deepEqual(h.io.comment.mock.calls[1]!.arguments, [
    SESSION,
    'The worker’s slot is gone and no capacity is free to wake it again — the pool behind its lane is full and its one queue place is taken. The question still stands: answer it again once a slot opens.',
    'outcome',
  ]);
});

test('an answer OpenCode will not take leaves the question standing, and the person hears that now', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(() => runOf());
  h.session.form.list.mock.mockImplementationOnce(async () => [h.form]);
  h.fakes.orchestrator.answer.mock.mockImplementationOnce(async () => {
    throw new Error('OpenCode is down');
  });
  await h.sink(prompted());
  assert.deepEqual(h.said('warn'), ['answer.delivery.failed']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    SESSION,
    'I could not reach my agent runtime to wake the worker — the question still stands; answer it again once the runtime is back.',
    'outcome',
  ]);
});

test('a message on a live run with no form open steers what comes next', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(() => runOf());
  await h.sink(prompted({ body: 'also fix the test' }));
  const [call] = h.session.prompt.mock.calls.map(
    call => call.arguments[0] as { sessionID: string; id: string; text: string; delivery: string },
  );
  assert.deepEqual(
    { ...call!, id: undefined },
    { sessionID: 'ses_worker', id: undefined, text: 'also fix the test', delivery: 'steer' },
  );
  assert.match(call!.id, /^msg_[0-9a-f-]{36}$/);
  assert.deepEqual(h.lines.said('info').at(-1), { level: 'info', event: 'run.interjected', run: 'run-1' });
});

test('a steer with no turn to steer queues the same words; when both fail the person is told the message did not land', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(() => runOf());
  const down = async () => {
    throw new Error('no turn to steer');
  };
  h.session.prompt.mock.mockImplementationOnce(down, 0);
  await h.sink(prompted({ body: 'first' }));
  assert.deepEqual(
    h.session.prompt.mock.calls.map(call => (call.arguments[0] as { delivery: string }).delivery),
    ['steer', 'queue'],
  );
  assert.deepEqual(h.said('warn'), ['run.steer.failed']);
  assert.deepEqual(h.lines.said('info').at(-1), { level: 'info', event: 'run.interjected.queued', run: 'run-1' });
  h.session.prompt.mock.mockImplementationOnce(down, 2);
  h.session.prompt.mock.mockImplementationOnce(down, 3);
  await h.sink(prompted({ id: 'act-8', body: 'second' }));
  assert.deepEqual(h.said('error'), ['run.interjection.lost']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    SESSION,
    'I could not carry that message — my agent runtime would not take it, to steer or to queue. Say it again.',
    'outcome',
  ]);
});

test('a stop on a live run goes to a person’s hands first: the human label, then the run is stopped', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(() => runOf());
  let labelledBeforeStop = -1;
  h.fakes.orchestrator.stop.mock.mockImplementationOnce(async () => {
    labelledBeforeStop = h.io.apply.mock.callCount();
  });
  await h.sink(prompted({ signal: 'stop' }));
  assert.equal(labelledBeforeStop, 1, 'or the walk would take the ticket straight back');
  assert.deepEqual(h.io.apply.mock.calls[0]!.arguments, [
    SESSION,
    'iss-47',
    { kind: 'label', label: 'needs-human', on: true },
  ]);
  assert.deepEqual(h.fakes.orchestrator.stop.mock.calls[0]!.arguments, [
    'run-1',
    'A person asked to stop iss-47 from the session.',
  ]);
});

test('a stop in a session nothing knows is refused; with nothing running it says so; a running assistant turn is stopped', async t => {
  const h = await started(t);
  await h.sink(prompted({ signal: 'stop' }));
  assert.equal(
    h.io.comment.mock.calls[0]!.arguments[1],
    'I do not know this session (it started before aivi did, or its state is gone). Delegate the issue to me again.',
  );
  h.convos.bind(SESSION, { agent: 'assistant', directory: HOME, project: null });
  await h.sink(prompted({ signal: 'stop' }));
  assert.deepEqual(h.io.comment.mock.calls[1]!.arguments, [SESSION, 'Nothing is running right now.', 'answer']);
  const turn = { ready: true, session: 'ses_assistant' };
  t.mock.method(h.engine, 'stopTurn', () => turn);
  await h.sink(prompted({ signal: 'stop' }));
  assert.deepEqual(h.session.interrupt.mock.calls[0]!.arguments[0], { sessionID: 'ses_assistant' });
  assert.equal(h.io.comment.mock.callCount(), 2, 'the engine’s stopped notice follows; the module adds nothing');
  h.session.interrupt.mock.mockImplementationOnce(async () => {
    throw new Error('OpenCode is down');
  });
  await h.sink(prompted({ signal: 'stop' }));
  assert.deepEqual(h.said('warn'), ['stop.interrupt_failed']);
});

const human = [{ id: 'l1', name: 'needs-human' }];
const inLane = (name: string) => ({ id: `s-${name}`, name, type: 'started' });

test('an update to a ticket of no project is ignored: nothing is cancelled, nothing woken', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ teamId: 'team-9' }));
  await h.sink(updated(['state']));
  assert.equal(h.fakes.orchestrator.cancelWaiting.mock.callCount() + h.fakes.orchestrator.wake.mock.callCount(), 0);
});

test('a ticket a person deleted stops the run that works it; with no run there is nothing to stop', async t => {
  const h = await started(t);
  pair(h);
  h.io.issue.mock.mockImplementation(async () => issueOf({ archived: true }));
  h.fakes.orchestrator.activeRun.mock.mockImplementationOnce(() => runOf());
  await h.sink(updated(['archive']));
  assert.deepEqual(h.fakes.orchestrator.stop.mock.calls[0]!.arguments, [
    'run-1',
    'Stopped: ENG-47 was deleted; there is no work.',
  ]);
  await h.sink(updated(['archive']));
  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 1);
});

test('a person’s hand on a live run’s ticket stops it: the human label, a lane another agent works, the delegate taken back', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  const hands: [TrackerChange, Partial<TrackerIssue>, string][] = [
    ['labels', { labels: human }, 'Stopped: `needs-human` was added to ENG-47; a person takes over.'],
    ['state', { state: inLane('Done') }, 'Stopped: ENG-47 moved to "Done", which is not my lane.'],
    ['delegate', { delegateId: null }, 'Stopped: I am no longer the delegate of ENG-47.'],
  ];
  for (const [change, over, words] of hands) {
    h.fakes.orchestrator.stop.mock.resetCalls();
    h.io.issue.mock.mockImplementationOnce(async () => issueOf(over));
    await h.sink(updated([change]));
    assert.deepEqual(h.fakes.orchestrator.stop.mock.calls[0]!.arguments, ['run-1', words]);
  }
});

test('a run whose delegate a person takes back carries their label before the stop wakes the walk', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: null }));
  let labelledBeforeStop = -1;
  h.fakes.orchestrator.stop.mock.mockImplementationOnce(async () => {
    labelledBeforeStop = h.io.apply.mock.callCount();
  });
  await h.sink(updated(['delegate']));
  assert.equal(labelledBeforeStop, 1, 'or aivi would delegate itself again in the breath the person cleared it');
  assert.deepEqual(h.io.apply.mock.calls[0]!.arguments, [
    SESSION,
    'iss-47',
    { kind: 'label', label: 'needs-human', on: true },
  ]);
});

test('a change that leaves a live run where it stands stops nothing: its lane keeps its agent, the delegate is still us', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ state: inLane('In Progress') }));
  await h.sink(updated(['state']));
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'app-user' }));
  await h.sink(updated(['delegate']));
  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 0);
});

// Known gap (docs/backlog, taking the ticket back during preparation): a run still getting ready has no
// session yet, so the delegate taken back finds no pair and stops nothing. The ruling moves the stop into
// the orchestrator; this test then flips.
test('a delegate a person takes back while the worker is still getting ready stops nothing yet', async t => {
  const h = await started(t);
  pair(h);
  const { sessionId: _none, ...preparing } = runOf({ state: 'preparing' });
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => preparing as RunView);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: null }));

  await h.sink(updated(['delegate']));

  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 0);
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('a wake from the host ticks the engine and drives the closings still owed, quietly while they keep failing', async t => {
  const h = await started(t);
  pair(h);
  h.io.closingNote.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  await assert.rejects(h.work.endWork(ended()), /502/);
  const [wake] = h.fakes.onWake.mock.calls.map(call => call.arguments[0]);
  const tick = t.mock.method(h.engine, 'tick');

  h.io.closingNote.mock.mockImplementationOnce(async () => {
    throw new Error('502 again');
  });
  wake!();
  await flush();

  assert.equal(tick.mock.callCount(), 1);
  assert.deepEqual(
    h.said('warn'),
    ['closing.retry.failed'],
    'a retry that fails is said as one, never as a second cry',
  );
  assert.equal(h.links.byAgentSession('as-1')?.endedAt, undefined, 'and the closing stays owed');

  wake!();
  await flush();

  assert.notEqual(h.links.byAgentSession('as-1')?.endedAt, undefined, 'the next wake lands it');
  assert.equal(h.said('info').includes('run.caughtup'), true);
});

test('a delegate Linear will not let go of is said, and the closing lands all the same', async t => {
  const h = await started(t);
  pair(h);
  h.io.unassign.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });

  await h.work.endWork(ended());

  assert.deepEqual(h.said('warn'), ['delegate.undone']);
  assert.notEqual(h.links.byAgentSession('as-1')?.endedAt, undefined);
});

test('two wakes at once may reach the same owed closing: the one that finds it landed has nothing left to do', async t => {
  const h = await started(t);
  pair(h);
  pair(h, 'iss-48', 'as-2', 'ses_two');
  for (const call of [0, 1])
    h.io.closingNote.mock.mockImplementationOnce(async () => {
      throw new Error('502');
    }, call);
  await assert.rejects(h.work.endWork(ended()), /502/);
  await assert.rejects(h.work.endWork(ended({ id: 'run-2', ticketId: 'iss-48', sessionId: 'ses_two' })), /502/);
  const [wake] = h.fakes.onWake.mock.calls.map(call => call.arguments[0]);
  const gate = Promise.withResolvers<boolean>();
  h.io.resultShown.mock.mockImplementationOnce(() => gate.promise);

  wake!(); // the first wake is at run-1, waiting on Linear
  wake!(); // the second drives run-1 and run-2 to their end
  await flush();
  gate.resolve(true);
  await flush();

  const noted = (ticket: string) => h.io.closingNote.mock.calls.filter(call => call.arguments[1] === ticket).length;
  assert.equal(noted('iss-48'), 2, 'run-2 failed once, then landed once: the first wake found nothing owed');
});

test('a start that fails closes what it opened and gives the failure back', async t => {
  const w = await world(t);
  const shutdown = t.mock.method(host.ChannelEngine.prototype, 'shutdown');
  w.fakes.channels.register.mock.mockImplementationOnce(() => {
    throw new Error('the channel registry refused');
  });

  await assert.rejects(
    createLinearModule(
      linearSchema.parse({ apps: { dev: {} } }),
      async () => w.tracker,
      () => w.board,
    ).start(w.services),
    /the channel registry refused/,
  );

  assert.equal(shutdown.mock.callCount(), 1, 'the engine it had built is shut down');
});

test('a person’s move cancels a waiting request and wakes the walk — unless the ticket sits where aivi does not look', async t => {
  const h = await started(t);
  const woken = () => h.fakes.orchestrator.wake.mock.calls.map(call => call.arguments);
  for (const [lane, wakes] of [
    ['Todo', true],
    ['Backlog', true],
    ['Done', false],
    ['Release', false],
  ] as const) {
    h.fakes.orchestrator.wake.mock.resetCalls();
    h.fakes.orchestrator.cancelWaiting.mock.resetCalls();
    h.io.issue.mock.mockImplementationOnce(async () => issueOf({ state: inLane(lane) }));
    await h.sink(updated(['state']));
    assert.deepEqual(
      h.fakes.orchestrator.cancelWaiting.mock.calls.map(call => call.arguments),
      [['tracker-linear', 'iss-47']],
      `${lane}: the request is cancelled`,
    );
    assert.deepEqual(
      woken(),
      wakes ? [['site']] : [],
      `${lane}: ${wakes ? 'the walk looks' : 'out of sight, out of mind'}`,
    );
  }
  h.fakes.orchestrator.wake.mock.resetCalls();
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ labels: human }));
  await h.sink(updated(['labels']));
  assert.deepEqual(woken(), [['site']], 'a label is a move too');
  h.fakes.orchestrator.wake.mock.resetCalls();
  h.fakes.orchestrator.cancelWaiting.mock.resetCalls();
  await h.sink(updated(['delegate']));
  assert.equal(
    h.fakes.orchestrator.cancelWaiting.mock.callCount() + h.fakes.orchestrator.wake.mock.callCount(),
    0,
    'a delegate nobody holds is no move',
  );
});

test('the boot pass pays what a previous life owed: ended runs only, each asked of Linear first', async t => {
  const w = await world(t);
  const links = new RunLinks(w.store);
  for (const [number, session, created] of [
    [47, 'ses_ended', 100],
    [48, 'ses_live', 101],
    [49, 'ses_unknown', 102],
  ] as const) {
    links.bind(`as-${number}`, `iss-${number}`, created);
    links.attach(`iss-${number}`, session);
  }
  const live = runOf({ id: 'run-live', ticketId: 'iss-48', sessionId: 'ses_live' });
  const done = ended({ id: 'run-ended', ticketId: 'iss-47', sessionId: 'ses_ended' });
  w.fakes.orchestrator.runBySession.mock.mockImplementation(
    session => ({ ses_ended: done, ses_live: live })[session as string],
  );
  const h = await start(w);
  assert.notEqual(h.links.byAgentSession('as-47')?.endedAt, undefined, 'the ended run’s debt is paid');
  assert.equal(h.links.byAgentSession('as-48')?.endedAt, undefined, 'a run still working owes nothing yet');
  assert.equal(h.links.byAgentSession('as-49')?.endedAt, undefined, 'a run nobody knows is left as it is');
  assert.deepEqual(
    h.io.resultShown.mock.calls.map(call => call.arguments[0]),
    ['dev:as-47'],
    'the real state is asked about once, for the run that ended',
  );
});

test('a boot closing Linear refuses does not stop the start: it stays owed', async t => {
  const w = await world(t);
  const links = new RunLinks(w.store);
  links.bind('as-47', 'iss-47');
  links.attach('iss-47', 'ses_ended');
  w.fakes.orchestrator.runBySession.mock.mockImplementation(() => ended({ sessionId: 'ses_ended' }));
  w.io.closingNote.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  const h = await start(w);
  assert.deepEqual(h.said('error'), ['closing.failed']);
  assert.equal(h.links.byAgentSession('as-47')?.endedAt, undefined);
});

test('what each assistant conversation is doing: its agent, its issue and its turn — never one that is sent or discarded', t => {
  const store = new host.Store(':memory:');
  t.after(() => store.close());
  const convos = openLinearStore(store);
  convos.bind('dev:as-4', { agent: 'assistant', directory: HOME, project: null, issue: 'iss-47' });
  convos.enqueue({ id: 'turn-1', channel: 'dev:as-4', user: 'ann', name: 'ann', text: 'hello' }, 100);
  convos.bind('dev:as-5', { agent: 'assistant', directory: HOME, project: null });
  convos.enqueue({ id: 'turn-2', channel: 'dev:as-5', user: 'ann', name: 'ann', text: 'hello' }, 100);
  convos.claimTurn('turn-2');
  convos.result('turn-2', 'hi');
  convos.sent('turn-2');
  convos.adopt('dev:as-6', { seed: 'an outcome' });
  convos.enqueue({ id: 'turn-3', channel: 'dev:as-6', user: 'ann', name: 'ann', text: 'hello' }, 100);
  assert.deepEqual(
    describeWorkers(convos).map(line => [line.conversation, line.agent, line.issue, line.turn.state]),
    [
      ['dev:as-4', 'assistant', 'iss-47', 'queued'],
      ['dev:as-6', null, null, 'queued'],
    ],
  );
});
