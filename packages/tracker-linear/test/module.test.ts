/**
 * The module as a **follower**: it hands a delegation to the host's real
 * orchestrator and subscribes to its typed run events, and it posts into the
 * worker's OpenCode session itself — answers through the open form,
 * interjections as steers. These tests run module + orchestrator + a fake
 * OpenCode (sessions, prompts, session forms) + the tracker seam; the Linear
 * translation behind the real adapter (webhooks, GraphQL, activity types) is
 * `test/tracker.test.ts`'s subject, not this file's.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { KnowledgeService, LoadedConfig } from '@aivi/core';
import { configSchema, getLogger, parseDuration } from '@aivi/core';
import type { SessionEvents } from '@aivi/host';
import {
  Channels,
  connectOpenCode,
  Dispatcher,
  Forges,
  LeaseStore,
  Orchestrator,
  PublicRoutes,
  RunLedger,
  Store,
  TaskRegistry,
  ToolRegistry,
} from '@aivi/host';
import type { AiviServices } from '@aivi/plugin';
import type { ChannelDelivery } from '@aivi/plugin/channel';
import type { RunPlan, RunPlanStep, RunQuestion } from '@aivi/plugin/run';
import type {
  Platform,
  TrackerChange,
  TrackerCommentKind,
  TrackerEvent,
  TrackerIssue,
  TrackerUpdate,
} from '@aivi/plugin/tracker';
import type { LinearConfig } from '../src/config.ts';
import { linearSchema } from '../src/config.ts';
import { RunLinks } from '../src/links.ts';
import { createLinearModule, openLinearStore } from '../src/module.ts';
import type { LinearBoard } from '../src/work.ts';

const run = promisify(execFile);

/** The typed block out of the open core parse: the plugin's own schema fills defaults. */
const linearBlock = (config: { plugins: Record<string, unknown> }): LinearConfig =>
  linearSchema.parse(config.plugins['tracker-linear']);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);

/** A clone of a one-commit upstream, as every scenario's project checkout. */
async function checkout(root: string, project: string): Promise<string> {
  const upstream = join(root, 'upstream');
  await mkdir(upstream, { recursive: true });
  await writeFile(join(upstream, 'README.md'), 'r');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  const source = join(root, 'home/projects', project, 'source');
  await mkdir(join(root, 'home/projects', project), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  return source;
}

/** One pending session form, as the orchestrator's `ask` and the follower's
 *  answer path both read it. */
interface FakeForm {
  id: string;
  sessionID: string;
  title: string;
  answered: boolean;
  /** The field definitions as the orchestrator sent them: the proof that
   *  an options question stays open to the person's own words. */
  fields: unknown[];
}

/**
 * A tiny OpenCode: any session exists, every prompt gets the same answer,
 * and session forms live here the way they do for real — `form.list` answers
 * with the **pending** ones only (verified against the live service: a
 * replied form disappears), which is the whole discriminator between a
 * worker waiting on a person and a worker ending its turn too early.
 */
async function fakeOpenCode(t: { after(fn: () => Promise<void>): void }, answer: string) {
  const prompts: { id: string; text: string; delivery?: string; metadata: unknown }[] = [];
  const sessions = new Map<string, { agent: string; directory: string }>();
  const forms: FakeForm[] = [];
  const interrupted: string[] = [];
  // The dials a test turns while the server runs: `interruptFails` makes the
  // service answer 500 to an interrupt — the OpenCode-down moment a stop has
  // to tell honestly instead of claiming "stopped at your request".
  const ctl = { interruptFails: false };
  let formSeq = 0;
  /** The context of the last prompt. The transcript names the agent that ran;
   *  finalAnswer verifies it against the session's. */
  const contextBody = (url: string) => {
    const last = prompts.at(-1)!;
    const running = sessions.get(decodeURIComponent(url.split('/').at(-2)!))?.agent ?? 'developer';
    return JSON.stringify({
      data: [
        { type: 'user', id: last.id, text: last.text, time: { created: 1 } },
        {
          type: 'assistant',
          id: 'a',
          agent: running,
          finish: 'stop',
          time: { created: 2, completed: 3 },
          content: [{ type: 'text', text: answer }],
        },
        { type: 'idle', id: 'i', outcome: 'succeeded', time: { created: 4 } },
      ],
    });
  };
  /** One request: the canned routes answer from the url alone, the rest touch the state. */
  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, 'http://x').pathname;
    const method = req.method ?? 'GET';
    res.setHeader('content-type', 'application/json');
    if (url.startsWith('/api/agent')) return void res.end('{"data":[{"id":"developer","name":"developer"}]}');
    if (url.endsWith('/message')) return void res.end('{"data":[],"cursor":{"next":null}}');
    if (url.endsWith('/permission') && method === 'GET') return void res.end('{"data":[]}');
    if (url.endsWith('/interrupt')) {
      if (ctl.interruptFails) return void res.writeHead(500).end('{"error":"OpenCode is down"}');
      interrupted.push(decodeURIComponent(url.split('/').at(-2)!));
      return void res.end('{"interrupted":true}');
    }
    if (url.startsWith('/api/session/') && url.endsWith('/form')) {
      const sessionID = decodeURIComponent(url.split('/').at(-2)!);
      if (method === 'GET')
        return void res.end(
          JSON.stringify({
            data: forms
              .filter(f => !f.answered && f.sessionID === sessionID)
              .map(f => ({ id: f.id, sessionID: f.sessionID, title: f.title, fields: [] })),
          }),
        );
      const form: FakeForm = {
        id: `frm_test_${++formSeq}`,
        sessionID,
        title: String(body.title ?? ''),
        answered: false,
        fields: Array.isArray(body.fields) ? body.fields : [],
      };
      forms.push(form);
      return void res.end(JSON.stringify({ data: { id: form.id, sessionID, title: form.title, fields: [] } }));
    }
    if (url.endsWith('/reply') && method === 'POST') {
      const form = forms.find(f => f.id === decodeURIComponent(url.split('/').at(-2)!));
      if (!form || form.answered) return void res.writeHead(409).end('{"error":"already answered"}');
      form.answered = true;
      return void res.end('{"data":{}}');
    }
    // The turn machinery's real endpoints: a session update and the idle-wait
    // answer with no body (the /experimental wait is how a turn learns the
    // agent finished; 204 says it is done now).
    if (method === 'PATCH' || url.endsWith('/wait') || url.endsWith('/model')) return void res.writeHead(204).end();
    if (url === '/api/session' && method === 'POST') {
      sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/prompt')) {
      prompts.push({ id: body.id, text: body.text, delivery: body.delivery, metadata: body.metadata });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/context')) return void res.end(contextBody(url));
    const id = decodeURIComponent(url.split('/').at(-1)!);
    const session = sessions.get(id) ?? { agent: 'developer', directory: '/x' };
    res.end(JSON.stringify({ data: { id, ...session, location: { directory: session.directory } } }));
  };
  const server = createServer(respond);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, prompts, sessions, forms, interrupted, ctl };
}

/**
 * A tracker that records what the follower asks of it and serves neutral
 * issues — the seam the module decisions are tested through. It mirrors the
 * two Linear facts the follower's idempotence asks about: an `answer` or
 * `outcome` comment ends the agent session (so `resultShown` turns true, as
 * Linear's `endedAt` does), and a `move` updates the issue's state (so a
 * catch-up that already landed says nothing twice).
 */
