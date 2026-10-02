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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type {
  Tracker,
  TrackerChange,
  TrackerCommentKind,
  TrackerEvent,
  TrackerIssue,
  TrackerPlanStep,
  TrackerQuestion,
  TrackerUpdate,
} from '@aivi/plugin/tracker';
import type { LinearConfig } from '../src/config.ts';
import { linearSchema } from '../src/config.ts';
import { RunLinks } from '../src/links.ts';
import { createLinearModule, openLinearStore } from '../src/module.ts';
import { StoppedTickets } from '../src/stopped.ts';

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
  return { url: `http://127.0.0.1:${address.port}`, prompts, sessions, forms, interrupted };
}

/**
 * A tracker that records what the follower asks of it and serves neutral
 * issues — the seam the module decisions are tested through. It mirrors the
 * two Linear facts the follower's idempotence asks about: an `answer` or
 * `outcome` comment ends the agent session (so `resultShown` turns true, as
 * Linear's `endedAt` does), and a `move` updates the issue's state (so a
 * catch-up that already landed says nothing twice).
 */
class FakeTracker implements Tracker {
  readonly id = 'linear';
  comments: { conversation: string; text: string; kind: TrackerCommentKind }[] = [];
  /** The app ids the module was configured with; conversations carry them. */
  readonly apps: string[];
  /** Which app a conversation belongs to, as the module names it. */
  app: Record<string, string> = {};
  issues = new Map<string, TrackerIssue>();
  delegated: [string, string | null][] = [];
  sessionsCreated: string[] = [];
  moves: { conversation: string; issueId: string; update: TrackerUpdate }[] = [];
  shown = new Set<string>();
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
    const made = `as-auto-${this.sessionsCreated.length + 1}`;
    this.sessionsCreated.push(issueId);
    this.sessionsByIssue.set(issueId, [...(this.sessionsByIssue.get(issueId) ?? []), made]);
    return made;
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
    if (this.closingNotes.some(n => n.issueId === issueId && n.text === text)) return;
    this.closingNotes.push({ conversation, issueId, text });
  }
  /** Questions the follower rendered from the run's `question` events. */
  asks: { conversation: string; question: TrackerQuestion }[] = [];
  async ask(conversation: string, question: TrackerQuestion): Promise<void> {
    this.asks.push({ conversation, question });
  }
  plans: { conversation: string; steps: TrackerPlanStep[] }[] = [];
  async plan(conversation: string, steps: TrackerPlanStep[]): Promise<void> {
    this.plans.push({ conversation, steps });
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
  delegateId: 'app-user-dev',
  assignee: { id: 'u', name: 'Me' },
  archived: false,
  completed: false,
  blockedBy: [],
  ...extra,
});

const noEvents: SessionEvents = { watch: () => () => {} };
/** A board with no projects on it: these tests drive runs through the tracker
 *  fake, and the eligibility walk never asks a Linear installation here. */
const emptyFeed: import('@aivi/host').TicketFeed = {
  projects: () => [],
  tickets: async () => [],
  moveTo: async () => {},
  firstMessage: async () => undefined,
};
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

