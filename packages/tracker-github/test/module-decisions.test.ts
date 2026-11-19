/**
 * What the GitHub module decides, one unit at a time. The module is started
 * over fakes — the services the host hands it, GitHub's tracker and the
 * board — and each test calls what the module registered: the tracker's
 * stages, the event sink, the channel entry, the wake listener. The channel
 * engine is the host's real one over a dispatcher whose pool is always full,
 * so a turn the module queues is asked for and never started. Nothing here
 * reaches GitHub, OpenCode or a socket, and no module is mocked: the
 * platform behind the tracker is `test/tracker-decisions.test.ts`'s subject,
 * the assistant's delivery is `test/delivery.test.ts`'s, and the run of
 * module and platform together over a scripted GitHub is `test/module.test.ts`.
 */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { webhookSignature } from '@aivi/github';
import { PublicRoutes, Store } from '@aivi/host';
import type { AiviServices, RunView } from '@aivi/plugin';
import type { Tracker, TrackerChange, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import { recorder } from '../../host/test/support.ts';
import type { GithubClient } from '../src/client.ts';
import { githubSchema } from '../src/config.ts';
import { RunLinks } from '../src/links.ts';
import { createGithubModule, GITHUB, githubTracker, openGithubStore } from '../src/module.ts';
import { GITHUB_FEED, GithubPlatform } from '../src/tracker.ts';

const SECRET = 'webhook-secret';
const HOME = '/home/aivi';

/** The client the module reaches GitHub through: the board fields the default
 *  tracker warms, and what its own platform touches. */
const githubApi = () => ({
  org: 'acme',
  delegateName: 'aivi-agent',
  addReaction: mock.fn(async (..._reaction: unknown[]) => {}),
  removeOwnReaction: mock.fn(async (..._reaction: unknown[]) => {}),
  updateComment: mock.fn(async (..._edit: unknown[]) => {}),
  deleteComment: mock.fn(async (..._removal: unknown[]) => {}),
  boardFields: mock.fn(async (..._board: unknown[]) => ({ projectId: 'PVT_board_1' })),
});

const lanes = [
  { name: 'Backlog', queue: true },
  { name: 'Todo', agent: 'dev' },
  { name: 'In Progress', agent: 'dev' },
  { name: 'Done' },
];

/** The config as the module reads it: one project, one repository, its lanes. */
const homeConfig = (written: Record<string, string[]> = { site: ['acme/shop'] }, agent?: string) =>
  ({
    path: `${HOME}/config.json`,
    sources: [],
    projects: Object.keys(written).map(id => ({ id, directory: `${HOME}/projects/${id}/source`, lanes })),
    config: {
      projects: Object.fromEntries(
        Object.entries(written).map(([id, repos]) => [id, { 'tracker-github': { board: 1, repos } }]),
      ),
      projectDefaults: {},
      plugins: { 'tracker-github': agent ? { agent } : {} },
    },
  }) as unknown as LoadedConfig;

const runOf = (over: Partial<RunView> = {}): RunView =>
  ({
    id: 'run-1',
    projectId: 'site',
    trackerId: 'tracker-github',
    ticketId: 'acme/shop#47',
    lane: 'Todo',
    agent: 'dev',
    state: 'working',
    updatedAt: 1,
    sessionId: 'ses_worker',
    ...over,
  }) as RunView;

const issueOf = (over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: 'acme/shop#47',
  identifier: 'acme/shop#47',
  title: 'Fix it',
  description: 'please',
  branchName: '',
  url: 'https://github.com/acme/shop/issues/47',
  state: { id: 'opt_todo', name: 'Todo', type: '' },
  teamId: 'acme/shop',
  labels: [],
  delegateId: null,
  assignee: null,
  archived: false,
  completed: false,
  blockedBy: [],
  ...over,
});

const gone = () => Object.assign(new Error('Not Found'), { status: 404 });

const TICKET = 'github:acme/shop#47';
const DOSSIER = '<issue identifier="acme/shop#47"><title>Fix it</title><description>please</description></issue>';

const brought = (over: Partial<Extract<TrackerEvent, { kind: 'started' }>> = {}): TrackerEvent => ({
  kind: 'started',
  conversation: TICKET,
  issueId: 'acme/shop#47',
  ...over,
});

const commented = (over: Partial<Extract<TrackerEvent, { kind: 'prompted' }>> = {}): TrackerEvent => ({
  kind: 'prompted',
  id: 'comment:7',
  conversation: TICKET,
  body: 'use main',
  ...over,
});

const updated = (
  changed: TrackerChange[],
  over: Partial<Extract<TrackerEvent, { kind: 'updated' }>> = {},
): TrackerEvent => ({
  kind: 'updated',
  conversation: GITHUB_FEED,
  issueId: 'acme/shop#47',
  changed,
  ...over,
});

/** Everything the module is started over, before it is started: a test that
 *  must seed the store or script a fake first takes the world, then starts it. */
function world(t: TestContext, written?: Record<string, string[]>, agent?: string) {
  const lines = recorder();
  const loaded = homeConfig(written, agent);
  const store = new Store(':memory:');
  /** The modules a test started, stopped in turn before the store they run on is closed. */
  const stops: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    store.close();
  });
  const controller = new AbortController();
  const api = githubApi();
  const tracker = new GithubPlatform(loaded, api as unknown as GithubClient, SECRET, lines.log);
  const sinks: ((event: TrackerEvent) => Promise<void>)[] = [];
  const off = { events: mock.fn(), route: mock.fn(), channel: mock.fn(), wake: mock.fn() };
  // The platform's I/O is answered here; its conversation words (`idFor`,
  // `parts`, `ticketOf`, `ownerOf`) stay its own.
  const io = {
    comment: mock.method(tracker, 'comment', async (..._said: unknown[]) => '55'),
    unassign: mock.method(tracker, 'unassign', async (..._undone: unknown[]) => {}),
    notify: mock.method(tracker, 'notify', async (..._told: unknown[]) => {}),
    apply: mock.method(tracker, 'apply', async (..._applied: unknown[]) => {}),
    resultShown: mock.method(tracker, 'resultShown', async (..._asked: unknown[]) => false),
    markClosing: mock.method(tracker, 'markClosing', async (..._closed: unknown[]) => {}),
    freezeStatus: mock.method(tracker, 'freezeStatus', async (..._frozen: unknown[]) => {}),
    startSession: mock.method(
      tracker,
      'startSession',
      async (_conversation: string, issueId: string): Promise<string | null> => `${issueId}:c1234`,
    ),
    ask: mock.method(tracker, 'ask', async (..._asked: unknown[]) => {}),
    plan: mock.method(tracker, 'plan', async (..._planned: unknown[]) => {}),
    issue: mock.method(tracker, 'issue', async (..._read: unknown[]) => issueOf()),
    progress: mock.method(tracker, 'progress', async (..._shown: unknown[]) => {}),
    events: mock.method(tracker, 'events', (sink: (event: TrackerEvent) => Promise<void>) => {
      sinks.push(sink);
      return off.events;
    }),
  };
  const board = {
    projects: mock.fn(() => ['site']),
    tickets: mock.fn(async (..._asked: unknown[]) => [] as { id: string; blocked: boolean }[]),
    moveTo: mock.fn(async (..._moved: unknown[]) => {}),
    issue: mock.fn(
      async (
        ..._read: unknown[]
      ): Promise<
        | {
            identifier: string;
            title: string;
            description: string | null;
            teamId: string;
            stateName: string;
            branchName: string;
          }
        | undefined
      > => ({
        identifier: 'acme/shop#47',
        title: 'Fix it',
        description: 'please',
        teamId: 'acme/shop',
        stateName: 'Todo',
        branchName: '',
      }),
    ),
  };
  const form = { id: 'frm_1' };
  const session = {
    form: { list: mock.fn(async (..._listed: unknown[]) => [] as { id: string }[]) },
    prompt: mock.fn(async (..._prompted: unknown[]) => {}),
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
    channels: {
      register: mock.fn((..._module: unknown[]) => off.channel),
    },
    routes: { register: mock.fn((..._route: unknown[]) => off.route) },
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
    api,
    tracker,
    io,
    off,
    sinks,
    board,
    form,
    session,
    unwatch,
    wakeListeners,
    dispatcher,
    stops,
    fakes,
    services,
  };
}

