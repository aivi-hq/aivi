/**
 * What the GitHub platform decides, one unit at a time: how a delivery
 * becomes normalized events (or nothing), how a status comment is read and
 * rewritten, and which words reach which ticket. The GitHub client behind it
 * is a fake whose every call is a `mock.fn()`; the seal on a delivery is
 * signed with the helper GitHub's own would be. Nothing here reaches a
 * network. `test/tracker.test.ts` runs the same platform over a scripted
 * GitHub.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { webhookSignature } from '@aivi/github';
import type { PublicRequest } from '@aivi/plugin';
import type { TrackerEvent } from '@aivi/plugin/tracker';
import { recorder } from '../../host/test/support.ts';
import type { GithubClient, GithubIssue } from '../src/client.ts';
import {
  GITHUB_FEED,
  GITHUB_WEBHOOK_PATH,
  GithubPlatform,
  parseStatus,
  registerWebhookRoute,
  renderStatus,
} from '../src/tracker.ts';

const SECRET = 'seal';

const homeConfig = (projects: unknown[] = [{ id: 'site' }]) =>
  ({
    projects,
    config: {
      projects: { site: { 'tracker-github': { board: 1, repos: ['acme/shop'] } } },
      projectDefaults: {},
      plugins: {},
    },
  }) as unknown as LoadedConfig;

const githubIssue = (over: Partial<GithubIssue> = {}): GithubIssue => ({
  id: 'I_47',
  ref: 'acme/shop#47',
  repo: 'acme/shop',
  number: 47,
  title: 'Fix it',
  body: 'please',
  url: 'https://github.com/acme/shop/issues/47',
  state: 'open',
  stateReason: null,
  labels: [{ id: 'l1', name: 'bug' }],
  assignees: [],
  projectItems: [],
  blockedBy: [],
  ...over,
});

/** The client the platform is built over: every call answers what a quiet
 *  GitHub would, and a test turns one answer where it needs another. */
function fakeClient() {
  return {
    org: 'acme',
    delegateName: 'aivi-agent',
    boardFields: mock.fn(async (..._board: unknown[]) => ({ projectId: 'PVT_board_1' })),
    laneOptions: mock.fn(async (..._board: unknown[]) => [{ id: 'opt_todo', name: 'Todo' }]),
    setLane: mock.fn(async (..._moved: unknown[]) => {}),
    setAgent: mock.fn(async (..._delegated: unknown[]) => {}),
    addLabel: mock.fn(async (..._labelled: unknown[]) => {}),
    removeLabel: mock.fn(async (..._unlabelled: unknown[]) => {}),
    createComment: mock.fn(async (..._said: unknown[]) => ({ id: 77, url: 'u' })),
    getComment: mock.fn(async (..._read: unknown[]): Promise<string | undefined> => undefined),
    updateComment: mock.fn(async (..._edited: unknown[]) => {}),
    comments: mock.fn(async (..._listed: unknown[]) => [] as unknown[]),
    issue: mock.fn(async (..._read: unknown[]) => githubIssue()),
    updateIssue: mock.fn(async (..._edited: unknown[]) => githubIssue({ title: 'Fixed' })),
    createIssue: mock.fn(async (..._made: unknown[]) => githubIssue({ ref: 'acme/shop#48', number: 48 })),
    repoLabels: mock.fn(async (..._asked: unknown[]) => ['bug', 'needs-human']),
    nodeRef: mock.fn(async (..._asked: unknown[]): Promise<string | undefined> => 'acme/shop#47'),
    laneOf: mock.fn((..._asked: unknown[]): { name: string; optionId: string } | undefined => ({
      name: 'Todo',
      optionId: 'opt_todo',
    })),
    agentOn: mock.fn((..._asked: unknown[]): string | undefined => 'aivi-agent'),
  };
}

function platformOver(trust?: 'members' | 'everyone', loaded = homeConfig()) {
  const lines = recorder();
  const client = fakeClient();
  const platform = new GithubPlatform(loaded, client as unknown as GithubClient, SECRET, lines.log, trust);
  const events: TrackerEvent[] = [];
  const waiting: PromiseWithResolvers<void>[] = [];
  platform.events(async event => {
    events.push(event);
    waiting.shift()?.resolve();
  });
  /** The moment the next event reaches the sink: ask before the delivery, wait after it. */
  const arrival = () => {
    const next = Promise.withResolvers<void>();
    waiting.push(next);
    return next.promise;
  };
  return { platform, client, lines, events, arrival, loaded };
}

let deliveries = 0;
const delivery = (event: string, payload: unknown): PublicRequest => {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': `d-${++deliveries}`,
      'x-hub-signature-256': webhookSignature(SECRET, body),
    },
    body,
  };
};

/** One macrotask turn: the one place a path that can only end by saying
 *  nothing has no moment to wait for. */
