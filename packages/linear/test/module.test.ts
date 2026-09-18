import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { KnowledgeService } from '@aivi/core';
import { configSchema, silentLogger } from '@aivi/core';
import type { HostServices, SessionEvents } from '@aivi/host';
import { Channels, connectOpenCode, PublicRoutes, Store, TaskRegistry } from '@aivi/host';
import type { AgentActivityInput, LinearIssue } from '../src/client.ts';
import { LinearClient } from '../src/client.ts';
import { conversationFor, createLinearModule, openLinearStore } from '../src/module.ts';
import { appWebhookPath, dataWebhookPath } from '../src/routes.ts';
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
      return void res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: last.id, text: last.text, time: { created: 1 } },
            {
              type: 'assistant',
              id: 'a',
              agent: 'developer',
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
}

const noEvents: SessionEvents = { watch: () => () => {} };
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};
const knowledge: KnowledgeService = { search: async () => [], index: async () => ({}), close: async () => {} };

test('a delegation runs the mapped agent in a worktree and answers with a response; HITL and unmapped issues are refused; follow-ups and stop work', async t => {
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

  process.env.LINEAR_DEV_CLIENT_ID = 'cid';
  process.env.LINEAR_DEV_CLIENT_SECRET = 'sec';
  process.env.LINEAR_DEV_WEBHOOK_SECRET = 'whsec';
  process.env.LINEAR_CLIENT_ID = 'data-cid';
  process.env.LINEAR_CLIENT_SECRET = 'data-sec';
  process.env.LINEAR_WEBHOOK_SECRET = 'data-whsec';
  const config = configSchema.parse({
    version: 1,
    opencode: { url: 'http://placeholder' },
    linear: { apps: { dev: { agent: 'developer' } } },
    projects: { website: { linear: { teams: ['t', 'tx'], lanes: { 'In Progress': 'dev' } } } },
  });
  const opencode = await fakeOpenCode(t, 'Done: fixed the header.');
  config.opencode.url = opencode.url;
  const loaded = {
    config,
    path: join(root, 'home/aivi.json'),
    projects: [{ id: 'website', directory: source, linear: { teams: ['t', 'tx'], lanes: { 'In Progress': 'dev' } } }],
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
    ...extra,
  });
  linear.issues.set('eng-1', issue('eng-1'));
  linear.issues.set('eng-2', issue('eng-2', { labels: [{ id: 'l', name: 'needs-human' }] }));
  linear.issues.set('eng-3', issue('eng-3', { team: { id: 't9', key: 'OTH' } }));

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
    log: silentLogger,
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
      ['data', linear],
    ]),
  ).start(services);
  t.after(async () => {
    await running.stop();
    store.close();
  });

  const deliver = async (payload: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ organizationId: 'org', webhookTimestamp: Date.now(), ...payload }));
    return routes.get(appWebhookPath('dev'))!({
      method: 'POST',
      headers: { 'linear-signature': signWebhook(body, 'whsec'), 'linear-delivery': 'd' },
      body,
    });
  };
  const created = (agentSession: string, issueId: string) =>
    deliver({
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
  const session = [...opencode.sessions.values()][0]!;
  assert.deepEqual(session, { agent: 'developer', directory: worktree }, 'the mapped agent runs in the worktree');
  assert.match(
    opencode.prompts[0]!.text,
    /Linear delegated ENG-1 "Fix header" to you \(app dev\) in project website, lane "In Progress"/,
  );
  assert.match(opencode.prompts[0]!.text, /<issue identifier="ENG-1">/);
  const inbox = openLinearStore(store);
  assert.equal(inbox.list()[0]!.state, 'sent');
  assert.deepEqual(
    [inbox.sessionOf(conversationFor('dev', 'as-1'))!.project, inbox.sessionOf(conversationFor('dev', 'as-1'))!.issue],
    ['website', 'eng-1'],
  );
  assert.equal((await created('as-1', 'eng-1')).status, 200, 'a redelivery is a no-op');
  assert.equal(inbox.list().length, 1);

  // A follow-up prompt is a new turn in the same session; a stop with nothing running says so.
  await deliver({
    type: 'AgentSessionEvent',
    action: 'prompted',
    agentSession: { id: 'as-1', issue: { id: 'eng-1' } },
    agentActivity: { id: 'act-p1', content: { type: 'prompt', body: 'Also fix the footer' } },
  });
  await until(() => opencode.prompts.length === 2, 'the follow-up reached the same session');
  assert.equal(opencode.prompts[1]!.text, '[Linear follow-up from a person in Linear]\nAlso fix the footer');
  await until(() => inbox.list().every(t => t.state === 'sent'), 'answered');
  await deliver({
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

  // Refusals: the HITL label, an issue outside every mapped team, an unknown session.
  await created('as-2', 'eng-2');
  await until(
    () => linear.activities.some(a => a.content.type === 'error' && /needs-human/.test(a.content.body)),
    'HITL refused',
  );
  await created('as-3', 'eng-3');
  await until(
    () =>
      linear.activities.some(
        a => a.content.type === 'error' && /not in a Linear team that aivi maps/.test(a.content.body),
      ),
    'unmapped refused',
  );
  await deliver({
    type: 'AgentSessionEvent',
    action: 'prompted',
    agentSession: { id: 'as-9' },
    agentActivity: { id: 'act-x', content: { type: 'prompt', body: 'hi' } },
  });
  await until(
    () => linear.activities.some(a => a.content.type === 'error' && /do not know this session/.test(a.content.body)),
    'unknown session refused',
  );

  // Wrong-endpoint deliveries are acknowledged and dropped: a data change
  // arriving on the app route, an agent-session event on the data route.
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
      await routes.get(appWebhookPath('dev'))!({
        method: 'POST',
        headers: { 'linear-signature': signWebhook(strayIssue, 'whsec') },
        body: strayIssue,
      })
    ).status,
    200,
    'a misrouted delivery is still acknowledged, so Linear does not retry',
  );
  const straySession = Buffer.from(
    JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org',
      webhookTimestamp: Date.now(),
      agentSession: { id: 'as-stray', issue: { id: 'eng-1' } },
    }),
  );
  assert.equal(
    (
      await routes.get(dataWebhookPath)!({
        method: 'POST',
        headers: { 'linear-signature': signWebhook(straySession, 'data-whsec') },
        body: straySession,
      })
    ).status,
    200,
  );
  await new Promise(r => setTimeout(r, 50));
  assert.equal(linear.activities.length, activitiesBefore, 'neither stray delivery posted anything');
  assert.equal(inbox.list().length, 2, 'refused sessions never became turns');
  assert.equal(store.leases().length, 0, 'no capacity held');

  // A second mapped team routes to the same checkout: teams is a list on purpose.
  linear.issues.set('eng-4', issue('eng-4', { team: { id: 'tx', key: 'OPS' } }));
  await created('as-4', 'eng-4');
  await until(() => opencode.prompts.some(p => p.text.includes('ENG-4')), 'the other mapped team routes');
  await until(() => inbox.list().every(t => t.state === 'sent'), 'and answered');
  assert.ok(await stat(join(root, 'home/projects/website/worktrees/as-4')), 'a worktree of the same checkout');
});