type World = ReturnType<typeof world>;

/** Start the module over a world, with the stages in hand. */
async function start(w: World, config: Record<string, unknown> = {}) {
  const running = await createGithubModule(
    githubSchema.parse(config),
    async () => w.tracker,
    () => w.board,
  ).start(w.services);
  w.stops.push(running.stop);
  return {
    ...w,
    running,
    work: w.fakes.orchestrator.addTracker.mock.calls[0]!.arguments[0] as Tracker,
    convos: openGithubStore(w.store),
    links: new RunLinks(w.store),
    /** One delivery of the tracker's normalized events, as the platform makes it. */
    sink: (event: TrackerEvent) => w.sinks[0]!(event),
    wake: () => w.wakeListeners[0]!(),
    said: (level: string) => w.lines.said(level).map(line => line.event),
    /** The slots the engine has asked the dispatcher for, as it asked. */
    asked: () => w.dispatcher.request.mock.calls.map(call => call.arguments[0]),
  };
}

const started = (t: TestContext, config: Record<string, unknown> = {}) => start(world(t), config);

test('by default the tracker is GitHub’s own: the connection and secret it is given, and the boards warmed', async t => {
  const w = world(t);
  const connect = mock.fn(async (..._opened: unknown[]) => ({
    client: w.api as unknown as GithubClient,
    webhookSecret: SECRET,
  }));
  const platform = await githubTracker(githubSchema.parse({}), connect)(w.services);
  assert.deepEqual(
    connect.mock.calls.map(call => call.arguments),
    [[w.lines.log]],
    'one connection, opened under the module’s own log',
  );
  assert.deepEqual(
    w.api.boardFields.mock.calls.map(call => call.arguments),
    [[1]],
    'the board is read at the start: a missing field is said now, not mid-run',
  );
  const body = Buffer.from('{}');
  const sealed = (id: string, signature: string) =>
    platform.deliver({
      method: 'POST',
      headers: { 'x-github-event': 'ping', 'x-github-delivery': id, 'x-hub-signature-256': signature },
      body,
    });
  assert.equal((await sealed('d1', webhookSignature(SECRET, body))).status, 200, 'the secret the connection holds');
  assert.equal((await sealed('d2', 'sha256=0000')).status, 401, 'any other seal is refused');
});

test('the default tracker trusts whom the config says: a stranger’s comment is heard only when everyone is trusted', async t => {
  const w = world(t);
  const connect = async () => ({ client: w.api as unknown as GithubClient, webhookSecret: SECRET });
  const body = Buffer.from(
    JSON.stringify({
      action: 'created',
      comment: { id: 5, body: 'hi', user: { login: 'stranger', type: 'User' }, author_association: 'NONE' },
      issue: { number: 47 },
      repository: { full_name: 'acme/shop' },
    }),
  );
  const heard = async (trust: 'members' | 'everyone') => {
    const platform = await githubTracker(githubSchema.parse({ trust }), connect)(w.services);
    const events: TrackerEvent[] = [];
    platform.events(async event => void events.push(event));
    await platform.deliver({
      method: 'POST',
      headers: {
        'x-github-event': 'issue_comment',
        'x-github-delivery': `d-${trust}`,
        'x-hub-signature-256': webhookSignature(SECRET, body),
      },
      body,
    });
    return events.length;
  };
  assert.equal(await heard('members'), 0);
  assert.equal(await heard('everyone'), 1);
});

test('by default the board is the config’s: the projects that name a GitHub board', async t => {
  const w = world(t);
  const module = createGithubModule(githubSchema.parse({}), async () => w.tracker);
  assert.equal(module.id, 'tracker-github');
  w.stops.push((await module.start(w.services)).stop);
  assert.deepEqual(w.fakes.orchestrator.addTracker.mock.calls[0]!.arguments[0].projects(), ['site']);
});

test('two projects that claim one repository stop the start before anything is built', async t => {
  const w = world(t, { site: ['acme/shop'], docs: ['acme/shop'] });
  const makeTracker = mock.fn(async () => w.tracker);
  await assert.rejects(
    createGithubModule(githubSchema.parse({}), makeTracker, () => w.board).start(w.services),
    /GitHub config: projects\.docs\.tracker-github\.repos: acme\/shop already feeds project site/,
  );
  assert.equal(makeTracker.mock.callCount(), 0, 'no connection was opened for a config that cannot work');
});

test('an assistant turn asks the dispatcher for a slot in the module’s pool, as the GitHub service', async t => {
  const h = await started(t, { pool: 'assistants' });
  assert.deepEqual(h.asked(), [], 'nothing waits, so nothing is asked for');
  await h.sink(brought());
  assert.deepEqual(h.asked(), [{ service: 'github', pool: 'assistants' }]);
});

test('a start that fails after the engine is built shuts it down: the turns still waiting are told, and the failure is said', async t => {
  const w = world(t);
  const convos = openGithubStore(w.store);
  convos.bind(TICKET, { agent: 'assistant', directory: HOME, project: null });
  convos.enqueue({ id: 'turn-1', channel: TICKET, user: 'ann', name: 'ann', text: 'hello' }, 100);
  w.fakes.orchestrator.addTracker.mock.mockImplementationOnce(() => {
    throw new Error(
      'Trackers "tracker-linear" and "tracker-github" both speak for project site; a project has one tracker.',
    );
  });
  await assert.rejects(
    createGithubModule(
      githubSchema.parse({}),
      async () => w.tracker,
      () => w.board,
    ).start(w.services),
    /both speak for project site/,
  );
  assert.deepEqual(
    w.io.comment.mock.calls.map(call => call.arguments),
    [[TICKET, GITHUB.notices!.offlineQueued, 'outcome']],
    'the waiting conversation hears that its turn stays queued',
  );
  assert.deepEqual(
    convos.list().map(turn => turn.state),
    ['queued'],
    'and the turn is not lost',
  );
});