const drained = () => new Promise(resolve => setImmediate(resolve));

const comment = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  action: 'created',
  comment: { id: 5, body: 'hello', user: { login: 'ann', type: 'User' }, author_association: 'MEMBER', ...over },
  issue: { number: 47 },
  repository: { full_name: 'acme/shop' },
  ...top,
});

const boardItem = (over: Record<string, unknown> = {}) => ({
  action: 'edited',
  changes: { field_name: 'Status' },
  projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: 'I_47' },
  ...over,
});

test('a status body reads into its head, its plan steps and its hidden state; a state that is not JSON leaves the status standing', () => {
  const body = renderStatus('**Working**', ['- [x] read', '- [ ] fix'], { kind: 'status', n: 1 });
  assert.deepEqual(parseStatus(body), {
    head: '**Working**',
    planLines: ['- [x] read', '- [ ] fix'],
    meta: { kind: 'status', n: 1 },
  });
  assert.deepEqual(parseStatus('Words a person left\nnot a plan'), {
    head: 'Words a person left',
    planLines: [],
    meta: { kind: 'status' },
  });
  assert.deepEqual(parseStatus('**Working**\n\n<!-- {"kind": nope} -->\n'), {
    head: '**Working**',
    planLines: [],
    meta: { kind: 'status' },
  });
});

test('the boards are warmed once each: a removed project and a project with no GitHub board are passed over', async () => {
  const { platform, client } = platformOver(
    undefined,
    homeConfig([{ id: 'old', removed: true }, { id: 'docs' }, { id: 'site' }]),
  );
  await platform.warm();
  assert.deepEqual(
    client.boardFields.mock.calls.map(call => call.arguments),
    [[1]],
  );
});

test('a conversation names its run or its ticket the way the platform spells them; a bare session is read as it stands', () => {
  const { platform } = platformOver();
  assert.deepEqual(platform.parts('acme/shop#47:c9'), { app: 'github', session: 'acme/shop#47:c9' });
  assert.deepEqual(platform.parts('github:acme/shop#47'), { app: 'github', session: 'acme/shop#47' });
  assert.equal(platform.ticketOf('acme/shop#47'), 'acme/shop#47');
});

test('the app’s own identity is the client’s: its org, and its name as the Agent field knows it', async () => {
  const { platform } = platformOver();
  assert.equal(await platform.orgOf(GITHUB_FEED), 'acme');
  assert.equal(platform.ownerOf(GITHUB_FEED), 'aivi-agent');
});

test('a ticket is made the app’s, or unmade, on the board its repository feeds; a repository in no project has none', async () => {
  const { platform, client } = platformOver();
  await platform.assign(GITHUB_FEED, 'acme/shop#47', 'aivi-agent');
  await platform.unassign(GITHUB_FEED, 'acme/shop#47');
  assert.deepEqual(
    client.setAgent.mock.calls.map(call => call.arguments),
    [
      ['acme/shop#47', 1, 'aivi-agent'],
      ['acme/shop#47', 1, null],
    ],
  );
  await assert.rejects(
    platform.assign(GITHUB_FEED, 'other/repo#1', 'aivi-agent'),
    /other\/repo#1 feeds no aivi project: other\/repo is in no project's repos/,
  );
  await assert.rejects(
    platform.apply(GITHUB_FEED, 'other/repo#1', { kind: 'move', lane: 'Todo' }),
    /feeds no aivi project/,
  );
});

test('an issue reads in neutral words: its lane and delegate off the board it feeds, its assignee as a person', async () => {
  const { platform, client } = platformOver();
  client.issue.mock.mockImplementationOnce(async () => githubIssue({ assignees: [{ id: 'u1', name: 'ann' }] }));
  assert.deepEqual(await platform.issue(GITHUB_FEED, 'acme/shop#47'), {
    id: 'acme/shop#47',
    identifier: 'acme/shop#47',
    title: 'Fix it',
    description: 'please',
    branchName: '',
    url: 'https://github.com/acme/shop/issues/47',
    state: { id: 'opt_todo', name: 'Todo', type: '' },
    teamId: 'acme/shop',
    labels: [{ id: 'l1', name: 'bug' }],
    delegateId: 'aivi-agent',
    assignee: { id: 'u1', name: 'ann' },
    archived: false,
    completed: false,
    blockedBy: [],
  });
});

test('a repository outside every project has no lane and no delegate, and routing is told so rather than given one', async () => {
  const { platform, client } = platformOver();
  client.issue.mock.mockImplementationOnce(async () =>
    githubIssue({ repo: 'other/repo', ref: 'other/repo#1', state: 'closed' }),
  );
  const issue = await platform.issue(GITHUB_FEED, 'other/repo#1');
  assert.deepEqual([issue.state, issue.delegateId, issue.completed], [{ id: '', name: '', type: '' }, null, true]);
  assert.equal(client.laneOf.mock.callCount() + client.agentOn.mock.callCount(), 0, 'no board, so no board is asked');
});