test('a delegation runs the lane agent; plan, question, answer and interjection reach the worker; the ending catches Linear up in order; refusals answer plainly', async t => {
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
  for (const seeded of [
    issue('eng-1'),
    issue('eng-2', { labels: [{ id: 'l', name: 'needs-human' }] }),
    issue('eng-3', { teamId: 't9' }),
    issue('eng-5', { state: { id: 's9', name: 'Deploy', type: 'started' } }),
    issue('eng-6', { delegateId: null }),
    issue('eng-7', { archived: true }),
    issue('eng-8', { teamId: 't9', delegateId: null }),
    issue('eng-4', { teamId: 'tx' }),
  ])
    tracker.issues.set(seeded.id, seeded);

  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => emptyFeed,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator;
  const links = new RunLinks(store);

  const started = (conversation: string, issueId: string) =>
    tracker.drive({
      kind: 'started',
      conversation,
      issueId,
      promptContext: `<issue identifier="${issueId.toUpperCase()}"><title>Fix header</title></issue>`,
    });

  // The delegation: the pair is recorded, the run starts in the checkout, and
  // the acknowledgement is the session's first activity.
  await started('dev:as-1', 'eng-1');
  await until(() => opencode.prompts.length === 1, 'the worker was prompted');
  assert.equal(tracker.comments[0]!.kind, 'progress', 'acknowledged first');
  assert.match(tracker.comments[0]!.text, /Starting as `developer` in project website/);
  const worker = workerSession(opencode.sessions);
  assert.equal(opencode.sessions.get(worker)!.agent, 'developer');
  assert.equal(opencode.sessions.get(worker)!.directory, source, 'the checkout is the work directory');
  assert.deepEqual(links.byAgentSession('as-1'), { agentSession: 'as-1', ticketId: 'eng-1', opencodeSession: worker });
  assert.match(
    opencode.prompts[0]!.text,
    /Linear delegated ENG-1 "Fix header" to you \(app dev\) in project website, lane "In Progress"/,
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
    { conversation: 'dev:as-1', steps: [{ content: 'Read the header styles', status: 'inProgress' }] },
  ]);

  // The question: the ask tool's OpenCode form is the record; the follower
  // renders Linear's elicitation from the event.
  await orchestrator.askTool({
    sessionId: worker,
    input: { question: 'Which blue?', options: [{ label: 'Teal', value: 'teal' }] },
  });
  assert.deepEqual(tracker.asks, [
    {
      conversation: 'dev:as-1',
      question: { question: 'Which blue?', options: [{ label: 'Teal', value: 'teal' }], formId: opencode.forms[0]!.id },
    },
  ]);
  assert.equal(
    opencode.forms.filter(f => !f.answered && f.sessionID === worker).length,
    1,
    'the form waits in OpenCode',
  );

  // The answer: the pending form is the discriminator — the worker gets the
  // text, the form closes as the record.
  await tracker.drive({ kind: 'prompted', id: 'act-a1', conversation: 'dev:as-1', body: 'Use teal' });
  await until(() => opencode.forms[0]!.answered, 'the form was answered');
  const answered = opencode.prompts.find(p => p.text.startsWith('The person answered your question:'));
  assert.equal(answered!.text, 'The person answered your question: Use teal');
  assert.equal(answered!.delivery, 'queue');

  // An interjection with no form open steers the running turn.
  await tracker.drive({ kind: 'prompted', id: 'act-i1', conversation: 'dev:as-1', body: 'Also fix the footer' });
  await until(
    () => opencode.prompts.some(p => p.text === 'Also fix the footer'),
    'the interjection reached the session',
  );
  assert.equal(opencode.prompts.find(p => p.text === 'Also fix the footer')!.delivery, 'steer');

  // The ending: only a tool call ends a run. The catch-up is the follower's
  // order — result first (it stops Linear's spinner), then the move the lane
  // order chose, then the delegate back.
  await orchestrator.completeTool({
    sessionId: worker,
    input: { outcome: 'success', summary: 'Header aligned.' },
  });
  await until(() => tracker.ofKind('answer').some(c => c.text === 'Header aligned.'), 'the result was posted');
  // The catch-up is the follower's own async work: wait for the whole ceremony.
  await until(
    () => tracker.moves.length === 1 && tracker.delegated.at(-1)?.[1] === null,
    'the move and the delegate catch-up landed',
  );
  assert.deepEqual(
    tracker.closingNotes,
    [{ conversation: 'dev:as-1', issueId: 'eng-1', text: 'Header aligned.' }],
    'the ending is readable on the ticket itself, not only in the session',
  );
  assert.deepEqual(
    tracker.moves.map(m => m.update),
    [{ kind: 'move', lane: 'Done' }],
    'the lane order chose Done and the follower performed it',
  );
  assert.deepEqual(tracker.delegated.at(-1), ['eng-1', null], 'the delegate was un-taken');
  const ended = orchestrator.runBySession(worker)!;
  assert.deepEqual(
    [ended.state, ended.targetLane, ended.outcome],
    ['completed', 'Done', { kind: 'success', summary: 'Header aligned.' }],
  );

  // A redelivery of the same delegation is a no-op: the pair and the run answer it.
  const quietComments = tracker.comments.length;
  await started('dev:as-1', 'eng-1');
  assert.equal(tracker.comments.length, quietComments, 'a redelivery is a no-op');

  // A follow-up into the finished conversation is the assistant's: the person
  // talks to aivi, with the ticket read afresh.
  await tracker.drive({ kind: 'prompted', id: 'act-f1', conversation: 'dev:as-1', body: 'What did you change?' });
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
  await tracker.drive({ kind: 'prompted', id: 'act-s', conversation: 'dev:as-1', signal: 'stop' });
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

  // A delegation a config cannot run — the team maps no project — gets one
  // plain fixed answer and the delegate un-taken. No agent improvises.
  await started('dev:as-3', 'eng-3');
  await until(() => tracker.answerWith('ENG-3') !== '', 'the unclaimed delegation was answered');
  assert.match(tracker.answerWith('ENG-3'), /its team is not connected to an aivi project/);
  assert.match(tracker.answerWith('ENG-3'), /removed myself as delegate/);
  assert.deepEqual(tracker.delegated.at(-1), ['eng-3', null], 'the delegation was un-taken');

  // A delegation into a state that is no lane of the project: the same fixed
  // answer, naming the state.
  await started('dev:as-5', 'eng-5');
  await until(() => tracker.answerWith('ENG-5') !== '', 'the not-a-lane delegation was answered');
  assert.match(tracker.answerWith('ENG-5'), /"Deploy" is not a lane of project website/);
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

  // A second mapped team routes to the same checkout: teams is a list on purpose.
  await started('dev:as-4', 'eng-4');
  await until(
    () => opencode.prompts.some(p => p.text.includes('Linear delegated ENG-4')),
    'the other mapped team routes',
  );
  assert.equal(opencode.sessions.get(workerSession(opencode.sessions, 1))!.directory, source);
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
    }),
  );
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => emptyFeed,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  await tracker.drive({
    kind: 'started',
    conversation: 'dev:as-r1',
    issueId: 'site-1',
    promptContext: '<issue identifier="SITE-1"></issue>',
  });
  await until(() => opencode.prompts.length === 1, 'the researcher was prompted');
  const worker = workerSession(opencode.sessions);
  assert.deepEqual(opencode.sessions.get(worker), { agent: 'researcher', directory: source });
  assert.match(
    opencode.prompts[0]!.text,
    /You work in the project's checkout/,
    'the prompt says where the agent works',
  );
  assert.ok(
    tracker.ofKind('progress').some(c => /working in the project checkout/.test(c.text)),
    'the acknowledgement says so too',
  );
  // The only lane of the array: success has nowhere configured to go and the
  // next-lane default names none — the ticket stays, unconfigured is silent.
  await services.orchestrator.completeTool({ sessionId: worker, input: { outcome: 'success', summary: 'A report.' } });
  await until(
    () => tracker.ofKind('answer').some(c => c.text === 'A report.') && tracker.delegated.length > 0,
    'the result was posted and the delegate un-taken',
  );
  assert.deepEqual(tracker.moves, [], 'no move for a run at the end of the lane order');
  assert.equal(services.orchestrator.runBySession(worker)!.targetLane, undefined);
  assert.deepEqual(tracker.delegated.at(-1), ['site-1', null], 'the success still un-takes the delegate');
});