class FakeTracker implements Platform {
  readonly id = 'linear';
  comments: { conversation: string; text: string; kind: TrackerCommentKind }[] = [];
  /** The app ids the module was configured with; conversations carry them. */
  readonly apps: string[];
  /** Which app a conversation belongs to, as the module names it. */
  app: Record<string, string> = {};
  issues = new Map<string, TrackerIssue>();
  /** Linear unreachable for the closings: results and closing notes throw
   *  while set — the outage the owed closing is built for. */
  closingDown = false;
  delegated: [string, string | null][] = [];
  sessionsCreated: string[] = [];
  moves: { conversation: string; issueId: string; update: TrackerUpdate }[] = [];
  shown = new Set<string>();
  /** Tickets whose delegate mutation lands and shows no new session:
   *  Linear's own silence, which the module must make visible on the ticket. */
  noSessionFor = new Set<string>();
  /** Plain ticket words left for runs that died before any session existed. */
  notified: { conversation: string; issueId: string; text: string }[] = [];
  private sessionsByIssue = new Map<string, string[]>();
  private sink: ((event: TrackerEvent) => Promise<void>) | undefined;

  constructor(config: LinearConfig) {
    this.apps = Object.keys(config.apps);
  }

  private conversation(conversation: string): string {
    this.app[conversation] ??= this.parts(conversation).app;
    return this.app[conversation]!;
  }

  async laneStates() {
    return [];
  }
  async issue(_conversation: string, issueId: string): Promise<TrackerIssue> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`no issue ${issueId}`);
    return issue;
  }
  async assign(_conversation: string, issueId: string, userId: string): Promise<void> {
    this.delegated.push([issueId, userId]);
    const issue = this.issues.get(issueId);
    if (issue) issue.delegateId = userId;
  }
  async unassign(_conversation: string, issueId: string): Promise<void> {
    this.delegated.push([issueId, null]);
    const issue = this.issues.get(issueId);
    if (issue) issue.delegateId = null;
  }
  async startSession(conversation: string, issueId: string): Promise<string | null> {
    await this.assign(conversation, issueId, this.ownerOf(conversation));
    if (this.noSessionFor.has(issueId)) return null; // the mutation lands; Linear says no session
    const made = `as-auto-${this.sessionsCreated.length + 1}`;
    this.sessionsCreated.push(issueId);
    this.sessionsByIssue.set(issueId, [...(this.sessionsByIssue.get(issueId) ?? []), made]);
    return made;
  }
  async notify(conversation: string, issueId: string, text: string): Promise<void> {
    this.notified.push({ conversation, issueId, text });
  }
  idFor(sessionId: string): string {
    return `${this.apps[0]}:${sessionId}`;
  }
  parts(conversation: string): { app: string; session: string } {
    const at = conversation.indexOf(':');
    return at < 0
      ? { app: conversation, session: '' }
      : { app: conversation.slice(0, at), session: conversation.slice(at + 1) };
  }
  async orgOf(): Promise<string> {
    return 'org';
  }
  ownerOf(conversation: string): string {
    return `app-user-${this.conversation(conversation)}`;
  }
  async comment(conversation: string, text: string, kind: TrackerCommentKind): Promise<string | undefined> {
    if (this.closingDown && (kind === 'answer' || kind === 'outcome'))
      throw new Error('Linear is unreachable for the closing');
    this.comments.push({ conversation, text, kind });
    if (kind === 'answer' || kind === 'outcome') this.shown.add(conversation);
    return undefined;
  }
  /** Linear's word for "the result was shown": the response ends the session. */
  async resultShown(conversation: string): Promise<boolean> {
    return this.shown.has(conversation);
  }
  /** Closing notes on the ticket, as the real adapter records them — and
   *  with the real adapter's idempotence: a note already standing for this
   *  issue and text is never posted twice. */
  closingNotes: { conversation: string; issueId: string; text: string }[] = [];
  async closingNote(conversation: string, issueId: string, text: string): Promise<void> {
    if (this.closingDown) throw new Error('Linear is unreachable for the closing');
    if (this.closingNotes.some(n => n.issueId === issueId && n.text === text)) return;
    this.closingNotes.push({ conversation, issueId, text });
  }
  /** Questions the follower rendered from the run's `question` events. */
  asks: { conversation: string; question: RunQuestion }[] = [];
  async ask(conversation: string, question: RunQuestion): Promise<void> {
    this.asks.push({ conversation, question });
  }
  plans: { conversation: string; steps: RunPlanStep[] }[] = [];
  async plan(conversation: string, plan: RunPlan): Promise<void> {
    this.plans.push({ conversation, steps: plan.steps });
  }
  async apply(conversation: string, issueId: string, update: TrackerUpdate): Promise<void> {
    this.moves.push({ conversation, issueId, update });
    const issue = this.issues.get(issueId);
    if (update.kind === 'move' && issue)
      issue.state = {
        id: `s-${update.lane}`,
        name: update.lane,
        type: update.lane === 'Done' ? 'completed' : 'started',
      };
    // A label lands on the issue, as Linear really does: the board's own
    // eligibility reads labels on the next walk, and a fake that only
    // *recorded* the mark would let the tests pretend a stop sticks.
    if (update.kind === 'label' && issue)
      issue.labels = update.on
        ? [...issue.labels, { id: `lbl-${update.label}`, name: update.label }]
        : issue.labels.filter(l => l.name !== update.label);
  }
  events(sink: (event: TrackerEvent) => Promise<void>): () => void {
    this.sink = sink;
    return () => {
      this.sink = undefined;
    };
  }
  /** What a delivered webhook would hand the module. */
  async drive(event: TrackerEvent): Promise<void> {
    if (!this.sink) throw new Error('the module never subscribed to events');
    await this.sink(event);
  }
  /** The module's own delivery surface, as the adapter's rendering would be. */
  delivery(): ChannelDelivery {
    return {
      send: (c, t) => this.comment(c, t, 'answer'),
      placeholder: (c, t) => this.comment(c, t, 'progress'),
      edit: async () => undefined,
      delete: async () => {},
      notice: async (c, t) => {
        this.comments.push({ conversation: c, text: t, kind: 'outcome' });
      },
    };
  }
  ofKind(kind: TrackerCommentKind) {
    return this.comments.filter(c => c.kind === kind);
  }
  answerWith(fragment: string): string {
    return this.ofKind('answer').find(c => c.text.includes(fragment))?.text ?? '';
  }
}

/** The tracker's issue facts, in the neutral shape the module reads. */
const issue = (id: string, extra: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id,
  identifier: id.toUpperCase(),
  title: 'Fix header',
  description: 'It overlaps',
  branchName: `me/${id}-fix-header`,
  url: `https://linear.app/x/issue/${id.toUpperCase()}`,
  state: { id: 's1', name: 'In Progress', type: 'started' },
  teamId: 't',
  labels: [],
  delegateId: 'app-user-dev', // webhook tickets arrive delegated to us: that is how Linear delivers
  assignee: { id: 'u', name: 'Me' },
  archived: false,
  completed: false,
  blockedBy: [],
  ...extra,
});

const noEvents: SessionEvents = { watch: () => () => {} };
/** A board with no projects on it: these tests drive runs through webhooks
 *  and the tools, and the eligibility walk never asks a Linear installation. */
