/**
 * What Linear's platform decides, one unit at a time: which credentials each
 * app speaks with, what a neutral word becomes on Linear's API, and how a
 * delivery becomes normalized events — or nothing. Linear's client is a fake
 * whose every call is a `mock.fn()`, the routes the platform registers are
 * caught here, and the seal on a delivery is signed with the helper Linear's
 * own would be. Nothing here reaches a network. `test/tracker.test.ts` runs
 * the same platform over a fake client of its own.
 */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import type { PublicRouteHandler } from '@aivi/plugin';
import { ConfigurationError } from '@aivi/plugin';
import type { TrackerEvent } from '@aivi/plugin/tracker';
import { recorder } from '../../host/test/support.ts';
import { LinearApiError, type LinearClient, type LinearIssue, type LinearTeam } from '../src/client.ts';
import { type LinearConfig, linearSchema } from '../src/config.ts';
import { appWebhookPath } from '../src/routes.ts';
import { clientFor, createLinearPlatform, LinearPlatform, requireLinearSecrets } from '../src/tracker.ts';
import { signWebhook } from '../src/webhook.ts';

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/** The environment the credentials are read from: the primary under the bare names, a face under its own. */
const environment = (t: TestContext) =>
  t.mock.property(process, 'env', {
    ...process.env,
    LINEAR_CLIENT_ID: 'cid',
    LINEAR_CLIENT_SECRET: 'sec',
    LINEAR_WEBHOOK_SECRET: 'whsec-dev',
    LINEAR_FACE_CLIENT_ID: 'face-cid',
    LINEAR_FACE_CLIENT_SECRET: 'face-sec',
    LINEAR_FACE_WEBHOOK_SECRET: 'whsec-face',
  });

const noRoutes = { register: () => () => {} };

const linearIssue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'iss-1',
  identifier: 'ENG-1',
  title: 'Fix it',
  description: null,
  branchName: 'me/eng-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
  team: { id: 'team-1', key: 'ENG' },
  labels: [],
  delegate: null,
  assignee: null,
  archivedAt: null,
  blockedBy: [],
  priority: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const teams: LinearTeam[] = [
  {
    id: 'team-1',
    key: 'ENG',
    name: 'Engineering',
    states: [
      { id: 's-todo', name: 'Todo', type: 'unstarted' },
      { id: 's-done', name: 'Done', type: 'completed' },
    ],
  },
];

/** The client the platform is built over: every call answers what a quiet Linear
 *  would, and a test turns one answer where it needs another. */
function fakeClient() {
  return {
    viewer: mock.fn(async () => ({ id: 'app-user', organizationId: 'org-1' })),
    issue: mock.fn(async (..._read: unknown[]) => linearIssue()),
    listTeams: mock.fn(async () => teams),
    setDelegate: mock.fn(async (..._delegated: unknown[]) => ({ success: true })),
    setPlan: mock.fn(async (..._planned: unknown[]) => {}),
    createActivity: mock.fn(async (..._activity: unknown[]) => 'act-1'),
    createComment: mock.fn(async (..._said: unknown[]) => {}),
    issueComments: mock.fn(async (..._asked: unknown[]) => [] as { author: string | null; body: string; at: string }[]),
    issueUpdate: mock.fn(async (..._edited: unknown[]) => linearIssue({ title: 'Sharper' })),
    createIssue: mock.fn(async (..._made: unknown[]) => linearIssue({ id: 'iss-2', identifier: 'ENG-2' })),
    teamLabelNames: mock.fn(async (..._asked: unknown[]) => ['bug', 'needs-human']),
    agentSessionEnded: mock.fn(async (..._asked: unknown[]) => true),
    closingNoteFacts: mock.fn(async (..._asked: unknown[]) => ({
      comments: [] as { body: string }[],
      sessions: [] as { id: string; url: string | null }[],
    })),
    transitionIssue: mock.fn(async (..._moved: unknown[]) => {}),
  };
}

/** The platform over a fake client, its identities learned, its routes caught
 *  and its events heard: `arrival()` is the moment the next event reaches the
 *  sink, asked for before the delivery and waited on after it. */