test('a start that fails after the route is registered gives it back, so the supervisor’s retry can register it again', async t => {
  const w = world(t);
  const routes = new PublicRoutes();
  const services = { ...w.services, routes } as unknown as AiviServices;
  w.fakes.channels.register.mock.mockImplementationOnce(() => {
    throw new Error('Channel module github is already registered');
  });
  const module = createGithubModule(
    githubSchema.parse({}),
    async () => w.tracker,
    () => w.board,
  );
  await assert.rejects(module.start(services), /already registered/);
  assert.equal(routes.get('/github/webhooks'), undefined, 'the route did not outlive the start that failed');
  assert.equal(w.off.events.mock.callCount(), 1, 'nor did the subscription to the platform’s events');
  const retry = await module.start(services);
  assert.notEqual(routes.get('/github/webhooks'), undefined, 'the retry took the route again');
  await retry.stop();
});

test('a wake makes the engine look again; stopping lets go of everything the start took, then tells the turns still waiting', async t => {
  const w = world(t);
  const convos = openGithubStore(w.store);
  convos.bind(TICKET, { agent: 'assistant', directory: HOME, project: null });
  convos.enqueue({ id: 'turn-1', channel: TICKET, user: 'ann', name: 'ann', text: 'hello' }, 100);
  const h = await start(w);
  assert.equal(h.asked().length, 1, 'the waiting turn is asked for once the engine is built');
  h.wake();
  assert.equal(h.asked().length, 2, 'and again when a wake says capacity may have changed');
  await h.running.stop();
  assert.deepEqual(
    [h.off.events, h.off.route, h.off.channel, h.off.wake].map(off => off.mock.callCount()),
    [1, 1, 1, 1],
    'events, route, channel entry and wake listener are all given back',
  );
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => call.arguments),
    [[TICKET, GITHUB.notices!.offlineQueued, 'outcome']],
    'and the stop did not return before the waiting conversation was told',
  );
});

test('a turn a restart cut off is blocked, and each conversation is told, even when GitHub refuses one notice', async t => {
  const w = world(t);
  const convos = openGithubStore(w.store);
  for (const [number, turn] of [
    [47, 'turn-1'],
    [48, 'turn-2'],
  ] as const) {
    convos.bind(`github:acme/shop#${number}`, { agent: 'assistant', directory: HOME, project: null });
    convos.enqueue(
      { id: turn, channel: `github:acme/shop#${number}`, user: 'aivi-agent', name: 'GitHub', text: 'hi' },
      100,
    );
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
  assert.deepEqual(
    w.lines.said('warn')[0],
    { level: 'warn', event: 'turns.interrupted', blocked: 2 },
    'the count says how many were cut off',
  );
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => [call.arguments[0], call.arguments[2]]),
    [
      ['github:acme/shop#47', 'outcome'],
      ['github:acme/shop#48', 'outcome'],
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
  assert.equal(entry.id, 'github');
  assert.equal(entry.accepts(), false, 'no chat message is addressed here');
  assert.equal(await entry.channelOf(), undefined);
  h.convos.bind('github:acme/shop#47', { agent: 'assistant', directory: HOME, project: null });
  const { session } = h.convos.sessionOf('github:acme/shop#47')!;
  assert.equal(entry.ownsSession(session), true);
  assert.equal(entry.ownsSession('ses_elsewhere'), false);
  await entry.reenter(session, 'The job said hello.', { run: { id: 'run-9' } });
  assert.deepEqual(
    h.convos.list().map(turn => [turn.id, turn.kind, turn.channel, turn.text]),
    [['run:run-9', 'job', 'github:acme/shop#47', 'The job said hello.']],
  );
  assert.deepEqual(
    h.asked(),
    [{ service: 'github', pool: 'default' }],
    'the engine asks for the turn it was just handed',
  );
  await assert.rejects(entry.post(), /GitHub is not a report destination; report to a chat channel instead/);
});

test('the events the platform delivers are routed by kind', async t => {
  const h = await started(t);
  await h.sink({ kind: 'updated', conversation: GITHUB_FEED, issueId: 'acme/shop#47', changed: [] });
  assert.equal(h.io.issue.mock.callCount(), 0, 'an update that changed nothing routing keys on reads nothing');
  await h.sink({ kind: 'started', conversation: 'github:acme/shop', issueId: '' });
  assert.deepEqual(h.io.comment.mock.calls.at(-1)!.arguments, [
    'github:acme/shop',
    'I only work on issues; this has none.',
    'outcome',
  ]);
  await h.sink({ kind: 'prompted', id: 'comment:1', conversation: GITHUB_FEED, body: 'hello?' });
  assert.deepEqual(h.io.comment.mock.calls.at(-1)!.arguments, [
    GITHUB_FEED,
    'I do not know this conversation.',
    'outcome',
  ]);
});

test('an event the module cannot handle is logged and dropped: the delivery was acknowledged already', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => {
    throw new Error('502 bad gateway');
  });
  await h.sink({ kind: 'updated', conversation: GITHUB_FEED, issueId: 'acme/shop#47', changed: ['labels'] });
  assert.deepEqual(h.said('warn'), ['event.failed']);
});

test('the host’s abort stops the engine, and no event is heard after it', async t => {
  const w = world(t);
  const convos = openGithubStore(w.store);
  convos.bind(TICKET, { agent: 'assistant', directory: HOME, project: null });
  convos.enqueue({ id: 'turn-1', channel: TICKET, user: 'ann', name: 'ann', text: 'hello' }, 100);
  const h = await start(w);
  h.controller.abort();
  h.wake();
  assert.equal(h.asked().length, 1, 'a stopped engine asks for nothing more, however often it is woken');
  await h.sink({ kind: 'prompted', id: 'comment:1', conversation: GITHUB_FEED, body: 'hello?' });
  assert.equal(h.io.comment.mock.callCount(), 0, 'a module that is going down answers nobody');
});

const CONVERSATION = 'github:acme/shop#47:c1234';

/** The pair `initWork` opened and `ready` attached: the run can be spoken for. */
function pair(
  h: Awaited<ReturnType<typeof started>>,
  ticket = 'acme/shop#47',
  comment = 'c1234',
  session = 'ses_worker',
) {
  h.links.bind(`${ticket}:${comment}`, ticket);
  h.links.attach(ticket, session);
}

const ended = (over: Partial<RunView> = {}) =>
  runOf({ state: 'completed', outcome: { kind: 'success', summary: 'Shipped it.' }, ...over });

test('the tracker the module registers is GitHub’s: the board the walk reads, the ticket desk, and the stages', async t => {
  const h = await started(t);
  assert.equal(h.work.id, 'tracker-github');
  assert.equal(h.work.projects, h.board.projects);
  assert.equal(h.work.tickets, h.board.tickets);
  assert.equal(h.work.moveTo, h.board.moveTo);
  assert.deepEqual(await h.work.desk.read(runOf()), {
    identifier: 'acme/shop#47',
    title: 'Fix it',
    description: 'please',
    lane: 'Todo',
    labels: [],
    url: 'https://github.com/acme/shop/issues/47',
  });
  assert.deepEqual(
    h.io.issue.mock.calls[0]!.arguments,
    [GITHUB_FEED, 'acme/shop#47'],
    'the desk speaks through the tracker',
  );
});