test('the listener delegates an issue entering a worked lane; a stop ends the run and says so in Linear; a blocked issue waits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-listener-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await checkout(root, 'api');
  const opencode = await fakeOpenCode(t, 'Shipped.');
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    plugins: { 'tracker-linear': { apps: { dev: {} }, mcp: false, listener: true } },
    projects: {
      api: {
        'tracker-linear': { teams: ['t'] },
        lanes: [
          { name: 'Todo' },
          { name: 'In Progress', agent: 'developer' },
          { name: 'Review', agent: 'reviewer' },
          { name: 'Done' },
        ],
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
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => emptyFeed,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator;
  const updated = async (changed: TrackerChange[]) => {
    await tracker.drive({ kind: 'updated', conversation: 'dev', issueId: 'api-7', changed });
  };

  // A title edit is not a routing change: nothing happens.
  await updated([]);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(tracker.sessionsCreated, []);

  // The platform's own blocking: a blocker not in a finished state holds the listener back.
  api.blockedBy = [{ id: 'b', completed: false }];
  api.state = { id: 'prog', name: 'In Progress', type: 'started' };
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(tracker.sessionsCreated, [], 'a blocked issue is not delegated');
  api.blockedBy = [{ id: 'b', completed: true }];
  await updated(['state']);
  await until(() => tracker.sessionsCreated.length === 1, 'the listener delegated to the lane app');
  assert.deepEqual(tracker.delegated.at(-1), ['api-7', 'app-user-dev']);
  await until(() => opencode.prompts.length === 1, 'the worker was prompted');
  const worker = workerSession(opencode.sessions);
  const run = orchestrator.activeRun('tracker-linear', 'api-7')!;
  assert.equal(run.sessionId, worker);
  // The created webhook for the session the delegation itself made: the pair
  // answers it — no second worker.
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.sessions.size, 1, 'a redelivery starts nothing new');

  // In Progress → Review names a different agent: the update orphans the run.
  // The stop is the orchestrator's (interrupt + cancel); the follower renders
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
  assert.equal(api.delegateId, 'app-user-dev', 'a failure leaves the delegate sitting');

  // The ticket comes back to a worked lane with the delegate cleared (a
  // failure left it sitting; a person takes it off) — the listener picks it
  // up afresh. Then the HITL label stops the running worker the same way.
  api.state = { id: 'prog', name: 'In Progress', type: 'started' };
  api.delegateId = null;
  await updated(['state', 'delegate']);
  await until(() => opencode.prompts.length === 2, 'the ticket came back and a new run started');
  api.labels = [{ id: 'l', name: 'needs-human' }];
  await updated(['labels']);
  await until(
    () => tracker.ofKind('outcome').some(c => /needs-human.*was added to API-7/.test(c.text)),
    'the label stopped the run',
  );
  assert.equal(orchestrator.activeRun('tracker-linear', 'api-7'), undefined);
});