async function platformOver(t: TestContext, config: Record<string, unknown> = {}) {
  environment(t);
  const lines = recorder();
  const client = fakeClient();
  const handlers = new Map<string, PublicRouteHandler>();
  const routes = {
    register: mock.fn((path: string, handler: PublicRouteHandler) => {
      handlers.set(path, handler);
      return () => {};
    }),
  };
  const apps = new Map([
    ['dev', client as unknown as LinearClient],
    ['face', client as unknown as LinearClient],
  ]);
  const platform = await createLinearPlatform(
    linearSchema.parse({ primary: 'dev', apps: { dev: {}, face: {} }, ...config }),
    routes,
    apps,
    lines.log,
  );
  const events: TrackerEvent[] = [];
  const waiting: PromiseWithResolvers<void>[] = [];
  platform.events(async event => {
    events.push(event);
    waiting.shift()?.resolve();
  });
  const arrival = () => {
    const next = Promise.withResolvers<void>();
    waiting.push(next);
    return next.promise;
  };
  const deliver = (app: string, payload: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ organizationId: 'org-1', webhookTimestamp: Date.now(), ...payload }));
    return handlers.get(appWebhookPath(app))!({
      method: 'POST',
      headers: { 'linear-signature': signWebhook(body, `whsec-${app}`), 'linear-delivery': 'd1' },
      body,
    });
  };
  return { platform, client, lines, events, arrival, deliver };
}

const unnamedPrimary: LinearConfig = {
  apps: { dev: {}, face: {} },
  logMisroutes: true,
  humanLabel: 'needs-human',
  pool: 'default',
  mcp: false,
  progress: 'tools',
};

test('every app’s credentials come from the environment: the primary under the bare names, a face under its own prefix', () => {
  const config = linearSchema.parse({ primary: 'dev', apps: { dev: {}, 'my-face': {} } });
  const env = {
    LINEAR_CLIENT_ID: 'cid',
    LINEAR_CLIENT_SECRET: 'sec',
    LINEAR_WEBHOOK_SECRET: 'whsec',
    LINEAR_MY_FACE_CLIENT_ID: 'face-cid',
    LINEAR_MY_FACE_CLIENT_SECRET: 'face-sec',
    LINEAR_MY_FACE_WEBHOOK_SECRET: 'face-whsec',
  };
  assert.deepEqual(requireLinearSecrets(config, env), [
    { id: 'dev', clientId: 'cid', clientSecret: 'sec', webhookSecret: 'whsec' },
    { id: 'my-face', clientId: 'face-cid', clientSecret: 'face-sec', webhookSecret: 'face-whsec' },
  ]);
});

test('a missing credential is the operator’s to fix, and the message names every one that is missing', () => {
  const config = linearSchema.parse({ primary: 'dev', apps: { dev: {}, face: {} } });
  assert.throws(
    () => requireLinearSecrets(config, { LINEAR_CLIENT_ID: 'cid' }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.message === 'Linear app dev: set LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET in <home>/.env',
  );
  assert.throws(
    () =>
      requireLinearSecrets(config, { LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 's', LINEAR_WEBHOOK_SECRET: 'w' }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.message ===
        'Linear app face: set LINEAR_FACE_CLIENT_ID, LINEAR_FACE_CLIENT_SECRET, LINEAR_FACE_WEBHOOK_SECRET in <home>/.env',
  );
});

test('several apps and no named primary leave the data feed without an owner, and the credentials cannot be told apart', () => {
  assert.throws(
    () => requireLinearSecrets(unnamedPrimary, {}),
    (error: unknown) => error instanceof ConfigurationError && /set `linear\.primary`/.test(error.message),
  );
});

test('the client for an app is refused before it is built when there is no app to choose, too many to guess, or none by that name', () => {
  const log = recorder().log;
  const two = linearSchema.parse({ primary: 'dev', apps: { dev: {}, face: {} } });
  assert.throws(() => clientFor(linearSchema.parse({ apps: {} }), undefined, log), /linear\.apps is empty/);
  assert.throws(() => clientFor(two, undefined, log), /Several Linear apps are configured \(dev, face\): pass --app/);
  assert.throws(() => clientFor(two, 'ghost', log), /Unknown Linear app ghost\. Configured: dev, face/);
});

test('the client for an app speaks with that app’s own credentials; the one app of a home needs no name', async t => {
  environment(t);
  const tokens: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    tokens.push((init.headers as Record<string, string>).authorization);
    return Response.json({ access_token: 'tok', expires_in: 86_399 });
  });
  const log = recorder().log;
  await clientFor(linearSchema.parse({ primary: 'dev', apps: { dev: {}, face: {} } }), 'face', log).accessToken();
  await clientFor(linearSchema.parse({ apps: { dev: {} } }), undefined, log).accessToken();
  assert.deepEqual(tokens, [basic('face-cid', 'face-sec'), basic('cid', 'sec')]);
});

