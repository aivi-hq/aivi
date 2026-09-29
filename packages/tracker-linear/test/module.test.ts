import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { KnowledgeService } from '@aivi/core';
import { configSchema, getLogger } from '@aivi/core';
import type { SessionEvents } from '@aivi/host';
import { Channels, connectOpenCode, PublicRoutes, Store, TaskRegistry, ToolRegistry } from '@aivi/host';
import type { AiviServices } from '@aivi/plugin';
import type { ChannelDelivery } from '@aivi/plugin/channel';
import type { Tracker, TrackerChange, TrackerCommentKind, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import type { LinearConfig } from '../src/config.ts';
import { linearSchema } from '../src/config.ts';
import { createLinearModule, openLinearStore } from '../src/module.ts';

const run = promisify(execFile);

/** The typed block out of the open core parse: the plugin's own schema fills defaults. */
const linearBlock = (config: { plugins: Record<string, unknown> }): LinearConfig =>
  linearSchema.parse(config.plugins.linear);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);

/** A tiny OpenCode: any session exists, every prompt gets the same answer. */
async function fakeOpenCode(
  t: { after(fn: () => Promise<void>): void },
  answer: string,
  gate: () => Promise<void> = async () => {},
) {
  const prompts: { id: string; text: string; metadata: unknown }[] = [];
  const sessions = new Map<string, { agent: string; directory: string }>();
  const interrupted: string[] = [];
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
    res.setHeader('content-type', 'application/json');
    if (url.endsWith('/wait')) await gate();
    if (url.startsWith('/api/agent')) return void res.end('{"data":[{"id":"developer","name":"developer"}]}');
    if (url.endsWith('/message')) return void res.end('{"data":[],"cursor":{"next":null}}');
    if (url.endsWith('/permission') && req.method === 'GET') return void res.end('{"data":[]}');
    if (url.endsWith('/interrupt')) {
      interrupted.push(decodeURIComponent(url.split('/').at(-2)!));
      return void res.end('{"interrupted":true}');
    }
    if (req.method === 'PATCH' || url.endsWith('/wait') || url.endsWith('/model')) return void res.writeHead(204).end();
    if (url === '/api/session' && req.method === 'POST') {
      sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/prompt')) {
      prompts.push({ id: body.id, text: body.text, metadata: body.metadata });
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
  return { url: `http://127.0.0.1:${address.port}`, prompts, sessions, interrupted };
}

/**
 * A tracker that records what the module asks of it and serves neutral
 * issues — the seam the module decisions are tested through. The Linear
 * translation behind the real adapter (webhooks, GraphQL, activity types)
 * is `test/tracker.test.ts`'s subject, not this file's.
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
    return undefined;
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
  blockedByStates: [],
  ...extra,
});

const noEvents: SessionEvents = { watch: () => () => {} };
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};
const knowledge: KnowledgeService = { search: async () => [], index: async () => ({}), close: async () => {} };

test('a delegation in a mapped lane runs the lane agent in a worktree; people reach the assistant; a delegation nothing can run gets one plain answer; HITL refuses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(join(upstream, 'docs'), { recursive: true });
  await writeFile(join(upstream, 'docs/a.md'), 'a');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  const source = join(root, 'home/projects/website/source');
  await mkdir(join(root, 'home/projects/website'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  const home = join(root, 'home');

  // The one app keeps the bare names; the face uses its own; the primary carries the data feed.
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    plugins: { linear: { agent: 'assistant', primary: 'dev', apps: { dev: {}, face: {} }, mcp: false } },
    projects: { website: { linear: { teams: ['t', 'tx'], lanes: { 'In Progress': 'developer' } } } },
  });
  const opencode = await fakeOpenCode(t, 'Done: fixed the header.');
  config.opencode.url = opencode.url;
  const loaded = {
    config,
    path: join(home, 'config.json'),
    projects: [
      {
        id: 'website',
        directory: source,
        linear: { teams: ['t', 'tx'], lanes: { 'In Progress': { agent: 'developer', worktree: true } } },
      },
    ],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  // A team no project maps: a delegation there gets the fixed answer; a
  // mention still reaches the assistant, whose ground is the home.
  // A delegation into a lane nobody mapped: the fixed answer names the lane
  // and the delegate is un-taken. A mention (no delegate) on the face, in a
  // mapped team.
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
  const services: AiviServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: abort.signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
    tools: new ToolRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createLinearModule(linearBlock(config), async () => tracker).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  const started = (conversation: string, issueId: string) =>
    tracker.drive({
      kind: 'started',
      conversation,
      issueId,
      promptContext: `<issue identifier="${issueId.toUpperCase()}"><title>Fix header</title></issue>`,
    });

  await started('dev:as-1', 'eng-1');
  await until(() => tracker.comments.some(c => c.kind === 'answer'), 'the worker answered');
  const kinds = tracker.comments.map(c => c.kind);
  assert.equal(kinds[0], 'progress', 'acknowledged first');
  assert.match(
    tracker.comments[0]!.text,
    /Starting as `developer` in project website on branch `me\/eng-1-fix-header`/,
  );
  assert.deepEqual(tracker.comments.at(-1), {
    conversation: 'dev:as-1',
    text: 'Done: fixed the header.',
    kind: 'answer',
  });
  const worktree = join(root, 'home/projects/website/worktrees/as-1');
  assert.ok(await stat(join(worktree, '.git')), 'the worktree exists');
  assert.equal((await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'me/eng-1-fix-header');
  const worker = [...opencode.sessions.values()].find(s => s.agent === 'developer')!;
  assert.equal(worker.directory, worktree, 'the lane agent runs in the worktree');
  assert.match(
    opencode.prompts[0]!.text,
    /Linear delegated ENG-1 "Fix header" to you \(app dev\) in project website, lane "In Progress"/,
  );
  assert.match(opencode.prompts[0]!.text, /<issue identifier="ENG-1">/);
  const inbox = openLinearStore(store);
  assert.equal(inbox.list()[0]!.state, 'sent');
  assert.deepEqual([inbox.sessionOf('dev:as-1')!.project, inbox.sessionOf('dev:as-1')!.issue], ['website', 'eng-1']);
  assert.equal(inbox.sessionOf('dev:as-1')!.agent, 'developer');
  await started('dev:as-1', 'eng-1');
  assert.equal(inbox.list().length, 1, 'a redelivery is a no-op');

  // A follow-up prompt is a new turn in the same session; a stop with nothing running says so.
  await tracker.drive({ kind: 'prompted', id: 'act-p1', conversation: 'dev:as-1', body: 'Also fix the footer' });
  await until(() => opencode.prompts.length === 2, 'the follow-up reached the same session');
  assert.equal(opencode.prompts[1]!.text, '[Linear follow-up from a person in Linear]\nAlso fix the footer');
  await until(() => inbox.list().every(t => t.state === 'sent'), 'answered');
  await tracker.drive({ kind: 'prompted', id: 'act-s', conversation: 'dev:as-1', signal: 'stop' });
  await until(
    () => tracker.ofKind('answer').some(c => c.text === 'Nothing is running right now.'),
    'stop with nothing running',
  );

  // The HITL label refuses any agent.
  await started('dev:as-2', 'eng-2');
  await until(() => tracker.ofKind('outcome').some(c => /needs-human/.test(c.text)), 'HITL refused');

  // A deleted ticket is gone as far as work is concerned: a session created
  // on it gets no worker, no assistant — not even a refusal.
  const quietComments = tracker.comments.length;
  const quietPrompts = opencode.prompts.length;
  await started('dev:as-7', 'eng-7');
  assert.equal(tracker.comments.length, quietComments, 'the archived ticket gets no comment');
  assert.equal(opencode.prompts.length, quietPrompts, 'the archived ticket starts no agent');

  // A delegation a config cannot run — the team maps no project — gets one
  // plain fixed answer and the delegate un-taken. No agent improvises over
  // a job nobody claimed: the OpenCode sessions stay at the worker's alone.
  await started('dev:as-3', 'eng-3');
  await until(() => tracker.answerWith('ENG-3') !== '', 'the unclaimed delegation was answered');
  assert.match(tracker.answerWith('ENG-3'), /its team is not connected to an aivi project/);
  assert.match(tracker.answerWith('ENG-3'), /removed myself as delegate/);
  assert.deepEqual(tracker.delegated.at(-1), ['eng-3', null], 'the delegation was un-taken');
  assert.equal(opencode.sessions.size, 1, 'no agent was started for it');

  // A delegation into an unmapped lane of a mapped team: the same fixed
  // answer, naming the lane.
  await started('dev:as-5', 'eng-5');
  await until(() => tracker.answerWith('ENG-5') !== '', 'the unmapped-lane delegation was answered');
  assert.match(tracker.answerWith('ENG-5'), /the "Deploy" lane has no agent mapping/);
  assert.deepEqual(tracker.delegated.at(-1), ['eng-5', null], 'un-taken as well');
  assert.equal(opencode.sessions.size, 1, 'and still no agent was started');

  // A mention (not a delegation) on a team no project maps still reaches
  // the assistant, and the assistant works from the home then.
  await started('dev:as-8', 'eng-8');
  await until(() => inbox.list().length === 3, 'the mention on the unmapped team became a turn');
  const homeAssistant = () => [...opencode.sessions.values()].find(s => s.agent === 'assistant');
  await until(() => homeAssistant() !== undefined, 'the assistant session opened');
  assert.equal(homeAssistant()!.directory, home, 'no project: the assistant runs in the home');

  // A mention on the face reaches the same assistant; the conversation lives on the face.
  await tracker.drive({
    kind: 'started',
    conversation: 'face:as-6',
    issueId: 'eng-6',
    promptContext: '<issue identifier="ENG-6">…</issue>',
  });
  await until(() => inbox.list().length === 4, 'the face mention became a turn');
  assert.equal(inbox.sessionOf('face:as-6')!.agent, 'assistant');
  assert.deepEqual(
    tracker.delegated.filter(d => d[0] === 'eng-6'),
    [],
    'a mention is not un-delegated',
  );
  await until(() => inbox.list().every(t => t.state === 'sent'), 'all answered');
  assert.ok(
    [...opencode.sessions.values()].some(s => s.agent === 'assistant' && s.directory === source),
    'the assistant runs in the project checkout when the team maps one',
  );

  // A second mapped team routes to the same checkout: teams is a list on purpose.
  await started('dev:as-4', 'eng-4');
  await until(() => opencode.prompts.some(p => p.text.includes('ENG-4')), 'the other mapped team routes');
  await until(() => inbox.list().every(t => t.state === 'sent'), 'and answered');
  assert.ok(await stat(join(root, 'home/projects/website/worktrees/as-4')), 'a worktree of the same checkout');
});

test('a read-only lane runs its agent in the project checkout without a worktree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(upstream, { recursive: true });
  await writeFile(join(upstream, 'README.md'), 'r');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  const source = join(root, 'home/projects/site/source');
  await mkdir(join(root, 'home/projects/site'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    plugins: { linear: { apps: { dev: {} }, mcp: false } },
    projects: {
      site: {
        linear: { teams: ['t'], lanes: { Research: { agent: 'researcher', worktree: false } } },
      },
    },
  });
  const opencode = await fakeOpenCode(t, 'Answered.');
  config.opencode.url = opencode.url;
  const loaded = {
    config,
    path: join(root, 'home/config.json'),
    projects: [
      {
        id: 'site',
        directory: source,
        linear: { teams: ['t'], lanes: { Research: { agent: 'researcher', worktree: false } } },
      },
    ],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  tracker.issues.set('site-1', {
    id: 'site-1',
    identifier: 'SITE-1',
    title: 'What ships next',
    description: null,
    branchName: 'me/site-1',
    url: 'https://linear.app/x/issue/SITE-1',
    state: { id: 's', name: 'Research', type: 'started' },
    teamId: 't',
    labels: [],
    delegateId: 'app-user-dev',
    assignee: { id: 'u', name: 'Me' },
    archived: false,
    blockedByStates: [],
  });
  const store = new Store(':memory:');
  const services: AiviServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: new AbortController().signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
    tools: new ToolRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createLinearModule(linearBlock(config), async () => tracker).start(services);
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
  const inbox = openLinearStore(store);
  await until(() => inbox.list().some(t => t.state === 'sent'), 'answered from the checkout');
  const session = [...opencode.sessions.values()][0]!;
  assert.deepEqual(session, { agent: 'researcher', directory: source }, 'no worktree: the checkout is the directory');
  assert.match(opencode.prompts[0]!.text, /clean checkout/, 'the prompt says where the agent works');
  assert.ok(
    tracker.ofKind('progress').some(c => /working in the project checkout/.test(c.text)),
    'the acknowledgement says so too',
  );
  assert.equal(
    await stat(join(root, 'home/projects/site/worktrees'))
      .then(s => s.isDirectory())
      .catch(() => false),
    false,
    'no worktrees directory was made',
  );
});

test('the listener delegates an issue entering a mapped lane and starts the worker; the HITL label or a lane change mid-run stops it; a blocked issue waits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-listener-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(upstream, { recursive: true });
  await writeFile(join(upstream, 'README.md'), 'r');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  const source = join(root, 'home/projects/api/source');
  await mkdir(join(root, 'home/projects/api'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);

  let release: () => void = () => {};
  let gated = false;
  const gate = () => (gated ? new Promise<void>(r => (release = r)) : Promise.resolve());
  const opencode = await fakeOpenCode(t, 'Shipped.', gate);
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    plugins: { linear: { apps: { dev: {} }, mcp: false, listener: true } },
    projects: { api: { linear: { teams: ['t'], lanes: { 'In Progress': 'developer', Review: 'developer' } } } },
  });
  const loaded = {
    config,
    path: join(root, 'home/config.json'),
    projects: [
      {
        id: 'api',
        directory: source,
        linear: {
          teams: ['t'],
          lanes: {
            'In Progress': { agent: 'developer', worktree: true },
            Review: { agent: 'developer', worktree: true },
          },
        },
      },
    ],
    sources: [],
  };
  const tracker = new FakeTracker(linearBlock(config));
  const api: TrackerIssue = {
    id: 'api-7',
    identifier: 'API-7',
    title: 'Add rate limits',
    description: null,
    branchName: 'me/api-7-rate-limits',
    url: 'https://linear.app/x/issue/API-7',
    state: { id: 'todo', name: 'Todo', type: 'unstarted' },
    teamId: 't',
    labels: [],
    delegateId: null,
    assignee: { id: 'u', name: 'Me' },
    archived: false,
    blockedByStates: [],
  };
  tracker.issues.set('api-7', api);
  const store = new Store(':memory:');
  const abort = new AbortController();
  const services: AiviServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: abort.signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes: new PublicRoutes(),
    tasks: new TaskRegistry().forModule('test'),
    tools: new ToolRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createLinearModule(linearBlock(config), async () => tracker).start(services);
  t.after(async () => {
    release();
    await running.stop();
    store.close();
  });
  const updated = async (changed: TrackerChange[]) => {
    await tracker.drive({ kind: 'updated', conversation: 'dev', issueId: 'api-7', changed });
  };

  // A title edit is not a routing change: nothing happens.
  await updated([]);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(tracker.sessionsCreated, []);

  // The platform's own blocking: a blocker not in a finished state holds the listener back.
  api.blockedByStates = ['started'];
  api.state = { id: 'prog', name: 'In Progress', type: 'started' };
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(tracker.sessionsCreated, [], 'a blocked issue is not delegated');
  api.blockedByStates = ['completed'];
  await updated(['state']);
  await until(() => tracker.comments.some(c => c.kind === 'answer'), 'the worker answered');
  assert.deepEqual(tracker.sessionsCreated, ['api-7']);
  assert.deepEqual(tracker.delegated, [['api-7', 'app-user-dev']]);
  assert.equal(opencode.sessions.size, 1);
  const inbox = openLinearStore(store);
  assert.equal(inbox.list()[0]!.channel, 'dev:as-auto-1');
  // The same change delivered again (or the created webhook for a session we opened): already delegated, nothing new.
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(tracker.sessionsCreated.length, 1);

  // In Progress → Review keeps the same agent: a running worker is left alone. A move out of the mapping stops it.
  gated = true;
  await tracker.drive({ kind: 'prompted', id: 'act-2', conversation: 'dev:as-auto-1', body: 'Now the docs' });
  await until(() => inbox.list().some(t => t.state === 'running'), 'a worker is running');
  api.state = { id: 'rev', name: 'Review', type: 'started' };
  await updated(['state']);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(inbox.list().filter(t => t.state === 'running').length, 1, 'same agent, still running');
  api.labels = [{ id: 'l', name: 'needs-human' }];
  await updated(['labels']);
  await until(() => inbox.list().every(t => t.state !== 'running'), 'the worker was stopped');
  assert.deepEqual(opencode.interrupted, [inbox.list()[0]!.session], 'the OpenCode session was interrupted');
  assert.equal(inbox.list().at(-1)!.state, 'discarded');
  assert.match(inbox.list().at(-1)!.error!, /Stopped at the person/);
  assert.ok(
    tracker.ofKind('outcome').some(c => /Stopped at your request/.test(c.text)),
    'Linear was told',
  );
  assert.ok(
    tracker.ofKind('note').some(c => /needs-human.*was added/.test(c.text)),
    'and why',
  );
  assert.equal(store.leases().length, 0, 'the lease is released');
  release();
});