test('the line of a status comment shows its tool with or without a detail; a comment that is gone says so', async () => {
  const { platform, client } = platformOver();
  const conversation = 'github:acme/shop#47:c1234';
  client.getComment.mock.mockImplementation(async () => renderStatus('**Preparing**', [], { kind: 'status' }));
  await platform.progress(conversation, { text: 'reading', tool: { name: 'read' } });
  await platform.progress(conversation, { text: 'reading', tool: { name: 'read', detail: 'src/a.ts' } });
  assert.deepEqual(
    client.updateComment.mock.calls.map(call => String(call.arguments[2]).split('\n')[0]),
    ['**reading** · `read`', '**reading** · `read src/a.ts`'],
  );
  client.getComment.mock.mockImplementation(async () => undefined);
  await assert.rejects(platform.progress(conversation, { text: 'reading' }), {
    status: 404,
    message: 'the status comment of acme/shop#47 is gone (deleted, or never visible to the app)',
  });
  await assert.rejects(platform.plan(conversation, { steps: [] }), { status: 404 });
  await assert.rejects(platform.freezeStatus(conversation, '**Done**'), { status: 404 });
});

test('freezing a status comment that is frozen already says nothing', async () => {
  const { platform, client } = platformOver();
  client.getComment.mock.mockImplementation(async () => renderStatus('**Done**', [], { kind: 'done' }));
  await platform.freezeStatus('github:acme/shop#47:c1234', '**Done**');
  assert.equal(client.updateComment.mock.callCount(), 0);
});

test('a result is shown only by a bot’s closing that names this run: a person quoting one does not count', async () => {
  const { platform, client } = platformOver();
  const closing = renderStatus('All done.', [], { kind: 'closing', status: 1234, ok: true });
  client.comments.mock.mockImplementation(async () => [
    { id: 9, author: 'ann', authorIsBot: false, body: closing, at: 'x' },
  ]);
  assert.equal(await platform.resultShown('github:acme/shop#47:c1234'), false);
  client.comments.mock.mockImplementation(async () => [
    { id: 9, author: 'aivi', authorIsBot: true, body: closing, at: 'x' },
  ]);
  assert.equal(await platform.resultShown('github:acme/shop#47:c1234'), true);
});

test('the desk’s words go to the client as they are: comments, a comment, an edit, the repository’s labels', async () => {
  const { platform, client } = platformOver();
  assert.deepEqual(await platform.ticketComments(GITHUB_FEED, 'acme/shop#47'), []);
  await platform.addComment(GITHUB_FEED, 'acme/shop#47', 'a plain word');
  assert.deepEqual(client.createComment.mock.calls[0]!.arguments, ['acme/shop#47', 'a plain word']);
  const edited = await platform.editIssue(GITHUB_FEED, 'acme/shop#47', { title: 'Fixed' });
  assert.deepEqual(client.updateIssue.mock.calls[0]!.arguments, ['acme/shop#47', { title: 'Fixed' }]);
  assert.equal(edited.title, 'Fixed');
  assert.deepEqual(await platform.teamLabels(GITHUB_FEED, 'acme/shop'), ['bug', 'needs-human']);
  assert.deepEqual(client.repoLabels.mock.calls[0]!.arguments, ['acme/shop']);
});

test('a new ticket asked into a lane for a repository no project maps has nowhere to land', async () => {
  const { platform } = platformOver();
  await assert.rejects(
    platform.createIssue(GITHUB_FEED, { teamId: 'other/repo', title: 'New', lane: 'Todo' }),
    /other\/repo feeds no aivi project: Todo is nowhere to land it/,
  );
});

test('a comment from someone GitHub trusts reaches the module as a prompt; a comment with no body arrives without words', async () => {
  const { platform, events } = platformOver();
  await platform.deliver(delivery('issue_comment', comment()));
  await platform.deliver(delivery('issue_comment', comment({ id: 6, body: null })));
  assert.deepEqual(events, [
    { kind: 'prompted', id: 'comment:5', conversation: 'github:acme/shop#47', body: 'hello' },
    { kind: 'prompted', id: 'comment:6', conversation: 'github:acme/shop#47' },
  ]);
});

test('a comment that is not a person’s, not new, not about a ticket or not from a trusted author is heard as nothing', async () => {
  const { platform, events, lines } = platformOver();
  for (const payload of [
    comment({}, { action: 'edited' }),
    comment({ user: { login: 'aivi[bot]', type: 'Bot' } }),
    comment({}, { issue: {} }),
    comment({ author_association: 'CONTRIBUTOR' }),
    comment({ author_association: undefined }),
  ])
    await platform.deliver(delivery('issue_comment', payload));
  assert.deepEqual(events, []);
  assert.deepEqual(lines.said('warn').concat(lines.said('info'), lines.said('debug')), [], 'not even a log line');
});