test('the lane a ticket sits in is the board’s own word; gone, unmapped or off the board there is none', async t => {
  const h = await started(t);
  const words = {
    identifier: 'acme/shop#47',
    title: 'Fix it',
    description: null,
    teamId: 'acme/shop',
    stateName: 'In Progress',
    branchName: '',
  };
  const laneWhen = (answer: typeof words | undefined) => {
    h.board.issue.mock.mockImplementationOnce(async () => answer);
    return h.work.ticketLane('site', 'acme/shop#47');
  };
  assert.equal(await laneWhen(words), 'In Progress');
  assert.equal(await laneWhen(undefined), undefined, 'a ticket a person deleted');
  assert.equal(await laneWhen({ ...words, teamId: 'other/repo' }), undefined, 'a repository this project does not map');
  assert.equal(await laneWhen({ ...words, stateName: '' }), undefined, 'a mapped repository, but off the board');
  assert.equal(await h.work.ticketLane('nowhere', 'acme/shop#47'), undefined, 'a project that names no GitHub board');
  assert.equal(h.board.issue.mock.callCount(), 5 - 1, 'and that project’s board is never asked');
  h.board.issue.mock.mockImplementationOnce(async () => {
    throw gone();
  });
  assert.equal(
    await h.work.ticketLane('site', 'acme/shop#47'),
    undefined,
    '"does not exist" says deleted in other words',
  );
  h.board.issue.mock.mockImplementationOnce(async () => {
    throw new Error('502 bad gateway');
  });
  await assert.rejects(
    h.work.ticketLane('site', 'acme/shop#47'),
    /502 bad gateway/,
    'anything else is a retry, not a lane',
  );
});

test('a run opens with the status comment: the pair is recorded before anything else, and the branch is generated', async t => {
  const h = await started(t);
  assert.deepEqual(await h.work.initWork(runOf()), {
    summary: '<issue identifier="acme/shop#47"><title>Fix it</title><description>please</description></issue>',
    branch: 'aivi/47-fix-it',
  });
  assert.deepEqual(h.io.startSession.mock.calls[0]!.arguments, [GITHUB_FEED, 'acme/shop#47']);
  assert.deepEqual(h.links.byAgentSession('acme/shop#47:c1234'), {
    agentSession: 'acme/shop#47:c1234',
    ticketId: 'acme/shop#47',
  });
});

test('a ticket that is gone from the board fails the run before any comment is made', async t => {
  const h = await started(t);
  h.board.issue.mock.mockImplementationOnce(async () => undefined);
  await assert.rejects(h.work.initWork(runOf()), /the ticket is gone from the board \(deleted by a person\)/);
  assert.equal(h.io.startSession.mock.callCount(), 0);
});

test('a status comment that cannot be made is said on the ticket itself, then fails the run in the same words', async t => {
  const h = await started(t);
  h.io.startSession.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  await assert.rejects(h.work.initWork(runOf()), /the status comment failed: 502/);
  assert.deepEqual(h.io.notify.mock.calls[0]!.arguments, [
    GITHUB_FEED,
    'acme/shop#47',
    'I could not start work on this ticket: the status comment failed: 502',
  ]);
  assert.equal(h.links.byTicket('acme/shop#47'), undefined, 'no pair is recorded for a conversation that never opened');
});

test('a ticket GitHub makes no status comment for is said too; a word that cannot land is logged, never silence', async t => {
  const h = await started(t);
  h.io.startSession.mock.mockImplementationOnce(async () => null);
  h.io.notify.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  await assert.rejects(
    h.work.initWork(runOf()),
    /GitHub made no status comment for the ticket\. If aivi still holds the Agent field/,
  );
  assert.match(
    String(h.io.notify.mock.calls[0]!.arguments[2]),
    /^I could not start work on this ticket: GitHub made no status comment/,
  );
  assert.deepEqual(h.said('warn'), ['initWork.notice.failed']);
});

test('ready joins the session to the pair and follows the run’s progress once, however often it is told', async t => {
  const h = await started(t);
  h.links.bind(CONVERSATION.replace('github:', ''), 'acme/shop#47');
  h.work.ready(runOf());
  assert.equal(h.links.byAgentSession('acme/shop#47:c1234')?.opencodeSession, 'ses_worker');
  assert.deepEqual(
    h.fakes.events.watch.mock.calls.map(call => call.arguments[0]),
    ['ses_worker'],
    'the worker’s own session is the one mirrored into the status comment',
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
  h.links.bind('acme/shop#47:c1234', 'acme/shop#47');
  h.work.ready(runOf());
  assert.equal(
    h.links.byAgentSession('acme/shop#47:c1234')?.opencodeSession,
    'ses_worker',
    'the pair is joined all the same',
  );
  assert.equal(h.fakes.events.watch.mock.callCount(), 0, 'but nothing mirrors the session into the ticket');
});

test('a worker whose pair was never opened cannot be spoken for: the stage says so', async t => {
  const h = await started(t);
  await assert.rejects(async () => h.work.ready(runOf()), /run run-1 has no status-comment pair to speak through/);
  await assert.rejects(async () => h.work.question(runOf(), { question: 'Which branch?' }), /no status-comment pair/);
  await assert.rejects(async () => h.work.plan!(runOf(), { steps: [] }), /no status-comment pair/);
  await assert.rejects(
    async () => h.work.question(runOf({ sessionId: undefined as never }), { question: 'Which branch?' }),
    /no status-comment pair/,
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
  assert.deepEqual(h.io.ask.mock.calls[0]!.arguments, [CONVERSATION, question]);
});

test('a question for a run that never streamed is simply asked, and the plan is rendered whole', async t => {
  const h = await started(t);
  pair(h);
  await h.work.question(runOf(), { question: 'Which branch?' });
  assert.equal(h.unwatch.mock.callCount(), 0);
  assert.deepEqual(h.io.ask.mock.calls[0]!.arguments, [CONVERSATION, { question: 'Which branch?' }]);
  const plan = { steps: [{ content: 'read the code', status: 'completed' as const }] };
  await h.work.plan!(runOf(), plan);
  assert.deepEqual(h.io.plan.mock.calls[0]!.arguments, [CONVERSATION, plan]);
});

test('a closing is spoken in order: the progress falls silent, the final comment lands, the line freezes, the Agent value goes', async t => {
  const h = await started(t);
  pair(h);
  h.work.ready(runOf());
  const reached = Promise.withResolvers<void>();
  const landed = Promise.withResolvers<void>();
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    reached.resolve();
    await landed.promise;
  });
  const ending = h.work.endWork(ended());
  await reached.promise;
  assert.equal(h.unwatch.mock.callCount(), 1, 'the progress stream is silent before the closing speaks');
  assert.equal(h.io.freezeStatus.mock.callCount(), 0, 'the status line freezes only after the final comment');
  landed.resolve();
  await ending;
  assert.deepEqual(h.io.markClosing.mock.calls[0]!.arguments, [CONVERSATION, 'Shipped it.', true]);
  assert.deepEqual(h.io.freezeStatus.mock.calls[0]!.arguments, [CONVERSATION, '**Done**']);
  assert.deepEqual(h.io.unassign.mock.calls[0]!.arguments, [CONVERSATION, 'acme/shop#47']);
  assert.notEqual(
    h.links.byAgentSession('acme/shop#47:c1234')?.endedAt,
    undefined,
    'the pair is settled: no boot asks again',
  );
  assert.deepEqual(h.lines.said('info').at(-1), {
    level: 'info',
    event: 'run.caughtup',
    run: 'run-1',
    ticket: 'acme/shop#47',
  });
});