const emptyBoard: LinearBoard = {
  projects: () => [],
  tickets: async () => [],
  moveTo: async () => {},
  issue: async () => undefined,
};

/** The board the walk reads, backed by the fake's issues — the same answers
 *  `linearBoard` gives: eligible means alive, unlabeled, un-delegated and
 *  unblocked, and
 *  a move lands on the issue itself so the next read says what Linear was
 *  told. `shownAtMove` records whether the closing words had been posted
 *  when each move was performed: the proof that the tracker speaks first. */
function fakeBoard(
  tracker: FakeTracker,
  projectId: string,
  branchName = '', // Linear names the ticket's branch; '' where no lane is worktree:true
): LinearBoard & { moves: string[]; shownAtMove: boolean[] } {
  const moves: string[] = [];
  const shownAtMove: boolean[] = [];
  return {
    moves,
    shownAtMove,
    projects: () => [projectId],
    tickets: async (p, lane) =>
      [...tracker.issues.values()]
        .filter(
          i => !i.archived && i.state.name === lane && !i.labels.some(l => l.name === 'needs-human') && !i.delegateId, // ruled 2026-10-02: a delegated ticket is not eligible
        )
        .map(i => ({ id: i.id, blocked: i.blockedBy.some(b => !b.completed) })),
    moveTo: async (p, ticketId, lane) => {
      shownAtMove.push([...tracker.shown].length > 0);
      moves.push(`${ticketId}->${lane}`);
      const moved = tracker.issues.get(ticketId);
      if (moved) moved.state = { id: `s-${lane}`, name: lane, type: lane === 'Done' ? 'completed' : 'started' };
    },
    issue: async ticketId => {
      const found = tracker.issues.get(ticketId);
      if (!found || found.archived) return undefined;
      return {
        identifier: found.identifier,
        title: found.title,
        description: found.description,
        teamId: found.teamId,
        stateName: found.state.name,
        branchName, // named by the harness: '' where no lane here is worktree:true
      };
    },
  };
}
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};
const knowledge: KnowledgeService = { search: async () => [], index: async () => ({}), close: async () => {} };

/** The services a module starts with: the **real** orchestrator over the same
 *  Store, watching nothing (no live turn ends; the tools drive the run). The
 *  boot-reconcile test passes the same orchestrator to a second module. */