test('boot reconcile heals an ending the follower missed, and says nothing twice', async t => {
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
  first.issues.set('api-9', issue('api-9', { identifier: 'API-9', title: 'Ship it' }));
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  const running = await createLinearModule(
    linearBlock(config),
    async () => first,
    () => emptyFeed,
  ).start(services);

  // The delegation lands and the worker starts...
  await first.drive({
    kind: 'started',
    conversation: 'dev:as-9',
    issueId: 'api-9',
    promptContext: '<issue identifier="API-9"></issue>',
  });
  await until(() => opencode.prompts.length === 1, 'the worker was prompted');
  const worker = workerSession(opencode.sessions);

  // ...then aivi goes down with the worker still running, and the completion
  // happens while no follower is listening (the outage that lost FLU-9's
  // response in the live test).
  await running.stop();
  await services.orchestrator.completeTool({ sessionId: worker, input: { outcome: 'success', summary: 'It ships.' } });
  assert.equal(first.ofKind('answer').length, 0, 'nothing posted while the follower was gone');

  // A boot pass: the pair survives in the follower's own table; the run
  // record says ended; Linear is caught up — result, move, delegate.
  const second = new FakeTracker(linearBlock(config));
  second.issues.set('api-9', issue('api-9', { identifier: 'API-9', title: 'Ship it' }));
  const restarted = await createLinearModule(
    linearBlock(config),
    async () => second,
    () => emptyFeed,
  ).start(restartServices(services));
  assert.deepEqual(
    second.comments.filter(c => c.conversation === 'dev:as-9').map(c => [c.kind, c.text]),
    [['answer', 'It ships.']],
    'the owed ceremony is paid at boot',
  );
  assert.deepEqual(
    second.moves.map(m => m.update),
    [{ kind: 'move', lane: 'Done' }],
    'and the move lands',
  );
  assert.deepEqual(second.delegated.at(-1), ['api-9', null], 'and the delegate is un-taken');

  // And a third boot says nothing twice: Linear itself says the result was
  // shown (the agent session is ended) and the state is where the move put
  // it — the follower asks the platform, never a flag of its own.
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
  third.shown.add('dev:as-9');
  // Linear's real state carries the standing closing note too: the third
  // boot must not post it twice (the marker is the agent session id, which
  // the fake's text-equality guard stands in for).
  third.closingNotes.push({ conversation: 'dev:as-9', issueId: 'api-9', text: 'It ships.' });
  const again = await createLinearModule(
    linearBlock(config),
    async () => third,
    () => emptyFeed,
  ).start(restartServices(services));
  assert.deepEqual(third.comments, [], 'a catch-up that already happened is silent');
  assert.deepEqual(third.moves, [], 'and nothing re-moves');
  assert.equal(third.closingNotes.length, 1, 'a standing closing note is not posted twice');
  await again.stop();
  store.close();
});