test('an issue delivery says what routing keys on; an assignee, or no number, or an unknown action is nothing', async () => {
  const { platform, events } = platformOver();
  const issues = (action: string, number: unknown = { number: 47 }) => ({
    action,
    ...(number ? { issue: number } : {}),
    repository: { full_name: 'acme/shop' },
  });
  for (const action of ['labeled', 'closed', 'deleted', 'assigned'])
    await platform.deliver(delivery('issues', issues(action)));
  await platform.deliver(delivery('issues', issues('labeled', null)));
  assert.deepEqual(
    events.map(event => [event.kind === 'updated' ? event.issueId : '', event.kind === 'updated' ? event.changed : []]),
    [
      ['acme/shop#47', ['labels']],
      ['acme/shop#47', ['state']],
      ['acme/shop#47', ['archive']],
    ],
  );
});

test('a board item says what changed on it: new on the board, a Status edit, an Agent edit — however GitHub spelled the field', async () => {
  const { platform, events, arrival } = platformOver();
  await platform.warm();
  const delivered = async (payload: unknown) => {
    const arrived = arrival();
    await platform.deliver(delivery('projects_v2_item', payload));
    await arrived;
  };
  await delivered(boardItem({ action: 'created', changes: undefined }));
  await delivered(boardItem());
  await delivered(boardItem({ changes: { field_name: 'Agent' } }));
  await delivered(boardItem({ changes: { field_value: { field_name: 'Status', to: 'Done' } } }));
  assert.deepEqual(
    events.map(event => (event.kind === 'updated' ? [event.issueId, event.changed] : [])),
    [
      ['acme/shop#47', ['state']],
      ['acme/shop#47', ['state']],
      ['acme/shop#47', ['delegate']],
      ['acme/shop#47', ['state']],
    ],
  );
});

test('a board item that routing does not key on is nothing: a field aivi does not read, a move, a board it does not speak, a draft', async () => {
  const { platform, client, events } = platformOver();
  await platform.warm();
  const quiet = async (payload: unknown) => {
    await platform.deliver(delivery('projects_v2_item', payload));
    await drained();
  };
  await quiet(boardItem({ changes: { field_name: 'Priority' } }));
  await quiet(boardItem({ changes: undefined }));
  await quiet(boardItem({ action: 'reordered' }));
  await quiet(boardItem({ projects_v2_item: { project_node_id: 'PVT_elsewhere', content_node_id: 'I_47' } }));
  await quiet(boardItem({ projects_v2_item: null }));
  await quiet(boardItem({ projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: null } }));
  assert.equal(client.nodeRef.mock.callCount(), 0, 'no node was looked up for any of them');
  client.nodeRef.mock.mockImplementationOnce(async () => undefined);
  await quiet(boardItem());
  assert.equal(client.nodeRef.mock.callCount(), 1, 'a draft or a pull request has no ticket behind its node');
  assert.deepEqual(events, []);
});

test('a ping, an installation and everything else GitHub sends is nothing', async () => {
  const { platform, events } = platformOver();
  for (const event of ['ping', 'installation', 'repository'])
    await platform.deliver(delivery(event, { zen: 'Keep it logically awesome.' }));
  assert.deepEqual(events, []);
});

test('a body that is not JSON is refused after the seal, and a handler that fails is logged, never replayed', async () => {
  const { platform, lines } = platformOver();
  const body = Buffer.from('not json');
  assert.deepEqual(
    await platform.deliver({
      method: 'POST',
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': 'd-bad',
        'x-hub-signature-256': webhookSignature(SECRET, body),
      },
      body,
    }),
    { status: 400, body: { error: 'body is not JSON' } },
  );
  platform.events(async () => {
    throw new Error('the module broke');
  });
  assert.equal(
    (await platform.deliver(delivery('issue_comment', comment()))).status,
    200,
    'GitHub is told yes all the same',
  );
  await lines.next('webhook.failed');
  assert.deepEqual(
    lines.said('warn').map(line => line.event),
    ['webhook.failed'],
  );
});

test('the route is GitHub’s one path and answers a POST only', async () => {
  const { platform } = platformOver();
  const route = mock.fn((..._registered: unknown[]) => () => {});
  registerWebhookRoute({ register: route } as never, platform);
  const [path, handler] = route.mock.calls[0]!.arguments as [
    string,
    (request: PublicRequest) => Promise<{ status: number }>,
  ];
  assert.equal(path, GITHUB_WEBHOOK_PATH);
  assert.equal((await handler({ method: 'GET', headers: {}, body: Buffer.alloc(0) })).status, 405);
  assert.equal((await handler(delivery('ping', {}))).status, 200);
});