function makeServices(loaded: LoadedConfig, store: Store, abort: AbortController): AiviServices {
  const opencode = () => connectOpenCode(loaded.config.opencode, {});
  const orchestrator = new Orchestrator({
    ledger: new RunLedger(store),
    opencode,
    events: noEvents,
    log: getLogger(['aivi']),
    signal: abort.signal,
    lanes: id => loaded.config.projects[id]?.lanes ?? [],
    directory: id => {
      const project = loaded.projects.find(pr => pr.id === id);
      if (!project) throw new Error(`no project ${id}`);
      return project.directory;
    },
    // No pools configured here: the dispatcher tracks every lease and grants
    // every request — the same capacity the tests always had.
    dispatcher: new Dispatcher({
      leases: new LeaseStore(store),
      dispatcher: loaded.config.dispatcher,
      opencode,
      signal: abort.signal,
    }),
    forges: new Forges(),
    identity: async () => ({ name: 't', email: 't@t' }),
    keepAliveMs: parseDuration(loaded.config.orchestrator.elicitationKeepAlive),
  });
  return {
    loaded,
    store,
    knowledge,
    opencode,
    events: noEvents,
    signal: abort.signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
    tools: new ToolRegistry().forModule('test'),
    forges: new Forges(),
    orchestrator,
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
}

/** A second pair of services for a module restarting over the same store and
 *  orchestrator: fresh registries, same durable state. */
function restartServices(base: AiviServices): AiviServices {
  return {
    ...base,
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test2'),
    tools: new ToolRegistry().forModule('test2'),
    fail: error => assert.fail(String(error)),
  };
}

/** The worker session the orchestrator made for a ticket, from the fake's keys. */
const workerSession = (sessions: Map<string, unknown>, since = 0) =>
  [...sessions.keys()].filter(id => id.startsWith('ses_orchestrator_'))[since]!;

test('a walk-picked run runs the lane agent; plan, question, answer and interjection reach the worker; the ending catches Linear up in order; hand delegations get one fixed refusal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'website');
  const home = join(root, 'home');

  // The one app keeps the bare names; the face uses its own. Lanes are core's
  // ordered array; the plugin block maps teams and names the assistant.
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    plugins: { 'tracker-linear': { agent: 'assistant', primary: 'dev', apps: { dev: {}, face: {} }, mcp: false } },
    projects: {
      website: {
        'tracker-linear': { teams: ['t', 'tx'] },
        lanes: [{ name: 'Backlog' }, { name: 'Todo' }, { name: 'In Progress', agent: 'developer' }, { name: 'Done' }],
      },
    },
  });
  const opencode = await fakeOpenCode(t, 'The header change touched two files.');
  config.opencode.url = opencode.url;
  const loaded: LoadedConfig = {
    config,
    path: join(home, 'config.json'),
    projects: [{ id: 'website', directory: source, lanes: config.projects.website!.lanes! }],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  // Only eng-1 sits in a walked lane: the others wait in Backlog or carry a
  // person's mark, and arrive in this test through webhooks, as themselves.
  const backlog = { id: 's-bl', name: 'Backlog', type: 'unstarted' as const };
  for (const seeded of [
    issue('eng-1', { delegateId: null }),
    issue('eng-2', { labels: [{ id: 'l', name: 'needs-human' }] }),
    issue('eng-3', { teamId: 't9', state: backlog }),
    issue('eng-5', { state: { id: 's9', name: 'Deploy', type: 'started' } }),
    issue('eng-6', { delegateId: null, state: backlog }),
    issue('eng-7', { archived: true }),
    issue('eng-8', { teamId: 't9', delegateId: null, state: backlog }),
    issue('eng-4', { teamId: 'tx', state: backlog }),
  ])
    tracker.issues.set(seeded.id, seeded);
  const board = fakeBoard(tracker, 'website');

  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator as Orchestrator; // the test drives the tool handlers directly
  const links = new RunLinks(store);

  const started = (conversation: string, issueId: string) =>
    tracker.drive({
      kind: 'started',
      conversation,
      issueId,
      promptContext: `<issue identifier="${issueId.toUpperCase()}"><title>Fix header</title></issue>`,
    });

  // The walk's claim: initWork delegates the ticket to our own app, Linear's
  // answer carries the agent session and serves as the ticket's summary, the
  // pair is recorded before anything arrives, and "preparing the workspace"
  // is the new session's first word.
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the worker was prompted');
  assert.equal(tracker.comments[0]!.kind, 'progress', 'the new session hears first');
  assert.match(tracker.comments[0]!.text, /Preparing the workspace/);
  const worker = workerSession(opencode.sessions);
  assert.equal(opencode.sessions.get(worker)!.agent, 'developer');
  assert.equal(opencode.sessions.get(worker)!.directory, source, 'the checkout is the work directory');
  assert.deepEqual(
    links.byAgentSession('as-auto-1'),
    { agentSession: 'as-auto-1', ticketId: 'eng-1', opencodeSession: worker },
    'the delegation Linear answered is the pair we keep',
  );
  assert.match(opencode.prompts[0]!.text, /<issue identifier="ENG-1">/);
  assert.match(
    opencode.prompts[0]!.text,
    /Never declare completion in plain text/,
    'the worker contract travels with the task',
  );
  assert.equal(opencode.prompts[0]!.delivery, 'queue');

  // The plan is a forwarding: the whole checklist arrives as the worker posts it.
  await orchestrator.planTool({
    sessionId: worker,
    input: { steps: [{ content: 'Read the header styles', status: 'inProgress' }] },
  });
  assert.deepEqual(tracker.plans, [
    { conversation: 'dev:as-auto-1', steps: [{ content: 'Read the header styles', status: 'inProgress' }] },
  ]);

  // The question: the ask tool's OpenCode form is the record; the follower
  // renders Linear's elicitation from the event.
  await orchestrator.askTool({
    sessionId: worker,
    input: { question: 'Which blue?', options: [{ label: 'Teal', value: 'teal' }] },
  });
  assert.deepEqual(tracker.asks, [
    {
      conversation: 'dev:as-auto-1',
      question: { question: 'Which blue?', options: [{ label: 'Teal', value: 'teal' }], formId: opencode.forms[0]!.id },
    },
  ]);
  assert.deepEqual(
    (opencode.forms[0]!.fields as { key: string; options?: unknown[]; custom?: boolean }[]).map(f => ({
      key: f.key,
      suggestions: f.options !== undefined,
      freeText: f.custom === true,
    })),
    [{ key: 'answer', suggestions: true, freeText: true }],
    'the options are suggestions: a person who types their own answer can close the form',
  );
  assert.equal(
    opencode.forms.filter(f => !f.answered && f.sessionID === worker).length,
    1,
    'the form waits in OpenCode',
  );

  // The answer: the pending form is the discriminator — the worker gets the
  // text, the form closes as the record.
  await tracker.drive({ kind: 'prompted', id: 'act-a1', conversation: 'dev:as-auto-1', body: 'Use teal' });
  await until(() => opencode.forms[0]!.answered, 'the form was answered');
  const answered = opencode.prompts.find(p => p.text.startsWith('The person answered your question:'));
  assert.equal(answered!.text, 'The person answered your question: Use teal');
  assert.equal(answered!.delivery, 'queue');

  // An interjection with no form open steers the running turn.
  await tracker.drive({ kind: 'prompted', id: 'act-i1', conversation: 'dev:as-auto-1', body: 'Also fix the footer' });
  await until(
    () => opencode.prompts.some(p => p.text === 'Also fix the footer'),
    'the interjection reached the session',
  );
  assert.equal(opencode.prompts.find(p => p.text === 'Also fix the footer')!.delivery, 'steer');

  // The ending, in the operator's order: the tracker speaks its closing
  // words (the result completes the agent session and stops Linear's
  // spinner), only then does the orchestrator perform the move its lane
  // order chose, and lastly the lease returns.
  await orchestrator.completeTool({
    sessionId: worker,
    input: { outcome: 'success', summary: 'Header aligned.' },
  });
  await until(() => tracker.ofKind('answer').some(c => c.text === 'Header aligned.'), 'the closing words landed');
  // The closing is the tracker's awaited stage: wait for the whole ceremony.
  await until(
    () => board.moves.length === 1 && tracker.delegated.at(-1)?.[1] === null,
    'the move and the delegate catch-up landed',
  );
  assert.deepEqual(
    tracker.closingNotes,
    [{ conversation: 'dev:as-auto-1', issueId: 'eng-1', text: 'Header aligned.' }],
    'the ending is readable on the ticket itself, not only in the session',
  );
  assert.deepEqual(board.moves, ['eng-1->Done'], 'the orchestrator performed the move its lane order chose');
  assert.deepEqual(board.shownAtMove, [true], 'the closing words were Linear-real before the move was performed');
  assert.deepEqual(tracker.delegated.at(-1), ['eng-1', null], 'the delegate was un-taken');
  const ended = orchestrator.runBySession(worker)!;
  assert.deepEqual(
    [ended.state, ended.targetLane, ended.outcome],
    ['completed', undefined, { kind: 'success', summary: 'Header aligned.' }],
    'the move landed, so the debt is paid and the target lane goes quiet',
  );

  // Linear's own webhook for the delegation initWork made is a redelivery:
  // the pair and the live run fold it into the work already started.
  const quietComments = tracker.comments.length;
  await started('dev:as-auto-1', 'eng-1');
  assert.equal(tracker.comments.length, quietComments, 'a redelivery is a no-op');

  // A follow-up into the finished conversation is the assistant's: the person
  // talks to aivi, with the ticket read afresh.
  await tracker.drive({ kind: 'prompted', id: 'act-f1', conversation: 'dev:as-auto-1', body: 'What did you change?' });
  await until(
    () =>
      opencode.prompts.some(
        p =>
          p.text.startsWith('[Linear follow-up from Linear]') &&
          p.text.includes('The person now says: What did you change?'),
      ),
    'the follow-up reached the assistant',
  );
  assert.ok(
    [...opencode.sessions.values()].some(s => s.agent === 'assistant' && s.directory === source),
    'the assistant answers in the project checkout',
  );
  const inbox = openLinearStore(store);
  await until(() => inbox.list().every(x => x.state === 'sent'), 'and answered');
  // A stop with nothing running says so plainly.
  await tracker.drive({ kind: 'prompted', id: 'act-s', conversation: 'dev:as-auto-1', signal: 'stop' });
  await until(
    () => tracker.ofKind('answer').some(c => c.text === 'Nothing is running right now.'),
    'stop with nothing running',
  );

  // The HITL label refuses any agent: an outcome in the session, no run.
  await started('dev:as-2', 'eng-2');
  await until(() => tracker.ofKind('outcome').some(c => /needs-human/.test(c.text)), 'HITL refused');
  assert.equal(orchestrator.activeRun('tracker-linear', 'eng-2'), undefined, 'and no run was made');

  // A deleted ticket is gone as far as work is concerned: not even a refusal.
  const quietAfter = tracker.comments.length;
  const quietPrompts = opencode.prompts.length;
  await started('dev:as-7', 'eng-7');
  assert.equal(tracker.comments.length, quietAfter, 'the archived ticket gets no comment');
  assert.equal(opencode.prompts.length, quietPrompts, 'the archived ticket starts no agent');

  // A hand delegation whose team maps no project: one fixed refusal and the
  // delegate un-taken. No agent improvises over a job the config never claimed.
  await started('dev:as-3', 'eng-3');
  await until(() => tracker.answerWith('ENG-3') !== '', 'the delegation was refused');
  assert.match(tracker.answerWith('ENG-3'), /work reaches me through the board, not through a delegation/);
  assert.match(tracker.answerWith('ENG-3'), /removed myself as delegate/);
  assert.deepEqual(tracker.delegated.at(-1), ['eng-3', null], 'the delegation was un-taken');

  // A delegation into a state that is no lane of the project: the same fixed
  // refusal — the answer is fixed, the lanes never vary it.
  await started('dev:as-5', 'eng-5');
  await until(() => tracker.answerWith('ENG-5') !== '', 'the not-a-lane delegation was refused alike');
  assert.match(tracker.answerWith('ENG-5'), /work reaches me through the board, not through a delegation/);
  assert.deepEqual(tracker.delegated.at(-1), ['eng-5', null], 'un-taken as well');

  // A mention (not a delegation) on a team no project maps still reaches the
  // assistant, and the assistant works from the home then.
  await started('dev:as-8', 'eng-8');
  await until(
    () => [...opencode.sessions.values()].some(s => s.agent === 'assistant' && s.directory === home),
    'the unmapped-team mention reached the assistant, in the home',
  );

  // A mention on the face reaches the same assistant; a mention is not un-delegated.
  await tracker.drive({
    kind: 'started',
    conversation: 'face:as-6',
    issueId: 'eng-6',
    promptContext: '<issue identifier="ENG-6">…</issue>',
  });
  await until(() => inbox.sessionOf('face:as-6')?.agent === 'assistant', 'the face mention became a turn');
  assert.deepEqual(
    tracker.delegated.filter(d => d[0] === 'eng-6'),
    [],
    'a mention is not un-delegated',
  );

  // A hand delegation on the second mapped team: the same fixed refusal. The
  // mapping decides what the walk starts, never what a delegation becomes —
  // teams is a list on purpose, and the walk proved it with eng-1.
  await started('dev:as-4', 'eng-4');
  await until(() => tracker.answerWith('ENG-4') !== '', 'the mapped-team delegation was refused alike');
  assert.match(tracker.answerWith('ENG-4'), /work reaches me through the board, not through a delegation/);
  assert.deepEqual(tracker.delegated.at(-1), ['eng-4', null], 'un-taken as well');
});