test('an Agent value GitHub will not let go of is said, and the closing lands all the same', async t => {
  const h = await started(t);
  pair(h);
  h.io.unassign.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });

  await h.work.endWork(ended());

  assert.deepEqual(h.said('warn'), ['delegate.undone']);
  assert.notEqual(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined);
});

test('a result GitHub already shows is not said again: the final comment is skipped, the rest still lands', async t => {
  const h = await started(t);
  pair(h);
  h.io.resultShown.mock.mockImplementationOnce(async () => true);
  await h.work.endWork(ended());
  assert.equal(h.io.markClosing.mock.callCount(), 0);
  assert.equal(h.io.freezeStatus.mock.callCount(), 1);
  assert.equal(h.io.unassign.mock.callCount(), 1);
});

test('a failed run says its reason and freezes as failed; one that ended with no outcome says that', async t => {
  const h = await started(t);
  pair(h);
  pair(h, 'acme/shop#48', 'c9', 'ses_two');
  await h.work.endWork(runOf({ state: 'failed', outcome: { kind: 'failure', reason: 'the tests would not pass' } }));
  await h.work.endWork(runOf({ id: 'run-2', state: 'failed', ticketId: 'acme/shop#48', sessionId: 'ses_two' }));
  assert.deepEqual(
    h.io.markClosing.mock.calls.map(call => call.arguments),
    [
      [CONVERSATION, 'the tests would not pass', false],
      ['github:acme/shop#48:c9', 'The run ended without an outcome.', false],
    ],
  );
  assert.deepEqual(
    h.io.freezeStatus.mock.calls.map(call => call.arguments[1]),
    ['**Failed**', '**Failed**'],
  );
  assert.equal(h.io.comment.mock.callCount(), 0, 'a failure the worker reported is no cause to call a person');
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
  assert.equal(
    h.io.resultShown.mock.callCount(),
    0,
    'nothing was asked of GitHub: there is no conversation to ask about',
  );
});

test('a ticket a person deleted takes its debt with it: the pair is retired, nobody is called to a grave', async t => {
  const h = await started(t);
  pair(h);
  h.io.freezeStatus.mock.mockImplementationOnce(async () => {
    throw gone();
  });
  await h.work.endWork(ended());
  assert.equal(h.links.byAgentSession('acme/shop#47:c1234'), undefined);
  assert.deepEqual(h.said('warn'), ['closing.dropped']);
  assert.equal(h.io.apply.mock.callCount() + h.io.comment.mock.callCount(), 0, 'no label, no word');
});

/** GitHub refuses the first `refusals` posts of the final comment. */
function refusing(h: Awaited<ReturnType<typeof started>>, refusals: number) {
  for (let call = 0; call < refusals; call++)
    h.io.markClosing.mock.mockImplementationOnce(async () => {
      throw new Error('502 bad gateway');
    }, call);
}

test('a closing GitHub refuses cries once, marks the ticket for a person, and stays owed', async t => {
  const h = await started(t);
  pair(h);
  refusing(h, 1);
  await assert.rejects(h.work.endWork(ended()), /502 bad gateway/);
  assert.deepEqual(h.said('error'), ['closing.failed']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    CONVERSATION,
    'I could not finish reporting this run: 502 bad gateway. The issue is marked for a person — help is on the way.',
    'outcome',
  ]);
  assert.deepEqual(h.io.apply.mock.calls[0]!.arguments, [
    CONVERSATION,
    'acme/shop#47',
    { kind: 'label', label: 'needs-human', on: true },
  ]);
  assert.equal(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined, 'still owed');
});

test('a retry that fails again is only logged: the person was told once, not on every wake', async t => {
  const h = await started(t);
  pair(h);
  refusing(h, 2);
  await assert.rejects(h.work.endWork(ended()), /502 bad gateway/);
  h.wake();
  await h.lines.next('closing.retry.failed');
  assert.equal(h.io.comment.mock.callCount(), 1, 'the first cry stands');
  assert.equal(h.io.apply.mock.callCount(), 1);
});

test('a wake pays the debt a failed closing left, and the pair settles', async t => {
  const h = await started(t);
  pair(h);
  refusing(h, 1);
  await assert.rejects(h.work.endWork(ended()), /502 bad gateway/);
  h.wake();
  await h.lines.next('run.caughtup');
  assert.notEqual(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined);
  assert.equal(
    h.io.markClosing.mock.callCount(),
    2,
    'the final comment was posted again only because it had not landed',
  );
});

test('a label GitHub refuses is logged, and what it was marking for goes on', async t => {
  const h = await started(t);
  pair(h);
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  h.io.apply.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  await assert.rejects(h.work.endWork(ended()), /502/);
  assert.deepEqual(h.said('warn'), ['help.label.failed']);
  assert.equal(h.io.comment.mock.callCount(), 1, 'the person was told all the same');
});

test('a worker that may still be loose is said once, in the words of why, and the ticket is marked for a person', async t => {
  const h = await started(t);
  pair(h);
  pair(h, 'acme/shop#48', 'c9', 'ses_two');
  pair(h, 'acme/shop#49', 'c8', 'ses_three');
  const failure = (over: Partial<RunView>, code?: 'kill-unconfirmed' | 'stop-unconfirmed') =>
    runOf({
      state: 'failed',
      outcome: { kind: 'failure', reason: 'the worker would not stop', ...(code ? { code } : {}) },
      ...over,
    });
  await h.work.endWork(failure({}, 'kill-unconfirmed'));
  await h.work.endWork(failure({ id: 'run-2', ticketId: 'acme/shop#48', sessionId: 'ses_two' }, 'stop-unconfirmed'));
  await h.work.endWork(failure({ id: 'run-3', ticketId: 'acme/shop#49', sessionId: 'ses_three' }));
  assert.deepEqual(
    h.io.comment.mock.calls.map(call => call.arguments),
    [
      [
        CONVERSATION,
        'The dispatcher could not stop my worker session, so one may still be loose. I have marked this issue for a person.',
        'outcome',
      ],
      [
        'github:acme/shop#48:c9',
        'A person asked me to stop this worker, but my agent runtime would not answer the interrupt — it may still be running. I have marked this issue for a person.',
        'outcome',
      ],
    ],
    'a failure with no such code needs no help: the third run says nothing',
  );
  assert.deepEqual(
    h.io.apply.mock.calls.map(call => [call.arguments[0], call.arguments[1]]),
    [
      [CONVERSATION, 'acme/shop#47'],
      ['github:acme/shop#48:c9', 'acme/shop#48'],
    ],
  );
});

test('a person who was already told a closing failed is not told again that the worker may be loose', async t => {
  const h = await started(t);
  pair(h);
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  }, 0);
  const loose = runOf({
    state: 'failed',
    outcome: { kind: 'failure', reason: 'the worker would not stop', code: 'kill-unconfirmed' },
  });
  await assert.rejects(h.work.endWork(loose), /502/);
  h.wake();
  await h.lines.next('run.caughtup');
  assert.equal(h.io.comment.mock.callCount(), 1, 'the first cry was the help that is on its way');
  assert.equal(h.io.apply.mock.callCount(), 1);
});