test('by default each app speaks with a client of its own credentials and learns its own identity in its own workspace', async t => {
  environment(t);
  const who: Record<string, unknown> = {
    'tok-dev': { id: 'dev-user', organization: { id: 'org-dev' } },
    'tok-face': { id: 'face-user', organization: { id: 'org-face' } },
  };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const authorization = (init.headers as Record<string, string>).authorization!;
    return url.endsWith('/oauth/token')
      ? Response.json({ access_token: authorization === basic('cid', 'sec') ? 'tok-dev' : 'tok-face' })
      : Response.json({ data: { viewer: who[authorization.replace('Bearer ', '')] } });
  });
  const platform = await createLinearPlatform(
    linearSchema.parse({ primary: 'dev', apps: { dev: {}, face: {} } }),
    noRoutes,
  );
  assert.deepEqual([platform.ownerOf('dev:as-1'), await platform.orgOf('dev:as-1')], ['dev-user', 'org-dev']);
  assert.deepEqual([platform.ownerOf('face:as-1'), await platform.orgOf('face:as-1')], ['face-user', 'org-face']);
});

test('a platform with no app is a configuration error before any credential is read', () => {
  assert.throws(
    () => new LinearPlatform(linearSchema.parse({ apps: {} }), noRoutes),
    (error: unknown) => error instanceof ConfigurationError && /linear\.apps is empty/.test(error.message),
  );
});

test('credentials Linear refuses are a setup error for the operator; any other failure is the caller’s to retry', async t => {
  environment(t);
  const config = linearSchema.parse({ apps: { dev: {} } });
  const failing = (error: unknown) =>
    new Map([
      [
        'dev',
        {
          viewer: async () => {
            throw error;
          },
        } as unknown as LinearClient,
      ],
    ]);
  for (const status of [400, 401])
    await assert.rejects(
      createLinearPlatform(config, noRoutes, failing(new LinearApiError('invalid_client', status))),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.message === 'Linear app dev: credentials rejected (invalid_client)',
    );
  await assert.rejects(
    createLinearPlatform(config, noRoutes, failing(new LinearApiError('upstream down', 503))),
    (error: unknown) => error instanceof LinearApiError && error.status === 503,
  );
  await assert.rejects(createLinearPlatform(config, noRoutes, failing(new Error('network down'))), /network down/);
});

test('a conversation of an app nobody configured is refused', async t => {
  const { platform } = await platformOver(t);
  await assert.rejects(platform.orgOf('stranger:as-1'), /Linear app for conversation stranger:as-1 is not configured/);
});

test('the desk’s words go to Linear as they are: the delegate, the comments, an edit read back in neutral words, the team’s labels', async t => {
  const { platform, client } = await platformOver(t);
  await platform.assign('dev', 'iss-1', 'app-user');
  assert.deepEqual(client.setDelegate.mock.calls[0]!.arguments, ['iss-1', 'app-user']);
  assert.deepEqual(await platform.ticketComments('dev', 'iss-1'), []);
  assert.deepEqual(client.issueComments.mock.calls[0]!.arguments, ['iss-1']);
  await platform.addComment('dev', 'iss-1', 'a plain word');
  assert.deepEqual(client.createComment.mock.calls[0]!.arguments, ['iss-1', 'a plain word']);
  const edited = await platform.editIssue('dev', 'iss-1', { title: 'Sharper' });
  assert.deepEqual(client.issueUpdate.mock.calls[0]!.arguments, ['iss-1', { title: 'Sharper' }]);
  assert.deepEqual([edited.title, edited.teamId, edited.archived], ['Sharper', 'team-1', false]);
  assert.deepEqual(await platform.teamLabels('dev', 'team-1'), ['bug', 'needs-human']);
  assert.deepEqual(client.teamLabelNames.mock.calls[0]!.arguments, ['team-1']);
});