test('a worked lane runs its agent in the project checkout; the ending without a next lane goes silent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'site');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    plugins: { 'tracker-linear': { apps: { dev: {} }, mcp: false } },
    projects: {
      site: {
        'tracker-linear': { teams: ['t'] },
        lanes: [{ name: 'Research', agent: 'researcher' }],
      },
    },
  });
  const opencode = await fakeOpenCode(t, 'Answered.');
  config.opencode.url = opencode.url;
  const loaded: LoadedConfig = {
    config,
    path: join(root, 'home/config.json'),
    projects: [{ id: 'site', directory: source, lanes: config.projects.site!.lanes! }],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  tracker.issues.set(
    'site-1',
    issue('site-1', {
      identifier: 'SITE-1',
      title: 'What ships next',
      description: null,
      branchName: 'me/site-1',
      state: { id: 's', name: 'Research', type: 'started' },
      delegateId: null, // un-delegated: eligible for the walk
    }),
  );
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const board = fakeBoard(tracker, 'site');
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await services.orchestrator.wake('site');
  await until(() => opencode.prompts.length === 1, 'the researcher was prompted');
  const worker = workerSession(opencode.sessions);
  assert.deepEqual(opencode.sessions.get(worker), { agent: 'researcher', directory: source });
  assert.match(
    opencode.prompts[0]!.text,
    /You work in the project's checkout/,
    'the prompt says where the agent works',
  );
  assert.ok(
    tracker.ofKind('progress').some(c => /Preparing the workspace/.test(c.text)),
    'the new session hears its first word',
  );
  // The only lane of the array: success has nowhere configured to go and the
  // next-lane default names none — the ticket stays, unconfigured is silent.
  await (services.orchestrator as Orchestrator).completeTool({
    sessionId: worker,
    input: { outcome: 'success', summary: 'A report.' },
  });
  await until(
    () => tracker.ofKind('answer').some(c => c.text === 'A report.') && tracker.delegated.at(-1)?.[1] === null,
    'the result was posted and the delegate un-taken',
  );
  assert.deepEqual(board.moves, [], 'no move for a run at the end of the lane order');
  assert.equal(services.orchestrator.runBySession(worker)!.targetLane, undefined);
  assert.ok(
    tracker.delegated.some(d => d[0] === 'site-1' && d[1] === null),
    'the success still un-takes the delegate',
  );
  // And the ticket, still sitting in the only worked lane with nowhere
  // configured to go, is work again: the walk starts it fresh. An ending
  // releases; only a person's move or label says otherwise (ruled 2026-10-02).
  await until(
    () => tracker.delegated.at(-1)?.[1] === 'app-user-dev',
    'the worked lane takes the ticket again — endings release, they do not blacklist',
  );
});

test('a lane move is a wake: the walk starts the ticket it finds, a stop ends the run and says so in Linear; a blocked issue waits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-listener-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'api');
  const opencode = await fakeOpenCode(t, 'Shipped.');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    plugins: { 'tracker-linear': { apps: { dev: {} }, mcp: false } },
    projects: {
      api: {
        'tracker-linear': { teams: ['t'] },
        lanes: [{ name: 'Todo' }, { name: 'In Progress', agent: 'developer' }, { name: 'Review' }, { name: 'Done' }],
      },
    },
  });
  const loaded: LoadedConfig = {
    config,
    path: join(root, 'home/config.json'),
    projects: [{ id: 'api', directory: source, lanes: config.projects.api!.lanes! }],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  const api = issue('api-7', {
    identifier: 'API-7',
    title: 'Add rate limits',
    description: null,
    branchName: 'me/api-7-rate-limits',
    state: { id: 'todo', name: 'Todo', type: 'unstarted' },
    delegateId: null,
  });
  tracker.issues.set('api-7', api);
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const board = fakeBoard(tracker, 'api');
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator as Orchestrator; // the test drives the tool handlers directly
  const updated = async (changed: TrackerChange[]) => {
    await tracker.drive({ kind: 'updated', conversation: 'dev', issueId: 'api-7', changed });
  };

  // A title edit is not a routing change: nothing happens.
  await updated([]);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(tracker.sessionsCreated, []);

  // The platform's own blocking: a blocker not in a finished state holds the
  // walk back — the ticket waits, and the board says nothing of it.
  api.blockedBy = [{ id: 'b', completed: false }];
  api.state = { id: 'prog', name: 'In Progress', type: 'started' };
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(tracker.sessionsCreated, [], 'a blocked issue is not picked up');
  api.blockedBy = [{ id: 'b', completed: true }];
  await updated(['state']);
  await until(() => tracker.sessionsCreated.length === 1, 'the walk opened the ticket on its own app');
  assert.deepEqual(tracker.delegated.at(-1), ['api-7', 'app-user-dev']);
  await until(() => opencode.prompts.length === 1, 'the worker was prompted');
  const worker = workerSession(opencode.sessions);
  const run = orchestrator.activeRun('tracker-linear', 'api-7')!;
  assert.equal(run.sessionId, worker);
  // The same move again — a wake is a wake: the live run answers it and no
  // second worker opens.
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.sessions.size, 1, 'a redelivery starts nothing new');

  // In Progress → Review names a different agent: the update orphans the run.
  // The stop is the orchestrator's (interrupt + cancel); the tracker speaks
  // the ending — the reason as Linear's error activity, and no move: a
  // stopped ticket stays where the person left it.
  api.state = { id: 'rev', name: 'Review', type: 'started' };
  await updated(['state']);
  await until(
    () => tracker.ofKind('outcome').some(c => /moved to "Review", which is not my lane/.test(c.text)),
    'the orphaned run was stopped and said',
  );
  assert.ok(
    tracker.closingNotes.some(n => n.issueId === 'api-7' && /moved to "Review"/.test(n.text)),
    'and the stop is readable on the ticket too',
  );
  assert.deepEqual(opencode.interrupted, [worker], 'the OpenCode session was interrupted');
  assert.equal(orchestrator.activeRun('tracker-linear', 'api-7'), undefined, 'the run is over');
  assert.deepEqual(tracker.moves, [], 'a stop moves nothing');
  await until(
    () => api.delegateId === null,
    'even a stopped run releases the delegate: endings release, they do not blacklist',
  );

  // A stopped run remembers nothing (ruled 2026-10-02): the ending released
  // the delegate, the person moves the ticket back to a worked lane, and
  // the walk takes it as fresh work. Then the HITL label stops the new worker.
  api.state = { id: 'prog', name: 'In Progress', type: 'started' };
  await updated(['state', 'delegate']);
  await until(() => opencode.prompts.length === 2, 'a stop releases the ticket: the walk starts it afresh');
  api.labels = [{ id: 'l', name: 'needs-human' }];
  await updated(['labels']);
  await until(
    () => tracker.ofKind('outcome').some(c => /needs-human.*was added to API-7/.test(c.text)),
    'the label stopped the run',
  );
  assert.equal(orchestrator.activeRun('tracker-linear', 'api-7'), undefined);
});