/** The walk's board over one ticket: what the module's own feed answers with
 *  the stopped-ticket filter — the same two lines `linearFeed` runs. */
function pickedBoard(store: Store, stopped: StoppedTickets): import('@aivi/host').TicketFeed {
  return {
    projects: () => ['website'],
    tickets: async () => (stopped.has('eng-1') ? [] : [{ id: 'eng-1', blocked: false }]),
    moveTo: async () => {},
    firstMessage: async () => 'picked eng-1 for you',
  };
}

async function walkHarness(t: { after(fn: () => Promise<void>): void }) {
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
          { name: 'In Progress', agent: 'developer' },
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
  tracker.issues.set('eng-1', issue('eng-1'));
  const store = new Store(':memory:');
  const abort = new AbortController();
  const stopped = new StoppedTickets(store);
  const services = makeServices(loaded, store, abort);
  return { tracker, config, store, services, stopped, opencode, orchestrator: services.orchestrator };
}

test('a picked-up run’s ending is said on the ticket with the installation’s own credentials, and stop means stop', async t => {
  const { tracker, config, store, services, stopped, opencode, orchestrator } = await walkHarness(t);
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => pickedBoard(store, stopped),
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  // The walk takes the ticket: no delegation, so no agent session anywhere.
  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');
  assert.match(opencode.prompts[0]!.text, /picked eng-1 for you/);
  const run = orchestrator.activeRun('tracker-linear', 'eng-1')!;

  // The person stops it. The ending has no session to complete and no
  // delegate to release: the closing note is said on the ticket with the
  // installation's own app, and nothing moves — a stop moves nothing.
  await orchestrator.stop(run.id, 'a person asked to stop eng-1 from the session.');
  await until(() => tracker.closingNotes.length === 1, 'the ticket heard its ending without an agent session');
  assert.deepEqual(tracker.closingNotes[0], {
    conversation: 'dev',
    issueId: 'eng-1',
    text: 'a person asked to stop eng-1 from the session.',
  });
  assert.deepEqual(tracker.moves, [], 'a stop moves nothing');
  assert.equal(stopped.has('eng-1'), true, 'the stop is remembered');

  // And the walk that very ending woke does not take the ticket back.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(opencode.prompts.length, 1, 'stop means stop, even for the walk');
});