test('a new ticket lands in the lane it names on its team; a lane the team lacks is said, never guessed past', async t => {
  const { platform, client } = await platformOver(t);
  const made = await platform.createIssue('dev', {
    teamId: 'team-1',
    title: 'New',
    description: 'words',
    lane: 'Todo',
  });
  assert.deepEqual(client.createIssue.mock.calls[0]!.arguments, [
    { teamId: 'team-1', title: 'New', description: 'words', stateId: 's-todo' },
  ]);
  assert.equal(made.identifier, 'ENG-2');
  await platform.createIssue('dev', { teamId: 'team-1', title: 'Plain' });
  assert.deepEqual(client.createIssue.mock.calls[1]!.arguments, [{ teamId: 'team-1', title: 'Plain' }]);
  assert.equal(client.listTeams.mock.callCount(), 1, 'no lane asked for, so the board is not read');
  for (const teamId of ['team-1', 'team-9'])
    await assert.rejects(
      platform.createIssue('dev', { teamId, title: 'Lost', lane: 'Nowhere' }),
      new RegExp(`Linear team ${teamId} has no state named "Nowhere" — check createLane in config`),
    );
  assert.equal(client.createIssue.mock.callCount(), 2, 'and nothing was created for them');
});

test('the agent session’s own words: the plan whole, the result asked of Linear, a question with options as a select', async t => {
  const { platform, client } = await platformOver(t);
  const steps = [{ content: 'read the code', status: 'completed' as const }];
  await platform.plan('dev:as-1', { steps });
  assert.deepEqual(client.setPlan.mock.calls[0]!.arguments, ['as-1', steps]);
  assert.equal(await platform.resultShown('dev:as-1'), true);
  assert.deepEqual(client.agentSessionEnded.mock.calls[0]!.arguments, ['as-1']);
  const options = [{ label: 'main', value: 'main' }];
  await platform.ask('dev:as-1', { question: 'Which branch?', options });
  await platform.ask('dev:as-1', { question: 'Which branch?', options: [] });
  await platform.ask('dev:as-1', { question: 'Which branch?' });
  assert.deepEqual(
    client.createActivity.mock.calls.map(call => call.arguments[0]),
    [
      {
        agentSessionId: 'as-1',
        content: { type: 'elicitation', body: 'Which branch?' },
        signal: 'select',
        signalMetadata: { options },
      },
      { agentSessionId: 'as-1', content: { type: 'elicitation', body: 'Which branch?' } },
      { agentSessionId: 'as-1', content: { type: 'elicitation', body: 'Which branch?' } },
    ],
    'the select signal rides only when there are options to pick from',
  );
});

test('a running tool with no detail names itself in the progress line’s own words', async t => {
  const { platform, client } = await platformOver(t);
  await platform.progress('dev:as-1', { text: '🔧 reading', tool: { name: 'read' } });
  assert.deepEqual(client.createActivity.mock.calls[0]!.arguments[0], {
    agentSessionId: 'as-1',
    content: { type: 'action', action: 'read', parameter: '🔧 reading' },
    ephemeral: true,
  });
});

test('a closing note already on the ticket stands by its link as well as by its session id; another session’s note does not', async t => {
  const { platform, client } = await platformOver(t);
  const url = 'https://linear.app/acme/agent/abc';
  client.closingNoteFacts.mock.mockImplementation(async () => ({
    comments: [{ body: `Done.\n\n— aivi · [agent session](${url})` }],
    sessions: [{ id: 'as-1', url }],
  }));
  await platform.closingNote('dev:as-1', 'iss-1', 'Done.');
  assert.equal(client.createComment.mock.callCount(), 0, 'the trailer names the link, so the note stands');
  client.closingNoteFacts.mock.mockImplementation(async () => ({
    comments: [{ body: 'Done.\n\n— aivi · agent session `as-2`' }],
    sessions: [{ id: 'as-1', url: null }],
  }));
  await platform.closingNote('dev:as-1', 'iss-1', 'Done.');
  assert.deepEqual(
    client.createComment.mock.calls.map(call => call.arguments),
    [['iss-1', 'Done.\n\n— aivi · agent session `as-1`']],
    'a session with no link is marked by id, and another session’s trailer is not its own',
  );
  client.closingNoteFacts.mock.mockImplementation(async () => ({
    comments: [{ body: 'Done.\n\n— aivi · [agent session](https://linear.app/acme/agent/xyz)' }],
    sessions: [{ id: 'as-1', url }],
  }));
  await platform.closingNote('dev:as-1', 'iss-1', 'Done.');
  assert.deepEqual(
    client.createComment.mock.calls.at(-1)!.arguments,
    ['iss-1', `Done.\n\n— aivi · [agent session](${url})`],
    'a link that is not this session’s is not its note',
  );
});