test('a run that dies before its session exists leaves a plain word on the ticket, and the walk does not knock twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-earlydeath-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'api');
  const opencode = await fakeOpenCode(t, 'Shipped.');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    plugins: { 'tracker-linear': { apps: { dev: {} }, mcp: false } },
    projects: {
      api: {
        'tracker-linear': { teams: ['t'] },
        lanes: [{ name: 'Todo' }, { name: 'In Progress', agent: 'developer' }, { name: 'Done' }],
      },
    },
  });
  const loaded: LoadedConfig = {
    config,
    path: join(root, 'home/config.json'),
    projects: [{ id: 'api', directory: source, lanes: config.projects.api!.lanes! }],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  tracker.noSessionFor.add('api-7'); // Linear takes the delegation and answers no session
  tracker.issues.set(
    'api-7',
    issue('api-7', {
      identifier: 'API-7',
      title: 'Add rate limits',
      description: null,
      branchName: 'me/api-7-rate-limits',
      state: { id: 'prog', name: 'In Progress', type: 'started' },
      delegateId: null,
    }),
  );
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const board = fakeBoard(tracker, 'api');
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator as Orchestrator;

  // Seven runs died between the delegation and the session and said nothing
  // anywhere (live, 2026-10-02). Now the ticket itself carries the plain word.
  await orchestrator.wake('api');
  await until(() => tracker.notified.length === 1, 'the plain word landed on the ticket');
  assert.equal(tracker.notified[0]!.conversation, 'dev', 'the app feed speaks — there is no session yet');
  assert.equal(tracker.notified[0]!.issueId, 'api-7');
  assert.match(tracker.notified[0]!.text, /^I could not start work on this ticket: Linear made no agent session/);
  assert.match(tracker.notified[0]!.text, /clear the delegate/, 'the person is told what un-strands it');
  assert.equal(opencode.prompts.length, 0, 'no worker was prompted for a run that never opened');
  assert.equal(orchestrator.activeRun('tracker-linear', 'api-7'), undefined, 'the failed run does not stand');

  // The death leaves the delegate sitting, and a delegated ticket is not
  // eligible: one plain word, not seven silent retries.
  await orchestrator.wake('api');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(tracker.notified.length, 1, 'the walk does not knock twice');
  assert.equal(tracker.sessionsCreated.length, 0, 'and never delegates again');
});

test('boot reconcile pays a closing Linear missed, and says nothing twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-boot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'api');
  const opencode = await fakeOpenCode(t, 'Deployed.');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    plugins: { 'tracker-linear': { apps: { dev: {} }, mcp: false } },
    projects: {
      api: {
        'tracker-linear': { teams: ['t'] },
        lanes: [{ name: 'Todo' }, { name: 'In Progress', agent: 'developer' }, { name: 'Done' }],
      },
    },
  });
  const loaded: LoadedConfig = {
    config,
    path: join(root, 'home/config.json'),
    projects: [{ id: 'api', directory: source, lanes: config.projects.api!.lanes! }],
    sources: [],
  };
  const first = new FakeTracker(linearBlock(config));
  first.issues.set('api-9', issue('api-9', { identifier: 'API-9', title: 'Ship it', delegateId: null }));
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const board = fakeBoard(first, 'api');
  const running = await createLinearModule(
    linearBlock(config),
    async () => first,
    () => board,
  ).start(services);

  // The walk opens the ticket and the worker starts...
  await services.orchestrator.wake('api');
  await until(() => opencode.prompts.length === 1, 'the worker was prompted');
  const worker = workerSession(opencode.sessions);

  // ...and the run completes while Linear is unreachable for the closing.
  // The closing fails — and a person hears of it the moment it does (ruled
  // 2026-10-02: the operator must be informed): the help label rides the
  // ticket, while the ticket still moves and the lease still returns.
  first.closingDown = true;
  await (services.orchestrator as Orchestrator).completeTool({
    sessionId: worker,
    input: { outcome: 'success', summary: 'It ships.' },
  });
  await until(() => board.moves.length === 1, 'the move lands even though the closing failed');
  assert.equal(first.ofKind('answer').length, 0, 'the closing words did not land');
  assert.deepEqual(
    first.moves.map(m => m.update),
    [{ kind: 'label', label: 'needs-human', on: true }],
    'a person was asked for help the moment the closing failed',
  );

  // A boot pass: the pair survives in the tracker's own table — initWork
  // bound it for every run, walk-picked included; the run record says ended;
  // Linear is caught up — result, note, delegate.
  first.closingDown = false;
  await running.stop();
  const second = new FakeTracker(linearBlock(config));
  second.issues.set(
    'api-9',
    issue('api-9', {
      identifier: 'API-9',
      title: 'Ship it',
      state: { id: 's-Done', name: 'Done', type: 'completed' },
    }),
  );
  const restarted = await createLinearModule(
    linearBlock(config),
    async () => second,
    () => board,
  ).start(restartServices(services));
  assert.deepEqual(
    second.comments.filter(c => c.conversation === 'dev:as-auto-1').map(c => [c.kind, c.text]),
    [['answer', 'It ships.']],
    'the owed closing is paid at boot',
  );
  assert.deepEqual(
    second.closingNotes.map(n => n.text),
    ['It ships.'],
    'and the note on the ticket too',
  );
  assert.deepEqual(second.delegated.at(-1), ['api-9', null], 'and the delegate is un-taken');

  // And a third boot says nothing twice: Linear itself says the result was
  // shown (the agent session is ended) and the state is where the move put
  // it — the tracker asks the platform, never a flag of its own.
  await restarted.stop();
  const third = new FakeTracker(linearBlock(config));
  third.issues.set(
    'api-9',
    issue('api-9', {
      identifier: 'API-9',
      title: 'Ship it',
      state: { id: 's-Done', name: 'Done', type: 'completed' },
      delegateId: null,
    }),
  );
  third.shown.add('dev:as-auto-1');
  // Linear's real state carries the standing closing note too: the third
  // boot must not post it twice (the marker is the agent session id, which
  // the fake's text-equality guard stands in for).
  third.closingNotes.push({ conversation: 'dev:as-auto-1', issueId: 'api-9', text: 'It ships.' });
  const again = await createLinearModule(
    linearBlock(config),
    async () => third,
    () => board,
  ).start(restartServices(services));
  assert.deepEqual(third.comments, [], 'a catch-up that already happened is silent');
  assert.deepEqual(board.moves, ['api-9->Done'], 'and nothing re-moves');
  assert.equal(third.closingNotes.length, 1, 'a standing closing note is not posted twice');
  await again.stop();
  store.close();
});

