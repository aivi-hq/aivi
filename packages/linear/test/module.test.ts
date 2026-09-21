import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { KnowledgeService } from '@aivi/core';
import { configSchema, getLogger } from '@aivi/core';
import type { HostServices, SessionEvents } from '@aivi/host';
import { Channels, connectOpenCode, PublicRoutes, Store, TaskRegistry } from '@aivi/host';
import type { AgentActivityInput, LinearIssue } from '../src/client.ts';
import { LinearClient } from '../src/client.ts';
import { conversationFor, createLinearModule, openLinearStore } from '../src/module.ts';
import { appWebhookPath } from '../src/routes.ts';
import { signWebhook } from '../src/webhook.ts';

const run = promisify(execFile);
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
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, 'http://x').pathname;
    res.setHeader('content-type', 'application/json');
    if (url.endsWith('/wait')) await gate();
    if (url.endsWith('/interrupt')) {
      interrupted.push(decodeURIComponent(url.split('/').at(-2)!));
      return void res.end('{"interrupted":true}');
    }
    if (url.startsWith('/api/agent')) return void res.end('{"data":[{"id":"developer","name":"developer"}]}');
    if (url.endsWith('/message')) return void res.end('{"data":[],"cursor":{"next":null}}');
    if (req.method === 'PATCH' || url.endsWith('/wait') || url.endsWith('/model')) return void res.writeHead(204).end();
    if (url.endsWith('/permission') && req.method === 'GET') return void res.end('{"data":[]}');
    if (url === '/api/session' && req.method === 'POST') {
      sessions.set(body.id, { agent: body.agent, directory: body.location.directory });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/prompt')) {
      prompts.push({ id: body.id, text: body.text, metadata: body.metadata });
      return void res.end(JSON.stringify({ data: { id: body.id } }));
    }
    if (url.endsWith('/context')) {
      const last = prompts.at(-1)!;
      // The transcript names the agent that ran; finalAnswer verifies it against the session's.
      const running = sessions.get(decodeURIComponent(url.split('/').at(-2)!))?.agent ?? 'developer';
      return void res.end(
        JSON.stringify({
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
        }),
      );
    }
    const id = decodeURIComponent(url.split('/').at(-1)!);
    const session = sessions.get(id) ?? { agent: 'developer', directory: '/x' };
    res.end(JSON.stringify({ data: { id, ...session, location: { directory: session.directory } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, prompts, sessions, interrupted };
}

/** A Linear that records activities and serves one issue. */
class FakeLinear extends LinearClient {
  activities: AgentActivityInput[] = [];
  issues = new Map<string, LinearIssue>();
  delegated: [string, string | null][] = [];
  sessionsCreated: string[] = [];
  comments: [string, string][] = [];
  constructor() {
    super({ clientId: 'x', clientSecret: 'y' }, { baseUrl: 'http://127.0.0.1:1' });
  }
  override async viewerId() {
    return 'app-user-dev';
  }
  override async createActivity(input: AgentActivityInput) {
    this.activities.push(input);
    return `act-${this.activities.length}`;
  }
  override async issue(id: string) {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  }
  override async createSessionOnIssue(issueId: string) {
    this.sessionsCreated.push(issueId);
    return `as-auto-${this.sessionsCreated.length}`;
  }
  override async setDelegate(issueId: string, delegateId: string | null) {
    this.delegated.push([issueId, delegateId]);
    const issue = this.issues.get(issueId);
    if (issue) issue.delegate = delegateId ? { id: delegateId } : null;
  }
  override async createComment(issueId: string, body: string) {
    this.comments.push([issueId, body]);
    return `c-${this.comments.length}`;
  }
}

const noEvents: SessionEvents = { watch: () => () => {} };
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};
const knowledge: KnowledgeService = { search: async () => [], index: async () => ({}), close: async () => {} };

test('a delegation in a mapped lane runs the lane agent in a worktree; people reach the assistant; a wrong delegation is un-taken; HITL refuses', async t => {
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
  process.env.LINEAR_CLIENT_ID = 'cid';
  process.env.LINEAR_CLIENT_SECRET = 'sec';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec';
  process.env.LINEAR_FACE_CLIENT_ID = 'face-cid';
  process.env.LINEAR_FACE_CLIENT_SECRET = 'face-sec';
  process.env.LINEAR_FACE_WEBHOOK_SECRET = 'face-whsec';
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    linear: { agent: 'assistant', primary: 'dev', apps: { dev: {}, face: {} }, mcp: false },
    projects: { website: { linear: { teams: ['t', 'tx'], lanes: { 'In Progress': 'developer' } } } },
  });
  const opencode = await fakeOpenCode(t, 'Done: fixed the header.');
  config.opencode.url = opencode.url;
  const loaded = {
    config,
    path: join(home, 'aivi.json'),
    projects: [
      {
        id: 'website',
        directory: source,
        linear: { teams: ['t', 'tx'], lanes: { 'In Progress': { agent: 'developer', worktree: true } } },
      },
    ],
    sources: [],
  };
  const linear = new FakeLinear();
  const issue = (id: string, extra: Partial<LinearIssue> = {}): LinearIssue => ({
    id,
    identifier: id.toUpperCase(),
    title: 'Fix header',
    description: 'It overlaps',
    branchName: `me/${id}-fix-header`,
    url: 'https://linear.app/x/issue/ENG-1',
    state: { id: 's1', name: 'In Progress', type: 'started' },
    team: { id: 't', key: 'ENG' },
    labels: [],
    delegate: { id: 'app-user-dev' },
    assignee: { id: 'u', name: 'Me' },
    blockedBy: [],
    ...extra,
  });
  linear.issues.set('eng-1', issue('eng-1'));
  linear.issues.set('eng-2', issue('eng-2', { labels: [{ id: 'l', name: 'needs-human' }] }));
  // A team no project maps: the assistant's ground, in the home.
  linear.issues.set('eng-3', issue('eng-3', { team: { id: 't9', key: 'OTH' } }));
  // A delegation into a lane nobody mapped: the assistant refuses it and the delegate is removed.
  linear.issues.set('eng-5', issue('eng-5', { state: { id: 's9', name: 'Deploy', type: 'started' } }));
  // A mention (no delegate) on the face, in a mapped team.
  linear.issues.set('eng-6', issue('eng-6', { delegate: null }));

  const store = new Store(':memory:');
  const routes = new PublicRoutes();
  const abort = new AbortController();
  const services: HostServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: abort.signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes,
    tasks: new TaskRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createLinearModule(
    config.linear!,
    new Map([
      ['dev', linear],
      ['face', linear],
    ]),
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  const deliver = async (app: string, secret: string, payload: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ organizationId: 'org', webhookTimestamp: Date.now(), ...payload }));
    return routes.get(appWebhookPath(app))!({
      method: 'POST',
      headers: { 'linear-signature': signWebhook(body, secret), 'linear-delivery': 'd' },
      body,
    });
  };
  const created = (agentSession: string, issueId: string) =>
    deliver('dev', 'whsec', {
      type: 'AgentSessionEvent',
      action: 'created',
      agentSession: { id: agentSession, issue: { id: issueId } },
      promptContext: `<issue identifier="${issueId.toUpperCase()}"><title>Fix header</title></issue>`,
    });

  assert.equal((await created('as-1', 'eng-1')).status, 200);
  await until(() => linear.activities.some(a => a.content.type === 'response'), 'the worker answered');
  const kinds = linear.activities.map(a => `${a.content.type}${a.ephemeral ? '~' : ''}`);
  assert.equal(kinds[0], 'thought~', 'acknowledged first');
  assert.match(
    (linear.activities[0]!.content as { body: string }).body,
    /Starting as `developer` in project website on branch `me\/eng-1-fix-header`/,
  );
  assert.deepEqual(linear.activities.at(-1)!.content, { type: 'response', body: 'Done: fixed the header.' });
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
  const workerConversation = conversationFor('dev', 'as-1');
  assert.deepEqual(
    [inbox.sessionOf(workerConversation)!.project, inbox.sessionOf(workerConversation)!.issue],
    ['website', 'eng-1'],
  );
  assert.equal(inbox.sessionOf(workerConversation)!.agent, 'developer');
  assert.equal((await created('as-1', 'eng-1')).status, 200, 'a redelivery is a no-op');
  assert.equal(inbox.list().length, 1);

  // A follow-up prompt is a new turn in the same session; a stop with nothing running says so.
  await deliver('dev', 'whsec', {
    type: 'AgentSessionEvent',
    action: 'prompted',
    agentSession: { id: 'as-1', issue: { id: 'eng-1' } },
    agentActivity: { id: 'act-p1', content: { type: 'prompt', body: 'Also fix the footer' } },
  });
  await until(() => opencode.prompts.length === 2, 'the follow-up reached the same session');
  assert.equal(opencode.prompts[1]!.text, '[Linear follow-up from a person in Linear]\nAlso fix the footer');
  await until(() => inbox.list().every(t => t.state === 'sent'), 'answered');
  await deliver('dev', 'whsec', {
    type: 'AgentSessionEvent',
    action: 'prompted',
    agentSession: { id: 'as-1' },
    agentActivity: { id: 'act-s', content: { type: 'prompt', body: '' }, signal: 'stop' },
  });
  await until(
    () =>
      linear.activities.some(a => a.content.type === 'response' && a.content.body === 'Nothing is running right now.'),
    'stop with nothing running',
  );

  // The HITL label refuses any agent.
  await created('as-2', 'eng-2');
  await until(
    () => linear.activities.some(a => a.content.type === 'error' && /needs-human/.test(a.content.body)),
    'HITL refused',
  );

  // A team no project maps: the assistant answers from the home, the delegate is un-taken.
  await created('as-3', 'eng-3');
  // The prompt is the last thing a dispatch posts (create the session, read it back, then prompt),
  // so waiting for it covers the session too. The stored turn would not: it exists the moment the
  // webhook is routed, long before anything reached OpenCode.
  await until(() => opencode.prompts.length === 3, 'the assistant turn reached OpenCode');
  const assistantSession = [...opencode.sessions.values()].find(s => s.agent === 'assistant')!;
  assert.equal(assistantSession.directory, home, 'no project: the assistant runs in the home');
  assert.deepEqual(linear.delegated.at(-1), ['eng-3', null], 'the wrong delegation was un-taken');
  assert.match(
    opencode.prompts[2]!.text,
    /was delegated to you, but its lane \("In Progress"\) is not mapped to any agent/,
  );

  // A delegation into an unmapped lane of a mapped team: the assistant, in the checkout.
  await created('as-5', 'eng-5');
  await until(() => inbox.list().length === 4, 'the assistant turn for the unmapped lane');
  assert.deepEqual(linear.delegated.at(-1), ['eng-5', null]);
  await until(
    () => [...opencode.sessions.values()].filter(s => s.agent === 'assistant' && s.directory === source).length === 1,
    'the assistant runs in the project checkout when the team maps one',
  );

  // A mention on the face reaches the same assistant; the conversation lives on the face.
  await deliver('face', 'face-whsec', {
    type: 'AgentSessionEvent',
    action: 'created',
    agentSession: { id: 'as-6', issue: { id: 'eng-6' } },
    promptContext: '<issue identifier="ENG-6">…</issue>',
  });
  await until(() => inbox.list().length === 5, 'the face mention became a turn');
  assert.equal(inbox.sessionOf(conversationFor('face', 'as-6'))!.agent, 'assistant');
  assert.deepEqual(
    linear.delegated.filter(d => d[0] === 'eng-6'),
    [],
    'a mention is not un-delegated',
  );
  await until(() => inbox.list().every(t => t.state === 'sent'), 'all answered');

  // A data change on a face's route is a misroute: acknowledged, dropped.
  const activitiesBefore = linear.activities.length;
  const strayIssue = Buffer.from(
    JSON.stringify({
      type: 'Issue',
      action: 'update',
      organizationId: 'org',
      webhookTimestamp: Date.now(),
      data: { id: 'eng-1', identifier: 'ENG-1', stateId: 'rev' },
      updatedFrom: { stateId: 'todo' },
    }),
  );
  assert.equal(
    (
      await routes.get(appWebhookPath('face'))!({
        method: 'POST',
        headers: { 'linear-signature': signWebhook(strayIssue, 'face-whsec') },
        body: strayIssue,
      })
    ).status,
    200,
    'a misrouted delivery is still acknowledged, so Linear does not retry',
  );
  await new Promise(r => setTimeout(r, 50));
  assert.equal(linear.activities.length, activitiesBefore, 'the stray delivery posted nothing');
  assert.equal(store.leases().length, 0, 'no capacity held');

  // A second mapped team routes to the same checkout: teams is a list on purpose.
  linear.issues.set('eng-4', issue('eng-4', { team: { id: 'tx', key: 'OPS' } }));
  await created('as-4', 'eng-4');
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
  process.env.LINEAR_CLIENT_ID = 'cid';
  process.env.LINEAR_CLIENT_SECRET = 'sec';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec';
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    linear: { apps: { dev: {} }, mcp: false },
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
    path: join(root, 'home/aivi.json'),
    projects: [
      {
        id: 'site',
        directory: source,
        linear: { teams: ['t'], lanes: { Research: { agent: 'researcher', worktree: false } } },
      },
    ],
    sources: [],
  };
  const linear = new FakeLinear();
  linear.issues.set('site-1', {
    id: 'site-1',
    identifier: 'SITE-1',
    title: 'What ships next',
    description: null,
    branchName: 'me/site-1',
    url: 'https://linear.app/x/issue/SITE-1',
    state: { id: 's', name: 'Research', type: 'started' },
    team: { id: 't', key: 'SITE' },
    labels: [],
    delegate: { id: 'app-user-dev' },
    assignee: { id: 'u', name: 'Me' },
    blockedBy: [],
  });
  const store = new Store(':memory:');
  const routes = new PublicRoutes();
  const services: HostServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: new AbortController().signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes,
    tasks: new TaskRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createLinearModule(config.linear!, new Map([['dev', linear]])).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });
  const body = Buffer.from(
    JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org',
      webhookTimestamp: Date.now(),
      agentSession: { id: 'as-r1', issue: { id: 'site-1' } },
      promptContext: '<issue identifier="SITE-1"></issue>',
    }),
  );
  await routes.get(appWebhookPath('dev'))!({
    method: 'POST',
    headers: { 'linear-signature': signWebhook(body, 'whsec'), 'linear-delivery': 'd' },
    body,
  });
  const inbox = openLinearStore(store);
  await until(() => inbox.list().some(t => t.state === 'sent'), 'answered from the checkout');
  const session = [...opencode.sessions.values()][0]!;
  assert.deepEqual(session, { agent: 'researcher', directory: source }, 'no worktree: the checkout is the directory');
  assert.match(opencode.prompts[0]!.text, /clean checkout/, 'the prompt says where the agent works');
  assert.ok(
    linear.activities.some(a => a.content.type === 'thought' && /working in the project checkout/.test(a.content.body)),
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
  process.env.LINEAR_CLIENT_ID = 'cid';
  process.env.LINEAR_CLIENT_SECRET = 'sec';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec';

  let release: () => void = () => {};
  let gated = false;
  const gate = () => (gated ? new Promise<void>(r => (release = r)) : Promise.resolve());
  const opencode = await fakeOpenCode(t, 'Shipped.', gate);
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    linear: { apps: { dev: {} }, mcp: false, listener: true },
    projects: { api: { linear: { teams: ['t'], lanes: { 'In Progress': 'developer', Review: 'developer' } } } },
  });
  const loaded = {
    config,
    path: join(root, 'home/aivi.json'),
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
  const linear = new FakeLinear();
  const issue: LinearIssue = {
    id: 'api-7',
    identifier: 'API-7',
    title: 'Add rate limits',
    description: null,
    branchName: 'me/api-7-rate-limits',
    url: 'https://linear.app/x/issue/API-7',
    state: { id: 'todo', name: 'Todo', type: 'unstarted' },
    team: { id: 't', key: 'API' },
    labels: [],
    delegate: null,
    assignee: { id: 'u', name: 'Me' },
    blockedBy: [],
  };
  linear.issues.set('api-7', issue);
  const store = new Store(':memory:');
  const routes = new PublicRoutes();
  const abort = new AbortController();
  const services: HostServices = {
    loaded,
    store,
    knowledge,
    opencode: () => connectOpenCode(loaded.config.opencode, {}),
    events: noEvents,
    signal: abort.signal,
    log: getLogger(['aivi']),
    channels: new Channels(),
    routes,
    tasks: new TaskRegistry().forModule('test'),
    wake: () => {},
    onWake: () => () => {},
    fail: error => assert.fail(String(error)),
  };
  const running = await createLinearModule(config.linear!, new Map([['dev', linear]])).start(services);
  t.after(async () => {
    release();
    await running.stop();
    store.close();
  });
  const issueUpdate = async (updatedFrom: Record<string, unknown>) => {
    const body = Buffer.from(
      JSON.stringify({
        type: 'Issue',
        action: 'update',
        organizationId: 'org',
        webhookTimestamp: Date.now(),
        data: { id: issue.id, identifier: issue.identifier, stateId: issue.state.id },
        updatedFrom,
      }),
    );
    return routes.get(appWebhookPath('dev'))!({
      method: 'POST',
      headers: { 'linear-signature': signWebhook(body, 'whsec') },
      body,
    });
  };

  // A title edit is not a routing change: nothing happens.
  await issueUpdate({ title: 'old' });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(linear.sessionsCreated, []);

  // Linear's native blocking: a blocker not in a finished state holds the listener back.
  issue.blockedBy = [{ id: 'api-6', state: { id: 's', name: 'In Progress', type: 'started' } }];
  issue.state = { id: 'prog', name: 'In Progress', type: 'started' };
  await issueUpdate({ stateId: 'todo' });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(linear.sessionsCreated, [], 'a blocked issue is not delegated');
  issue.blockedBy = [{ id: 'api-6', state: { id: 's2', name: 'Done', type: 'completed' } }];
  await issueUpdate({ stateId: 'todo' });
  await until(() => linear.activities.some(a => a.content.type === 'response'), 'the worker answered');
  assert.deepEqual(linear.sessionsCreated, ['api-7']);
  assert.deepEqual(linear.delegated, [['api-7', 'app-user-dev']]);
  assert.equal(opencode.sessions.size, 1);
  const inbox = openLinearStore(store);
  assert.equal(inbox.list()[0]!.channel, conversationFor('dev', 'as-auto-1'));
  // The same change delivered again (or the created webhook for a session we opened): already delegated, nothing new.
  await issueUpdate({ stateId: 'todo' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(linear.sessionsCreated.length, 1);

  // In Progress → Review keeps the same agent: a running worker is left alone. A move out of the mapping stops it.
  gated = true;
  const body = Buffer.from(
    JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org',
      webhookTimestamp: Date.now(),
      agentSession: { id: 'as-auto-1', issue: { id: 'api-7' } },
      agentActivity: { id: 'act-2', content: { type: 'prompt', body: 'Now the docs' } },
    }),
  );
  await routes.get(appWebhookPath('dev'))!({
    method: 'POST',
    headers: { 'linear-signature': signWebhook(body, 'whsec') },
    body,
  });
  await until(() => inbox.list().some(t => t.state === 'running'), 'a worker is running');
  issue.state = { id: 'rev', name: 'Review', type: 'started' };
  await issueUpdate({ stateId: 'prog' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(inbox.list().filter(t => t.state === 'running').length, 1, 'same agent, still running');
  issue.labels = [{ id: 'l', name: 'needs-human' }];
  await issueUpdate({ labelIds: [] });
  await until(() => inbox.list().every(t => t.state !== 'running'), 'the worker was stopped');
  assert.deepEqual(opencode.interrupted, [inbox.list()[0]!.session], 'the OpenCode session was interrupted');
  assert.equal(inbox.list().at(-1)!.state, 'discarded');
  assert.match(inbox.list().at(-1)!.error!, /Stopped at the person/);
  assert.ok(
    linear.activities.some(a => a.content.type === 'error' && /Stopped at your request/.test(a.content.body)),
    'Linear was told',
  );
  assert.ok(
    linear.activities.some(a => a.content.type === 'thought' && /needs-human.*was added/.test(a.content.body)),
    'and why',
  );
  assert.equal(store.leases().length, 0, 'the lease is released');
  release();
});