test('a plain comment is a durable note on the session; a move lands in the lane of the ticket’s own team, once', async t => {
  const { platform, client } = await platformOver(t);
  await platform.apply('dev:as-1', 'iss-1', { kind: 'comment', text: 'a note for people' });
  assert.deepEqual(client.createActivity.mock.calls[0]!.arguments[0], {
    agentSessionId: 'as-1',
    content: { type: 'thought', body: 'a note for people' },
  });
  await platform.apply('dev:as-1', 'iss-1', { kind: 'move', lane: 'Done' });
  assert.deepEqual(
    client.transitionIssue.mock.calls.map(call => call.arguments),
    [['iss-1', 's-done']],
  );
  await platform.apply('dev:as-1', 'iss-1', { kind: 'move', lane: 'Todo' });
  assert.equal(
    client.transitionIssue.mock.callCount(),
    1,
    'the ticket is there already: the move landed before a crash',
  );
});

test('a move into a state the ticket’s team does not have is said with the lane that asked for it', async t => {
  const { platform, client } = await platformOver(t);
  await assert.rejects(
    platform.apply('dev:as-1', 'iss-1', { kind: 'move', lane: 'Review' }),
    /Linear team ENG has no state named "Review" — check the project's lanes/,
  );
  client.issue.mock.mockImplementationOnce(async () => linearIssue({ team: { id: 'team-9', key: 'OPS' } }));
  await assert.rejects(
    platform.apply('dev:as-1', 'iss-1', { kind: 'move', lane: 'Todo' }),
    /Linear team OPS has no state named "Todo"/,
  );
  assert.equal(client.transitionIssue.mock.callCount(), 0);
});

test('an agent session without an issue is noise, said; one with an issue becomes a started event with only what it carried', async t => {
  const { events, lines, arrival, deliver } = await platformOver(t);
  await deliver('dev', { type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'as-1' } });
  assert.deepEqual(await lines.next('webhook.session-without-issue'), {
    level: 'warn',
    event: 'webhook.session-without-issue',
    conversation: 'dev:as-1',
  });
  const arrived = arrival();
  await deliver('dev', {
    type: 'AgentSessionEvent',
    action: 'created',
    agentSession: { id: 'as-2', issue: { id: 'iss-1' } },
  });
  await arrived;
  assert.deepEqual(events, [{ kind: 'started', conversation: 'dev:as-2', issueId: 'iss-1' }]);
});

test('a prompt with no activity is still a message in its session; its signal rides along when it has one', async t => {
  const { events, arrival, deliver } = await platformOver(t);
  let arrived = arrival();
  await deliver('dev', { type: 'AgentSessionEvent', action: 'prompted', agentSession: { id: 'as-3' } });
  await arrived;
  arrived = arrival();
  await deliver('face', {
    type: 'AgentSessionEvent',
    action: 'prompted',
    agentSession: { id: 'as-4' },
    agentActivity: { id: 'act-4', content: { type: 'prompt' }, signal: 'stop' },
  });
  await arrived;
  assert.deepEqual(events, [
    { kind: 'prompted', id: 'seen:as-3', conversation: 'dev:as-3' },
    { kind: 'prompted', id: 'act-4', conversation: 'face:as-4', signal: 'stop' },
  ]);
});

test('a webhook type aivi does not read is heard as nothing, and a data change on a face’s route is dropped quietly when misroutes are not logged', async t => {
  const { events, lines, deliver } = await platformOver(t, { logMisroutes: false });
  await deliver('dev', { type: 'Comment', action: 'create' });
  assert.deepEqual(await lines.next('webhook.ignored'), {
    level: 'debug',
    event: 'webhook.ignored',
    app: 'dev',
    type: 'Comment',
    action: 'create',
  });
  await deliver('face', { type: 'Issue', action: 'update', data: { id: 'iss-1' }, updatedFrom: { stateId: 'x' } });
  assert.deepEqual(await lines.next('webhook.misrouted'), {
    level: 'debug',
    event: 'webhook.misrouted',
    endpoint: 'face',
    type: 'Issue',
    action: 'update',
  });
  assert.deepEqual([events, lines.said('warn')], [[], []]);
});