async function walkHarness(t: { after(fn: () => Promise<void>): void }, opts: { worktree?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'website');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    plugins: { 'tracker-linear': { agent: 'assistant', primary: 'dev', apps: { dev: {} }, mcp: false } },
    projects: {
      website: {
        'tracker-linear': { teams: ['t'] },
        lanes: [
          { name: 'Backlog' },
          { name: 'Todo', queue: true },
          { name: 'In Progress', agent: 'developer', ...(opts.worktree ? { worktree: true } : {}) },
          { name: 'Done' },
        ],
      },
    },
  });
  const opencode = await fakeOpenCode(t, 'unused here');
  config.opencode.url = opencode.url;
  const loaded: LoadedConfig = {
    config,
    path: join(root, 'config.json'),
    projects: [{ id: 'website', directory: source, lanes: config.projects.website!.lanes! }],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  tracker.issues.set('eng-1', issue('eng-1', { delegateId: null }));
  const board = fakeBoard(tracker, 'website', opts.worktree ? 'me/eng-1' : '');
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  return {
    tracker,
    config,
    store,
    services,
    board,
    opencode,
    source,
    orchestrator: services.orchestrator as Orchestrator,
  };
}

test('a picked-up run’s ending is said in the session its own delegation opened — and a stop sticks: the ticket waits for a person', async t => {
  const { tracker, config, store, services, board, opencode, orchestrator } = await walkHarness(t);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  // The walk takes the ticket: initWork delegates it to our own app, so the
  // ending speaks in that agent session with the installation's credentials.
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');
  assert.match(opencode.prompts[0]!.text, /<issue identifier="ENG-1">/);

  // The person stops the worker from its own conversation. The stop has to
  // **stick** (ruled 2026-10-03): the ticket goes to a person's hands on the
  // board — the HITL label rides *before* the run ends — the closing says
  // the reason, and nothing moves. This test used to pin the opposite: the
  // walk taking the stopped ticket straight back, "a stop is no memory".
  // The ruling kept the board as the only memory; now the label actually
  // rides, so the walk reads a ticket that is no longer its work.
  await tracker.drive({ kind: 'prompted', id: 'act-stop', conversation: 'dev:as-auto-1', signal: 'stop' });
  await until(() => tracker.closingNotes.length === 1, 'the ticket heard its ending');
  assert.deepEqual(tracker.closingNotes[0], {
    conversation: 'dev:as-auto-1',
    issueId: 'eng-1',
    text: 'A person asked to stop eng-1 from the session.',
  });
  assert.deepEqual(board.moves, [], 'a stop moves nothing');
  assert.ok(
    tracker.moves.some(
      m => m.issueId === 'eng-1' && m.update.kind === 'label' && m.update.label === 'needs-human' && m.update.on,
    ),
    'the stop marked the ticket for a person on the board',
  );

  // The ending woke the walk itself; one more wake is the same read: a
  // stopped ticket is not its work again until a person lifts the mark.
  await orchestrator.wake('website');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'a stop is not a restart: the walk does not re-claim');
  assert.equal(orchestrator.activeRun('tracker-linear', 'eng-1'), undefined, 'no run is alive on the ticket');

  // Lifting the mark is what resumes: the walk works the ticket again from
  // the board's truth, never from somebody's memory.
  tracker.issues.get('eng-1')!.labels = [];
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 2, 'lifting the mark is what resumes the work');
});

test('a stop the runtime would not answer ends *unconfirmed*: the honest words, the mark, no re-claim', async t => {
  const { tracker, config, store, services, board, opencode, orchestrator } = await walkHarness(t);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');
  const runId = orchestrator.activeRun('tracker-linear', 'eng-1')!.id;

  // OpenCode goes down at the exact moment of the stop. The run still ends —
  // its lease, its clocks and its worktree are aivi's to take back whatever
  // OpenCode says — but it carries the machine-readable truth, because
  // AGENTS.md reserves the blocked words for stops that cannot be verified.
  opencode.ctl.interruptFails = true;
  await tracker.drive({ kind: 'prompted', id: 'act-stop', conversation: 'dev:as-auto-1', signal: 'stop' });
  await until(() => tracker.closingNotes.length === 1, 'the ending landed over the dead interrupt');
  assert.deepEqual(new RunLedger(store).get(runId)!.outcome, {
    kind: 'failure',
    reason: 'A person asked to stop eng-1 from the session.',
    code: 'stop-unconfirmed',
  });
  await until(
    () => tracker.ofKind('outcome').some(c => /may still be running/.test(c.text)),
    'the closing says a worker may still be alive, and never claims "stopped at your request"',
  );
  assert.ok(
    tracker.moves.some(m => m.issueId === 'eng-1' && m.update.kind === 'label' && m.update.on),
    'the ticket carries the mark for a person',
  );
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'the walk does not read the stopped ticket back');
});

test('a stop in a worktree lane tears the attempt down: worktree gone, local commits gone, ticket marked', async t => {
  const { tracker, config, store, services, board, opencode, source, orchestrator } = await walkHarness(t, {
    worktree: true,
  });
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');
  assert.match(opencode.prompts[0]!.text, /git worktree of the project at .+\/worktrees\//);
  const run = orchestrator.activeRun('tracker-linear', 'eng-1')!;
  const worktree = run.worktree!;
  assert.ok((await stat(worktree)).isDirectory(), 'the lane got its own worktree');

  // The worker commits half a feature — exactly the half-finished state a
  // stop must not leave for the next worker to trip over.
  await writeFile(join(worktree, 'note.txt'), 'half a feature');
  await git(worktree, 'add', '.');
  await git(worktree, 'commit', '-q', '-m', 'half a feature');
  assert.match((await git(source, 'branch', '--list', 'me/eng-1')).stdout, /me\/eng-1/, 'the branch exists');

  // Stop means stop, teardown included (ruled 2026-10-03): the worktree
  // goes, the local branch goes with it — the commit goes unreachable —
  // and the ticket carries the human mark. Anything pushed would stay
  // pushed: a stop ends this machine's attempt, not the remote's truth.
  await tracker.drive({ kind: 'prompted', id: 'act-stop', conversation: 'dev:as-auto-1', signal: 'stop' });
  await until(() => tracker.closingNotes.length === 1, 'the ticket heard its ending');
  assert.equal(await stat(worktree).catch(() => null), null, 'the stopped attempt’s directory is gone');
  assert.equal(
    (await git(source, 'branch', '--list', 'me/eng-1')).stdout.trim(),
    '',
    'and the local branch with its stopped commit goes with it',
  );
  assert.ok(
    tracker.moves.some(m => m.issueId === 'eng-1' && m.update.kind === 'label' && m.update.on),
    'the ticket carries the human mark',
  );
  assert.deepEqual(board.moves, [], 'a stop moves nothing');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'and the walk does not start a fresh attempt on the stopped ticket');
});