test('an ending that arrived while nobody followed is found at boot from the orchestrator’s record', async t => {
  const { tracker, config, store, services, stopped, opencode, orchestrator } = await walkHarness(t);
  const first = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => pickedBoard(store, stopped),
  ).start(services);

  await orchestrator.wake('website');
  await until(() => opencode.prompts.length === 1, 'the walk started the worker');

  // The follower stops listening — a module restart while the host lives.
  // The worker ends in that gap: nobody is following, and the walk takes
  // the ticket again (failed work is work; only a person's stop says
  // otherwise). The record of the first ending waits in the ledger.
  await first.stop();
  const worker = workerSession(opencode.sessions);
  await orchestrator.completeTool({
    sessionId: worker,
    input: { outcome: 'failure', summary: 'the worker died mid-outage' },
  });
  assert.equal(tracker.closingNotes.length, 0, 'nobody was listening to say it');
  await until(() => opencode.prompts.length === 2, 'the failed ticket is work again, and the walk takes it');

  // The second module boots: the missed ending is found in the
  // orchestrator's own record from the watermark — said on the ticket and
  // moved where the lane order chose, with the installation's own app.
  const again = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => pickedBoard(store, stopped),
  ).start(restartServices(services));
  t.after(async () => {
    await again.stop();
    store.close();
  });
  assert.equal(tracker.closingNotes.length, 1, 'the boot pass rendered the missed ending');
  assert.deepEqual(tracker.closingNotes[0], {
    conversation: 'dev',
    issueId: 'eng-1',
    text: 'the worker died mid-outage',
  });
  assert.deepEqual(
    tracker.moves.map(m => m.update),
    [{ kind: 'move', lane: 'Todo' }],
    'the failure move the lane order chose landed too',
  );
});

test('a delegation into a full pool queues with a word to the delegator, and walks in when the slot opens', async t => {
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
  tracker.issues.set('eng-1', issue('eng-1'));
  tracker.issues.set('eng-2', issue('eng-2'));
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services = makeServices(loaded, store, abort);
  // The board shows what a person has placed in the worker lane: the
  // queued delegation must still be there when the lease lands.
  const board: import('@aivi/host').TicketFeed = {
    projects: () => ['website'],
    tickets: async () => [{ id: 'eng-2', blocked: false }],
    moveTo: async () => {},
    firstMessage: async () => 'never the walk\u2019s turn',
  };
  const running = await createLinearModule(
    linearBlock(config),
    async () => tracker,
    () => board,
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const orchestrator = services.orchestrator;
  const links = new RunLinks(store);

  const started = (conversation: string, issueId: string) =>
    tracker.drive({
      kind: 'started',
      conversation,
      issueId,
      promptContext: `<issue identifier="${issueId.toUpperCase()}"><title>Fix header</title></issue>`,
    });

  // The first delegation takes the only slot.
  await started('dev:as-1', 'eng-1');
  await until(() => opencode.prompts.length === 1, 'the first worker starts at once');

  // The second finds the pool full: it is queued, the delegator hears it,
  // and no run exists yet — the pair waits with the request.
  await started('dev:as-2', 'eng-2');
  await until(
    () => tracker.comments.some(c => c.text.includes('waits in the queue')),
    'the delegator is told the delegation waits',
  );
  assert.equal(orchestrator.activeRun('tracker-linear', 'eng-2'), undefined, 'a queued delegation has no run');

  // The first worker finishes: the slot opens and the queue walks in —
  // the run attaches to the pair bound at delegation time.
  const worker = workerSession(opencode.sessions);
  await orchestrator.completeTool({
    sessionId: worker,
    input: { outcome: 'success', summary: 'Header aligned.' },
  });
  await until(() => opencode.prompts.length === 2, 'the queued delegation starts on its own');
  assert.match(opencode.prompts[1]!.text, /Linear delegated ENG-2/, 'the worker hears its own delegation');
  const queuedRun = orchestrator.activeRun('tracker-linear', 'eng-2')!;
  assert.ok(new RunLedger(store).get(queuedRun.id)!.leaseId, 'the fulfilled queue place became the run\u2019s lease');
  const link = links.byAgentSession('as-2')!;
  assert.equal(link.opencodeSession, queuedRun.sessionId, 'the run found the pair that waited');
});