test('a closing already owed is left to its first driver: a second ending of the run drives nothing', async t => {
  const h = await started(t);
  pair(h);
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  }, 0);
  await assert.rejects(h.work.endWork(ended()), /502/);
  await h.work.endWork(ended());
  assert.equal(h.io.resultShown.mock.callCount(), 1, 'the second ending found the debt owed and drove nothing');
});

test('a wake that arrives while a closing is in flight joins it: each word is said once', async t => {
  const h = await started(t);
  pair(h);
  const reached = Promise.withResolvers<void>();
  const landed = Promise.withResolvers<void>();
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    reached.resolve();
    await landed.promise;
  });
  const ending = h.work.endWork(ended());
  await reached.promise;
  h.wake();
  landed.resolve();
  await ending;
  await h.lines.next('run.caughtup');
  assert.equal(h.io.resultShown.mock.callCount(), 1, 'one drive: GitHub was asked about the result once');
  assert.equal(h.io.markClosing.mock.callCount(), 1, 'the final comment was posted once');
  assert.equal(h.io.freezeStatus.mock.callCount(), 1);
});

test('a ticket brought to us is held by the assistant: bound to its project, acknowledged, marked with the eyes, its dossier queued', async t => {
  const h = await started(t);
  await h.sink(brought());
  const binding = h.convos.sessionOf(TICKET)!;
  assert.deepEqual(
    { agent: binding.agent, directory: binding.directory, project: binding.project },
    { agent: 'assistant', directory: `${HOME}/projects/site/source`, project: 'site' },
  );
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [TICKET, 'One moment — reading acme/shop#47.', 'progress']);
  assert.deepEqual(h.api.addReaction.mock.calls[0]!.arguments, ['acme/shop#47', 'eyes']);
  const [turn] = h.convos.list();
  assert.deepEqual(
    [turn!.id, turn!.channel, turn!.user, turn!.name, turn!.state],
    ['created:acme/shop#47', TICKET, 'aivi-agent', 'GitHub', 'queued'],
  );
  assert.equal(
    turn!.text,
    `[platform: github; issue: acme/shop#47 "Fix it"; project: site; came by: a person brought you the issue]\n\n${DOSSIER}`,
  );
  assert.deepEqual(h.asked(), [{ service: 'github', pool: 'default' }], 'the engine asks for the turn queued for it');
});

test('the words a person arrived with ride the dossier; a mark GitHub refuses never costs the conversation', async t => {
  const h = await started(t);
  h.api.addReaction.mock.mockImplementationOnce(async () => {
    throw new Error('403');
  });
  await h.sink(brought({ promptContext: 'can you look at this?' }));
  assert.equal(
    h.convos.list()[0]!.text.endsWith(`${DOSSIER}\n\nThe person wrote on the ticket: can you look at this?`),
    true,
  );
  assert.deepEqual(h.said('warn'), ['reaction.failed']);
});

test('the assistant is the configured agent, and a ticket of no project is held in the home', async t => {
  const h = await start(world(t, undefined, 'helper'));
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ teamId: 'other/repo' }));
  await h.sink(brought());
  const binding = h.convos.sessionOf(TICKET)!;
  assert.deepEqual(
    { agent: binding.agent, directory: binding.directory, project: binding.project },
    { agent: 'helper', directory: HOME, project: null },
  );
  assert.match(h.convos.list()[0]!.text, /^\[platform: github; issue: acme\/shop#47 "Fix it"; project: none; came by:/);
});

test('a conversation the module holds, or a ticket a run is working, is a redelivery: nothing starts twice', async t => {
  const h = await started(t);
  h.convos.bind(TICKET, { agent: 'assistant', directory: HOME, project: null });
  await h.sink(brought());
  h.fakes.orchestrator.activeRun.mock.mockImplementationOnce(() => runOf({ ticketId: 'acme/shop#48' }));
  await h.sink(brought({ conversation: 'github:acme/shop#48', issueId: 'acme/shop#48' }));
  assert.equal(h.io.issue.mock.callCount(), 0, 'the ticket is not even read');
  assert.equal(h.io.comment.mock.callCount(), 0);
});

test('a ticket with the human label is refused for any agent, in the words of which label', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ labels: [{ id: 'l1', name: 'needs-human' }] }));
  await h.sink(brought());
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    TICKET,
    'acme/shop#47 carries the `needs-human` label, so a person handles it. Remove the label to let me work on it.',
    'outcome',
  ]);
  assert.deepEqual(h.lines.said('info').at(-1), {
    level: 'info',
    event: 'session.refused',
    conversation: TICKET,
    why: h.io.comment.mock.calls[0]!.arguments[1],
  });
  assert.equal(h.convos.has(TICKET), false, 'no conversation starts');
});

test('a hand-set Agent value gets one fixed answer: cleared, and said on the ticket — unless the ticket is finished', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'aivi-agent' }));
  await h.sink(brought());
  assert.deepEqual(h.io.unassign.mock.calls[0]!.arguments, [GITHUB_FEED, 'acme/shop#47']);
  assert.deepEqual(h.io.notify.mock.calls[0]!.arguments, [
    GITHUB_FEED,
    'acme/shop#47',
    'I looked into acme/shop#47, and there is nothing I can do at this time: work reaches me through the board, not through the `Agent` field: I start a worker myself once the ticket sits in a lane I work. I have cleared the `Agent` field — comment on the ticket if you want to talk about it.',
  ]);
  assert.equal(h.convos.has(TICKET), false);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'aivi-agent', completed: true }));
  await h.sink(brought({ conversation: 'github:acme/shop#48', issueId: 'acme/shop#48' }));
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    'github:acme/shop#48',
    'acme/shop#47 is already finished as far as work goes; nothing to start.',
    'outcome',
  ]);
  assert.equal(h.io.unassign.mock.callCount(), 1, 'a finished ticket’s value is left as it stands');
});

test('a clearing or a word GitHub refuses is logged; the refusal is never lost to silence', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'aivi-agent' }));
  for (const call of [h.io.unassign, h.io.notify])
    call.mock.mockImplementationOnce(async () => {
      throw new Error('403');
    });
  await h.sink(brought());
  assert.deepEqual(h.said('warn'), ['delegate.undone', 'notify.failed']);
});

test('a person’s comment on a ticket nothing knows brings it to the assistant, with the words they wrote', async t => {
  const h = await started(t);
  await h.sink(commented({ body: '  can you look at this?  ' }));
  assert.equal(h.convos.list()[0]!.text.endsWith('The person wrote on the ticket: can you look at this?'), true);
});

test('a comment with no words, or no body at all, starts nothing and reads nothing', async t => {
  const h = await started(t);
  const { body: _body, ...bodiless } = commented() as Extract<TrackerEvent, { kind: 'prompted' }>;
  await h.sink(commented({ body: '  \n ' }));
  await h.sink(bodiless);
  assert.equal(h.io.issue.mock.callCount() + h.io.comment.mock.callCount(), 0);
});

test('a comment on a conversation the assistant holds is queued behind its turn', async t => {
  const h = await started(t);
  h.convos.bind(TICKET, { agent: 'assistant', directory: HOME, project: null });
  await h.sink(commented({ id: 'comment:9', body: 'and one more thing' }));
  const [turn] = h.convos.list();
  assert.deepEqual(
    [turn!.id, turn!.channel, turn!.user, turn!.name, turn!.text],
    ['comment:9', TICKET, 'github', 'a person on GitHub', 'and one more thing'],
  );
  assert.equal(h.asked().length, 1, 'the engine asks for the turn queued behind');
});