test('the listener delegates an issue entering a mapped lane and starts the worker; the HITL label or a lane change mid-run stops it', async t => {
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
  process.env.LINEAR_DEV_CLIENT_ID = 'cid';
  process.env.LINEAR_DEV_CLIENT_SECRET = 'sec';
  process.env.LINEAR_DEV_WEBHOOK_SECRET = 'whsec';
  process.env.LINEAR_CLIENT_ID = 'data-cid';
  process.env.LINEAR_CLIENT_SECRET = 'data-sec';
  process.env.LINEAR_WEBHOOK_SECRET = 'data-whsec';

  let release: () => void = () => {};
  let gated = false;
  const gate = () => (gated ? new Promise<void>(r => (release = r)) : Promise.resolve());
  const opencode = await fakeOpenCode(t, 'Shipped.', gate);
  const lanes = { 'In Progress': 'dev', Review: 'dev' };
  const config = configSchema.parse({
    version: 1,
    opencode: { url: opencode.url },
    linear: { apps: { dev: { agent: 'developer' } }, listener: true },
    projects: { api: { linear: { teams: ['t'], lanes } } },
  });
  const loaded = {
    config,
    path: join(root, 'home/aivi.json'),
    projects: [{ id: 'api', directory: source, linear: { teams: ['t'], lanes } }],
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
    log: silentLogger,
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
      ['data', linear],
    ]),
  ).start(services);
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
    return routes.get(dataWebhookPath)!({
      method: 'POST',
      headers: { 'linear-signature': signWebhook(body, 'data-whsec') },
      body,
    });
  };

  // A title edit is not a routing change: nothing happens.
  await issueUpdate({ title: 'old' });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(linear.sessionsCreated, []);

  // Todo → In Progress with no delegate: the listener delegates the lane's app and the worker runs to an answer.
  issue.state = { id: 'prog', name: 'In Progress', type: 'started' };
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

  // In Progress → Review keeps the same app: a running worker is left alone. A move out of the mapping stops it.
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
  assert.equal(inbox.list().filter(t => t.state === 'running').length, 1, 'same app, still running');
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
  assert.equal(store.leases().length, 0, 'the lock is released');
  release();
});