test('a closing that failed to land is found at boot from the pair we keep — and the failed ticket is work again', async t => {
  const { tracker, config, store, services, board, opencode, orchestrator } = await walkHarness(t);
  const first = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);

  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');

  // The module stops — a restart while the host lives — and the worker ends
  // in that gap with Linear unreachable for the closing. The closing fails
  // and says so (the help label rides the ticket); the ticket still moves
  // where the lane order chose.
  tracker.closingDown = true;
  await first.stop();
  const worker = workerSession(opencode.sessions);
  await orchestrator.completeTool({
    sessionId: worker,
    input: { outcome: 'failure', summary: 'the worker died mid-outage' },
  });
  assert.deepEqual(board.moves, ['eng-1->Todo'], 'the failure moved the ticket to the queue lane');
  assert.equal(tracker.closingNotes.length, 0, 'the closing did not land — Linear was unreachable');
  assert.deepEqual(
    tracker.moves.map(m => m.update),
    [{ kind: 'label', label: 'needs-human', on: true }],
    'the failed closing informed a person at once',
  );

  // While the closing is owed both the sitting delegate and the help mark
  // keep the ticket out of the walk — Linear is unreachable for a fresh
  // delegation anyway (ruled 2026-10-02, composed with eligibility).
  await orchestrator.wake('website');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'an unpaid closing keeps the ticket out of the walk');

  // The boot pass finds the owed closing from the pair initWork kept —
  // walk-picked work included — and pays it with the installation's own
  // app. The second run's pair is alive, so the pass leaves it alone.
  tracker.closingDown = false;
  const again = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(restartServices(services));
  t.after(async () => {
    await again.stop();
    store.close();
  });
  assert.ok(
    tracker.closingNotes.some(
      n => n.issueId === 'eng-1' && n.conversation === 'dev:as-auto-1' && n.text === 'the worker died mid-outage',
    ),
    'the boot pass paid the owed closing',
  );
  assert.deepEqual(
    tracker.comments.filter(c => c.conversation === 'dev:as-auto-1' && c.kind === 'outcome').length,
    1,
    'and the failure was said in the session that opened it',
  );

  // The paid closing released the delegate, but the mark it had to make
  // when reporting failed **stays**: needs-human is a person's lever — the
  // module adds it and never lifts it, and it could not tell its own mark
  // from a human's anyway. (Revealed 2026-10-03 when the fake learned to
  // mutate labels: this tail used to walk the ticket straight back — a
  // re-claim that lived only because the fake lied.)
  await orchestrator.wake('website');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'the marked ticket waits for the person it was marked for');

  // Lifting the mark is what makes the failed work walk again: the walk
  // takes it fresh from the queue lane the failure moved it to.
  tracker.issues.get('eng-1')!.labels = [];
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 2, 'lifting the mark is what resumes the failed work');
});

test('a deleted ticket ends the run that still works it: a graceful stop, said where people read', async t => {
  const { tracker, config, store, services, board, opencode, orchestrator } = await walkHarness(t);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');

  // A person deletes the ticket under the live run (Linear's archive) and
  // the webhook says so: the slot stays occupied until the run is properly
  // disposed of — interrupt, closing, release — and never after.
  tracker.issues.get('eng-1')!.archived = true;
  await tracker.drive({ kind: 'updated', conversation: 'dev', issueId: 'eng-1', changed: ['archive'] });
  await until(
    () => tracker.ofKind('outcome').some(c => /was deleted; there is no work/.test(c.text)),
    'the stop is said in the session',
  );
  assert.equal(orchestrator.activeRun('tracker-linear', 'eng-1'), undefined, 'the run is over');
  assert.equal(opencode.interrupted.length, 1, 'the worker was interrupted');
  assert.deepEqual(board.moves, [], 'a deletion moves nothing');
  assert.ok(
    tracker.closingNotes.some(n => n.issueId === 'eng-1' && /was deleted/.test(n.text)),
    'and the ticket heard its ending',
  );
  await tracker.drive({ kind: 'updated', conversation: 'dev', issueId: 'eng-1', changed: ['archive'] });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'a deleted ticket is never work again');
});

test('the ending move asks where the ticket sits first: a person moved it, the move is theirs', async t => {
  const { tracker, config, store, services, board, opencode, orchestrator } = await walkHarness(t);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');

  // A person drags the ticket back to the Backlog while the worker works —
  // and the webhook never arrives (the missed delivery of the ruling): the
  // ending must not drag their ticket forward to prove a move was owed.
  tracker.issues.get('eng-1')!.state = { id: 'back', name: 'Backlog', type: 'unstarted' };
  await orchestrator.completeTool({
    sessionId: workerSession(opencode.sessions),
    input: { outcome: 'success', summary: 'Header aligned.' },
  });
  await until(() => tracker.ofKind('answer').some(c => c.text === 'Header aligned.'), 'the closing words landed');
  assert.deepEqual(board.moves, [], 'the owed move is spent, not undone: nothing drags the ticket to Done');
  assert.equal(orchestrator.activeRun('tracker-linear', 'eng-1'), undefined, 'the run ended');
  await until(() => tracker.delegated.at(-1)?.[1] === null, 'and the ending released the delegate as always');
});

test('a full pool says nothing on the board, and walks in when the slot opens — like normal humans', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'website');
  const home = join(root, 'home');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    dispatcher: { pools: { default: { capacity: 1 } } },
    plugins: { 'tracker-linear': { agent: 'assistant', primary: 'dev', apps: { dev: {} }, mcp: false } },
    projects: {
      website: {
        'tracker-linear': { teams: ['t'] },
        lanes: [{ name: 'Backlog' }, { name: 'Todo' }, { name: 'In Progress', agent: 'developer' }, { name: 'Done' }],
      },
    },
  });
  const opencode = await fakeOpenCode(t, 'The header change touched two files.');
  config.opencode.url = opencode.url;
  const loaded: LoadedConfig = {
    config,
    path: join(home, 'config.json'),
    projects: [{ id: 'website', directory: source, lanes: config.projects.website!.lanes! }],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  tracker.issues.set('eng-1', issue('eng-1', { delegateId: null }));
  tracker.issues.set('eng-2', issue('eng-2', { delegateId: null }));
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const board = fakeBoard(tracker, 'website');
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator as Orchestrator; // the test drives the tool handlers directly
  const links = new RunLinks(store);

  // The walk takes eng-1; eng-2 finds the pool full and **nothing appears
  // on Linear for it** (ruled 2026-10-02): it sits in its lane until
  // capacity frees, like a normal human waiting their turn.
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the first worker starts at once');
  assert.deepEqual(
    tracker.comments.map(c => c.kind),
    ['progress'],
    'the full pool says nothing to anybody: only eng-1’s own session heard a word',
  );
  assert.equal(orchestrator.activeRun('tracker-linear', 'eng-2'), undefined, 'the waiting ticket has no run');

  // The first worker finishes: the queue walks in — eng-2's own initWork
  // opens it, and the fulfilled queue place became its lease.
  const worker = workerSession(opencode.sessions);
  await orchestrator.completeTool({
    sessionId: worker,
    input: { outcome: 'success', summary: 'Header aligned.' },
  });
  await until(() => opencode.prompts.length === 2, 'the waiting ticket starts on its own');
  assert.match(opencode.prompts[1]!.text, /<issue identifier="ENG-2">/, 'the second worker hears its own ticket');
  const queuedRun = orchestrator.activeRun('tracker-linear', 'eng-2')!;
  assert.ok(new RunLedger(store).get(queuedRun.id)!.leaseId, 'the fulfilled queue place became the run’s lease');
  const link = links.byAgentSession('as-auto-2')!;
  assert.equal(link.opencodeSession, queuedRun.sessionId, 'the run found the session its own initWork opened');
});