test('a comment on a ticket whose pair never met a session is a brought ticket, not a run’s', async t => {
  const h = await started(t);
  h.links.bind('acme/shop#47:c1234', 'acme/shop#47');
  await h.sink(commented());
  assert.equal(h.convos.has(TICKET), true);
  assert.equal(h.fakes.orchestrator.runBySession.mock.callCount(), 0, 'a pair with no session names no run');
});

test('a comment on a finished run’s ticket is a follow-up: the assistant answers with how the run ended', async t => {
  const h = await started(t);
  const endings: [number, RunView][] = [
    [47, runOf({ state: 'completed', outcome: { kind: 'success', summary: 'Shipped it' } })],
    [
      48,
      runOf({
        state: 'failed',
        ticketId: 'acme/shop#48',
        sessionId: 'ses_48',
        outcome: { kind: 'failure', reason: 'the tests would not pass' },
      }),
    ],
    [49, runOf({ state: 'cancelled', ticketId: 'acme/shop#49', sessionId: 'ses_49' })],
  ];
  for (const [number, run] of endings) pair(h, `acme/shop#${number}`, 'c1', run.sessionId!);
  h.fakes.orchestrator.runBySession.mock.mockImplementation(
    session => endings.find(([, run]) => run.sessionId === session)?.[1],
  );
  for (const [number] of endings)
    await h.sink(commented({ conversation: `github:acme/shop#${number}`, body: 'is it live?' }));
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
    endings.map(([number]) => [GITHUB_FEED, `acme/shop#${number}`]),
    'the ticket is read afresh for each',
  );
});

test('a comment on a live run with a form open is the answer: the orchestrator delivers it, and the progress follows the work again', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.work.ready(runOf());
  await h.work.question(runOf(), { question: 'Which branch?' });
  h.session.form.list.mock.mockImplementationOnce(async () => [h.form]);
  await h.sink(commented());
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
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.session.form.list.mock.mockImplementation(async () => [h.form]);
  h.fakes.orchestrator.answer.mock.mockImplementationOnce(async () => ({ resumed: false, queued: 'q1' }));
  await h.sink(commented());
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    TICKET,
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
  await h.sink(commented({ id: 'comment:8' }));
  assert.deepEqual(h.io.comment.mock.calls[1]!.arguments, [
    TICKET,
    'The worker’s slot is gone and no capacity is free to wake it again — the pool behind its lane is full and its one queue place is taken. The question still stands: answer it again once a slot opens.',
    'outcome',
  ]);
});

test('an answer OpenCode will not take leaves the question standing, and the person hears that now', async t => {
  const h = await started(t);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.session.form.list.mock.mockImplementationOnce(async () => [h.form]);
  h.fakes.orchestrator.answer.mock.mockImplementationOnce(async () => {
    throw new Error('OpenCode is down');
  });
  await h.sink(commented());
  assert.deepEqual(h.said('warn'), ['answer.delivery.failed']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    TICKET,
    'I could not reach my agent runtime to wake the worker — the question still stands; answer it again once the runtime is back.',
    'outcome',
  ]);
});

test('a comment on a live run with no form open steers what comes next', async t => {
  const h = await started(t);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  await h.sink(commented({ body: 'also fix the test' }));
  const [prompt] = h.session.prompt.mock.calls.map(
    call => call.arguments[0] as { sessionID: string; id: string; text: string; delivery: string },
  );
  assert.deepEqual(
    { ...prompt!, id: undefined },
    { sessionID: 'ses_worker', id: undefined, text: 'also fix the test', delivery: 'steer' },
  );
  assert.match(prompt!.id, /^msg_[0-9a-f-]{36}$/);
  assert.deepEqual(h.lines.said('info').at(-1), { level: 'info', event: 'run.interjected', run: 'run-1' });
});

test('a steer with no turn to steer queues the same words; when both fail the person is told the message did not land', async t => {
  const h = await started(t);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  const down = async () => {
    throw new Error('no turn to steer');
  };
  h.session.prompt.mock.mockImplementationOnce(down, 0);
  await h.sink(commented({ body: 'first' }));
  assert.deepEqual(
    h.session.prompt.mock.calls.map(call => (call.arguments[0] as { delivery: string }).delivery),
    ['steer', 'queue'],
  );
  assert.deepEqual(h.said('warn'), ['run.steer.failed']);
  assert.deepEqual(h.lines.said('info').at(-1), { level: 'info', event: 'run.interjected.queued', run: 'run-1' });
  h.session.prompt.mock.mockImplementationOnce(down, 2);
  h.session.prompt.mock.mockImplementationOnce(down, 3);
  await h.sink(commented({ id: 'comment:8', body: 'second' }));
  assert.deepEqual(h.said('error'), ['run.interjection.lost']);
  assert.deepEqual(h.io.comment.mock.calls[0]!.arguments, [
    TICKET,
    'I could not carry that message — my agent runtime would not take it, to steer or to queue. Say it again.',
    'outcome',
  ]);
});

const human = [{ id: 'l1', name: 'needs-human' }];
const inLane = (name: string) => ({ id: `opt_${name}`, name, type: '' });

test('an update to a ticket of no project is ignored: nothing is cancelled, nothing woken', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ teamId: 'other/repo' }));
  await h.sink(updated(['state']));
  assert.equal(h.fakes.orchestrator.cancelWaiting.mock.callCount() + h.fakes.orchestrator.wake.mock.callCount(), 0);
});

test('a ticket a person deleted stops the run that works it; with no run there is nothing to stop', async t => {
  const h = await started(t);
  h.io.issue.mock.mockImplementation(async () => {
    throw gone();
  });
  h.fakes.orchestrator.activeRun.mock.mockImplementationOnce(() => runOf());
  await h.sink(updated(['archive']));
  assert.deepEqual(h.fakes.orchestrator.stop.mock.calls[0]!.arguments, [
    'run-1',
    'Stopped: acme/shop#47 was deleted; there is no work.',
  ]);
  await h.sink(updated(['archive']));
  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 1);
  assert.deepEqual(h.said('warn'), [], 'a deleted ticket is an answer, not a failure');
});

test('a hand-set Agent value on a ticket no run works gets the fixed refusal; our own run’s value passes', async t => {
  const h = await started(t);
  pair(h);
  h.io.issue.mock.mockImplementation(async () => issueOf({ delegateId: 'aivi-agent' }));
  await h.sink(updated(['delegate']));
  assert.deepEqual(h.io.unassign.mock.calls[0]!.arguments, [GITHUB_FEED, 'acme/shop#47']);
  assert.match(
    String(h.io.notify.mock.calls[0]!.arguments[2]),
    /work reaches me through the board, not through the `Agent` field/,
  );
  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 0);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  await h.sink(updated(['delegate']));
  assert.equal(h.io.unassign.mock.callCount(), 1, 'the run’s own initWork value is nobody’s hand-set one');
  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 0, 'and the delegate is still us: the run works on');
});

test('a person’s hand on a live run’s ticket stops it: the human label, a lane another agent works, the Agent value taken back', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  const hands: [TrackerChange, Partial<TrackerIssue>, string][] = [
    ['labels', { labels: human }, 'Stopped: `needs-human` was added to acme/shop#47; a person takes over.'],
    ['state', { state: inLane('Done') }, 'Stopped: acme/shop#47 moved to "Done", which is not my lane.'],
    ['delegate', { delegateId: null }, 'Stopped: I am no longer the delegate of acme/shop#47.'],
  ];
  for (const [change, over, words] of hands) {
    h.fakes.orchestrator.stop.mock.resetCalls();
    h.io.issue.mock.mockImplementationOnce(async () => issueOf(over));
    await h.sink(updated([change]));
    assert.deepEqual(h.fakes.orchestrator.stop.mock.calls[0]!.arguments, ['run-1', words]);
  }
});

test('a run whose Agent value a person takes back carries their label before the stop wakes the walk', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: null }));
  let labelledBeforeStop = -1;
  h.fakes.orchestrator.stop.mock.mockImplementationOnce(async () => {
    labelledBeforeStop = h.io.apply.mock.callCount();
  });
  await h.sink(updated(['delegate']));
  assert.equal(labelledBeforeStop, 1, 'or aivi would delegate itself again in the breath the person cleared the field');
  assert.deepEqual(h.io.apply.mock.calls[0]!.arguments, [
    GITHUB_FEED,
    'acme/shop#47',
    { kind: 'label', label: 'needs-human', on: true },
  ]);
});

test('a change that leaves a live run where it stands stops nothing: its lane keeps its agent, the delegate is still us', async t => {
  const h = await started(t);
  pair(h);
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => runOf());
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ state: inLane('In Progress') }));
  await h.sink(updated(['state']));
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: 'aivi-agent' }));
  await h.sink(updated(['delegate']));
  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 0);
});

// Known gap (docs/backlog, taking the ticket back during preparation): a run still getting ready has no
// session yet, so the Agent value taken back finds no conversation and stops nothing. The ruling moves the
// stop into the orchestrator; this test then flips.
test('an Agent value a person takes back while the worker is still getting ready stops nothing yet', async t => {
  const h = await started(t);
  pair(h);
  const { sessionId: _none, ...preparing } = runOf({ state: 'preparing' });
  h.fakes.orchestrator.activeRun.mock.mockImplementation(() => preparing as RunView);
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ delegateId: null }));

  await h.sink(updated(['delegate']));

  assert.equal(h.fakes.orchestrator.stop.mock.callCount(), 0);
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
      [['tracker-github', 'acme/shop#47']],
      `${lane}: the request is cancelled`,
    );
    assert.deepEqual(
      woken(),
      wakes ? [['site']] : [],
      `${lane}: ${wakes ? 'the walk looks' : 'out of sight, out of mind'}`,
    );
  }
  h.fakes.orchestrator.wake.mock.resetCalls();
  h.fakes.orchestrator.cancelWaiting.mock.resetCalls();
  h.io.issue.mock.mockImplementationOnce(async () => issueOf({ labels: human }));
  await h.sink(updated(['labels']));
  assert.deepEqual(woken(), [['site']], 'a label is a move too');
  h.fakes.orchestrator.wake.mock.resetCalls();
  h.fakes.orchestrator.cancelWaiting.mock.resetCalls();
  await h.sink(updated(['delegate']));
  assert.equal(
    h.fakes.orchestrator.cancelWaiting.mock.callCount() + h.fakes.orchestrator.wake.mock.callCount(),
    0,
    'an Agent value nobody holds is no move',
  );
});

test('the boot pass pays what a previous life owed: ended runs only, each asked of GitHub first', async t => {
  const w = world(t);
  const links = new RunLinks(w.store);
  for (const [number, session, created] of [
    [47, 'ses_ended', 100],
    [48, 'ses_live', 101],
    [49, 'ses_unknown', 102],
  ] as const) {
    links.bind(`acme/shop#${number}:c1`, `acme/shop#${number}`, created);
    links.attach(`acme/shop#${number}`, session);
  }
  const live = runOf({ id: 'run-live', ticketId: 'acme/shop#48', sessionId: 'ses_live' });
  const done = ended({ id: 'run-ended', ticketId: 'acme/shop#47', sessionId: 'ses_ended' });
  w.fakes.orchestrator.runBySession.mock.mockImplementation(
    session => ({ ses_ended: done, ses_live: live })[session as string],
  );
  const h = await start(w);
  assert.notEqual(h.links.byAgentSession('acme/shop#47:c1')?.endedAt, undefined, 'the ended run’s debt is paid');
  assert.equal(h.links.byAgentSession('acme/shop#48:c1')?.endedAt, undefined, 'a run still working owes nothing yet');
  assert.equal(h.links.byAgentSession('acme/shop#49:c1')?.endedAt, undefined, 'a run nobody knows is left as it is');
  assert.deepEqual(
    h.io.resultShown.mock.calls.map(call => call.arguments[0]),
    ['github:acme/shop#47:c1'],
    'the real state is asked about once, for the run that ended',
  );
});

test('a boot closing GitHub refuses does not stop the start: it stays owed for the next wake', async t => {
  const w = world(t);
  const links = new RunLinks(w.store);
  links.bind('acme/shop#47:c1', 'acme/shop#47');
  links.attach('acme/shop#47', 'ses_ended');
  w.fakes.orchestrator.runBySession.mock.mockImplementation(() => ended({ sessionId: 'ses_ended' }));
  w.io.markClosing.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  });
  const h = await start(w);
  assert.deepEqual(h.said('error'), ['closing.failed']);
  assert.equal(h.links.byAgentSession('acme/shop#47:c1')?.endedAt, undefined);
  h.wake();
  await h.lines.next('run.caughtup');
  assert.notEqual(h.links.byAgentSession('acme/shop#47:c1')?.endedAt, undefined);
});

test('a closing another driver landed meanwhile is not driven again by the wake that listed it', async t => {
  const h = await started(t);
  pair(h);
  pair(h, 'acme/shop#48', 'c9', 'ses_two');
  const second = ended({ id: 'run-2', ticketId: 'acme/shop#48', sessionId: 'ses_two' });
  // The first run's closing is owed; the second's is in flight on its own endWork.
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    throw new Error('502');
  }, 0);
  await assert.rejects(h.work.endWork(ended()), /502/);
  const secondAtGitHub = Promise.withResolvers<void>();
  const secondLands = Promise.withResolvers<void>();
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    secondAtGitHub.resolve();
    await secondLands.promise;
  }, 1);
  const secondEnding = h.work.endWork(second);
  await secondAtGitHub.promise;
  // A wake lists both and starts on the first, which waits at GitHub too.
  const firstAtGitHub = Promise.withResolvers<void>();
  const firstLands = Promise.withResolvers<void>();
  h.io.markClosing.mock.mockImplementationOnce(async () => {
    firstAtGitHub.resolve();
    await firstLands.promise;
  }, 2);
  h.wake();
  await firstAtGitHub.promise;
  secondLands.resolve();
  await secondEnding;
  firstLands.resolve();
  await h.lines.next('run.caughtup');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    h.io.markClosing.mock.callCount(),
    3,
    'the second run’s final comment was posted once, by its own ending',
  );
  assert.equal(h.io.freezeStatus.mock.callCount(), 2);
});
