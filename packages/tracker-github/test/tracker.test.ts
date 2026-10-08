/** The platform as the translator it is: conversations in, GitHub mutations
 *  out; deliveries in, normalized events out. The GitHub behind it answers
 *  exactly what each test scripts (`./github-api.ts`), and the seal is
 *  signed with the same helper GitHub would use. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '@aivi/core';
import { webhookSignature } from '@aivi/github';
import type { PublicRequest } from '@aivi/plugin';
import type { TrackerEvent } from '@aivi/plugin/tracker';
import { GithubClient } from '../src/client.ts';
import { GITHUB_FEED, GithubPlatform } from '../src/tracker.ts';
import {
  boardFieldsAnswer,
  commentJson,
  connectApp,
  connectRoutes,
  graphql,
  issueNode,
  type Seen,
  scripted,
} from './github-api.ts';

const SECRET = 'test-webhook-secret';

async function harness(routes: Record<string, (call: Seen) => any> = {}, trust?: 'members' | 'everyone') {
  const root = await mkdtemp(join(tmpdir(), 'aivi-github-platform-'));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      knowledge: [{ id: 'company', path: 'kb' }],
      projects: { site: { 'tracker-github': { board: 1, repos: ['acme/shop'] } } },
    }),
  );
  const loaded = await loadConfig(config);
  const script = scripted(connectRoutes(routes));
  const client = new GithubClient(await connectApp(script.fetch));
  const platform = new GithubPlatform(loaded, client, SECRET, undefined, trust);
  return { platform, script, root };
}

/** Deliveries dispatch after the acknowledgement — the test waits for the
 *  async tail the same way the log does. */
const settled = () => new Promise(resolve => setTimeout(resolve, 25));

function delivery(event: string, payload: unknown, deliveryId = 'dlv-1'): PublicRequest {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': webhookSignature(SECRET, body),
    },
    body,
  };
}

function collect(platform: GithubPlatform): { events: TrackerEvent[]; off: () => void } {
  const events: TrackerEvent[] = [];
  const off = platform.events(async e => void events.push(e));
  return { events, off };
}

test('the conversation words are the adapter’s own, and they parse back', () => {
  const p = new GithubPlatform({} as any, {} as any, SECRET);
  assert.deepEqual(p.parts(GITHUB_FEED), { app: 'github', session: '' });
  assert.equal(p.idFor('acme/shop#47:c123'), 'github:acme/shop#47:c123');
  assert.deepEqual(p.parts('github:acme/shop#47:c123'), { app: 'github', session: 'acme/shop#47:c123' });
  assert.deepEqual(p.runOf('github:acme/shop#47:c123'), { ref: 'acme/shop#47', commentId: 123 });
  assert.equal(p.ticketOf('github:acme/shop#47'), 'acme/shop#47');
  assert.equal(p.ticketOf('github:acme/shop#47:c123'), undefined, 'a run conversation is not a bare ticket');
  assert.throws(() => p.runOf('github:acme/shop#47'), /not a run conversation/);
});

test('startSession opens the run’s conversation: one status comment, state hidden under it (D6)', async t => {
  const { platform, script, root } = await harness({
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 1234, html_url: 'u' } }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await platform.startSession(GITHUB_FEED, 'acme/shop#47');
  assert.equal(session, 'acme/shop#47:c1234');
  const posted = script.bodies('/repos/acme/shop/issues/47/comments')[0]!;
  assert.match(posted.body, /\*\*Preparing the workspace…\*\*/);
  assert.match(posted.body, /<!-- \{"kind":"status"\} -->/, 'the machine state rides hidden (D7)');
});

test('progress edits the status comment in place and never posts a second one', async t => {
  const { platform, script, root } = await harness({
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Preparing the workspace…**\n\n<!-- {"kind":"status"} -->\n' },
    }),
    'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.progress('github:acme/shop#47:c1234', {
    text: '🔧 reading src/x.ts',
    tool: { name: 'read', detail: 'src/x.ts' },
  });
  const patch = script.bodies('/repos/acme/shop/issues/comments/1234')[0]!;
  assert.match(patch.body, /\*\*🔧 reading src\/x\.ts\*\* · `read src\/x\.ts`/);
  assert.match(patch.body, /<!-- \{"kind":"status"\} -->/);
  assert.ok(!script.calls().some(c => c.startsWith('POST /repos')), 'transient by contract: no lingering comment');
});

test('a frozen status comment is the closing’s last word: a trailing edit never speaks after it', async t => {
  const { platform, script, root } = await harness({
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Done**\n\n<!-- {"kind":"done"} -->\n' },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.progress('github:acme/shop#47:c1234', { text: '🔧 late' });
  assert.deepEqual(script.bodies('/repos/acme/shop/issues/comments/1234'), []);
});

test('comment words land where the conversation says: run edits, ticket posts', async t => {
  const { platform, script, root } = await harness({
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Working**\n<!-- {"kind":"status"} -->' },
    }),
    'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 77, html_url: 'u' } }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await platform.comment('github:acme/shop#47:c1234', 'working', 'progress'), undefined);
  assert.equal(await platform.comment('github:acme/shop#47:c1234', 'the answer', 'answer'), '77');
  assert.equal(await platform.comment('github:acme/shop#47', 'a placeholder', 'progress'), '77');
  await assert.rejects(platform.comment(GITHUB_FEED, 'nowhere to land', 'answer'), /not a conversation/);
});

test('a question is a numbered comment, the answer a person types needs no format', async t => {
  const { platform, script, root } = await harness({
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 5, html_url: 'u' } }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.ask('github:acme/shop#47:c1234', {
    question: 'Which branch?',
    options: [
      { label: 'main', value: 'main' },
      { label: 'the release branch', value: 'release/9' },
    ],
  });
  const posted = script.bodies('/repos/acme/shop/issues/47/comments')[0]!;
  assert.match(posted.body, /\*\*Question\*\* · Which branch\?/);
  assert.match(posted.body, /1\. main\n2\. the release branch — `release\/9`/);
  assert.match(posted.body, /<!-- \{"kind":"question"\} -->/);
});

test('the plan renders whole into the status comment, canceled steps and all', async t => {
  const { platform, script, root } = await harness({
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Working** · x\n\n<!-- {"kind":"status"} -->\n' },
    }),
    'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.plan('github:acme/shop#47:c1234', {
    steps: [
      { content: 'read', status: 'completed' },
      { content: 'fix', status: 'inProgress' },
      { content: 'drop', status: 'canceled' },
      { content: 'test', status: 'pending' },
    ],
  });
  const patch = script.bodies('/repos/acme/shop/issues/comments/1234')[0]!;
  assert.match(patch.body, /### Plan\n- \[x\] read\n- \[ \] fix\n- \[-\] drop\n- \[ \] test/);
  assert.match(patch.body, /\*\*Working\*\* · x/, 'the working line survives the plan edit');
});

test('the closing says itself once: the final comment names its status comment, and resultShown reads it back', async t => {
  const closingBody = (status: number) => ({
    id: 90,
    user: { login: 'aivi-agent[bot]', type: 'Bot' },
    body: `All done.\n\n<!-- {"kind":"closing","status":${status},"ok":true} -->`,
    created_at: 'x',
  });
  const { platform, script, root } = await harness({
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 90, html_url: 'u' } }),
    'GET /repos/acme/shop/issues/47/comments': () => ({
      status: 200,
      body: [commentJson(1234, 'aivi-agent[bot]', 'Bot', 'status'), closingBody(1234)],
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await platform.resultShown('github:acme/shop#47:c1234'), true);
  assert.equal(
    await platform.resultShown('github:acme/shop#47:c9999'),
    false,
    'another run’s result is not this run’s',
  );
  await platform.markClosing('github:acme/shop#47:c1234', 'All done.', true);
  const posted = script.bodies('/repos/acme/shop/issues/47/comments')[0]!;
  assert.match(posted.body, /<!-- \{"kind":"closing","status":1234,"ok":true\} -->/);
});

test('freeze replaces the working line and stamps the state done', async t => {
  const { platform, script, root } = await harness({
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Working** · x\n\n### Plan\n- [ ] t\n\n<!-- {"kind":"status"} -->\n' },
    }),
    'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.freezeStatus('github:acme/shop#47:c1234', '**Done**');
  const patch = script.bodies('/repos/acme/shop/issues/comments/1234')[0]!;
  assert.match(patch.body, /^\*\*Done\*\*\n/);
  assert.match(patch.body, /"kind":"done"/);
  assert.match(patch.body, /- \[ \] t/, 'the plan trail survives the freeze');
});

test('a delivery without its seal is refused, and the body is read only after', async t => {
  const { platform, root } = await harness();
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('{"action":"created"}');
  assert.equal((await platform.deliver({ method: 'POST', headers: {}, body })).status, 400, 'no event name');
  assert.equal(
    (await platform.deliver({ method: 'POST', headers: { 'x-github-event': 'ping' }, body })).status,
    400,
    'no delivery id',
  );
  assert.equal(
    (
      await platform.deliver({
        method: 'POST',
        headers: { 'x-github-event': 'ping', 'x-github-delivery': 'd' },
        body,
      })
    ).status,
    401,
    'no seal',
  );
  assert.equal(
    (
      await platform.deliver({
        method: 'POST',
        headers: { 'x-github-event': 'ping', 'x-github-delivery': 'd', 'x-hub-signature-256': 'sha256=deadbeef' },
        body,
      })
    ).status,
    401,
    'a wrong seal',
  );
  assert.equal(
    (await platform.deliver(delivery('ping', { zen: 'Hi' }))).status,
    200,
    'a true seal passes, and ping is noise that acknowledges',
  );
});

test('a redelivery by the same id is acknowledged as a duplicate and dispatches once', async t => {
  const { platform, root } = await harness();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { events, off } = collect(platform);
  const request = delivery('issues', {
    action: 'labeled',
    issue: { number: 47 },
    label: { name: 'bug' },
    repository: { full_name: 'acme/shop' },
  });
  assert.deepEqual(await platform.deliver(request), { status: 200, body: { ok: true } });
  assert.deepEqual(await platform.deliver(request), { status: 200, body: { ok: true, duplicate: true } });
  await settled();
  off();
  assert.deepEqual(events, [
    { kind: 'updated', conversation: GITHUB_FEED, issueId: 'acme/shop#47', changed: ['labels'] },
  ]);
});

test('an `issues` delivery takes its number from inside `issue` — GitHub answers no top-level one', async t => {
  // The live ledger caught the opposite assumption: a closed-issue delivery
  // reached the module as "aivi-hq/aivi#undefined" and failed. The number is
  // `issue.number`; a delivery that names none is silence, not a bad id.
  const { platform, root } = await harness();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { events, off } = collect(platform);
  await platform.deliver(
    delivery('issues', { action: 'closed', issue: { number: 50 }, repository: { full_name: 'aivi-hq/aivi' } }),
  );
  await platform.deliver(
    delivery('issues', { action: 'closed', number: 51, repository: { full_name: 'aivi-hq/aivi' } }),
  );
  await settled();
  off();
  assert.deepEqual(events, [
    { kind: 'updated', conversation: GITHUB_FEED, issueId: 'aivi-hq/aivi#50', changed: ['state'] },
  ]);
});

test('a person’s comment is a prompt; aivi’s own comment (a Bot) answers nothing', async t => {
  const { platform, root } = await harness();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { events, off } = collect(platform);
  const comment = (login: string, type: 'User' | 'Bot', association: string | undefined = 'MEMBER') =>
    delivery('issue_comment', {
      action: 'created',
      comment: {
        id: 7,
        body: 'please look',
        user: { login, type },
        ...(association === undefined ? {} : { author_association: association }),
      },
      issue: { number: 47 },
      repository: { full_name: 'acme/shop' },
    });
  await platform.deliver(comment('person', 'User'));
  await platform.deliver(comment('aivi-agent[bot]', 'Bot', 'NONE'));
  await settled();
  off();
  assert.deepEqual(events, [
    { kind: 'prompted', id: 'comment:7', conversation: 'github:acme/shop#47', body: 'please look' },
  ]);
});

test('the divider line: a CONTRIBUTOR or a stranger is heard as nothing — no event, no reply, no log line', async t => {
  const { platform, root } = await harness();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { events, off } = collect(platform);
  let n = 0;
  const comment = (association?: string) =>
    delivery(
      'issue_comment',
      {
        action: 'created',
        comment: {
          id: ++n,
          body: 'do my bidding',
          user: { login: 'outsider', type: 'User' },
          ...(association === undefined ? {} : { author_association: association }),
        },
        issue: { number: 47 },
        repository: { full_name: 'acme/shop' },
      },
      `dlv-drop-${n}`,
    );
  for (const association of ['CONTRIBUTOR', 'NONE', 'MANNEQUIN', undefined])
    await platform.deliver(comment(association));
  await settled();
  off();
  assert.deepEqual(events, [], 'dropped without a trace: silence does not advertise the bot');
});

test('the trusted side of the line: OWNER, MEMBER and COLLABORATOR all reach through', async t => {
  const { platform, root } = await harness();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { events, off } = collect(platform);
  let n = 0;
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    await platform.deliver(
      delivery(
        'issue_comment',
        {
          action: 'created',
          comment: { id: ++n, body: 'steer', user: { login: 'person', type: 'User' }, author_association: association },
          issue: { number: 47 },
          repository: { full_name: 'acme/shop' },
        },
        `dlv-trust-${n}`,
      ),
    );
  }
  await settled();
  off();
  assert.equal(events.length, 3, 'three trusted associations, three prompts');
});

test('trust "everyone" opens the door — the operator’s choice, not the default', async t => {
  const { platform, root } = await harness({}, 'everyone');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { events, off } = collect(platform);
  await platform.deliver(
    delivery('issue_comment', {
      action: 'created',
      comment: { id: 9, body: 'hello', user: { login: 'anyone', type: 'User' }, author_association: 'NONE' },
      issue: { number: 47 },
      repository: { full_name: 'acme/shop' },
    }),
  );
  await settled();
  off();
  assert.equal(events.length, 1, 'everyone means everyone');
});

test('the board speaks through warm, and only boards aivi speaks dispatch', async t => {
  const { platform, root } = await harness({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      NodeRef: () => ({ node: { number: 47, repository: { owner: { login: 'acme' }, name: 'shop' } } }),
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.warm();
  const { events, off } = collect(platform);
  const item = (projectNodeId: string, changes: unknown, id = 'dlv-x') =>
    platform.deliver(
      delivery(
        'projects_v2_item',
        {
          action: 'edited',
          changes,
          projects_v2_item: { project_node_id: projectNodeId, content_node_id: 'I_1' },
        },
        id,
      ),
    );
  await item('PVT_board_1', { field_name: 'Status', field_value: { from: 'Todo', to: 'In Progress' } });
  await item('PVT_other', { field_name: 'Status' }, 'dlv-y');
  await item(
    'PVT_board_1',
    {
      /* a column reorder: no field named */
    },
    'dlv-z',
  );
  await settled();
  off();
  assert.deepEqual(events, [
    { kind: 'updated', conversation: GITHUB_FEED, issueId: 'acme/shop#47', changed: ['state'] },
  ]);
});

test('the Agent field is the delegate, and everything else on the item is noise', async t => {
  const { platform, root } = await harness({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      NodeRef: () => ({ node: { number: 47, repository: { owner: { login: 'acme' }, name: 'shop' } } }),
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.warm();
  const { events, off } = collect(platform);
  await platform.deliver(
    delivery('projects_v2_item', {
      action: 'edited',
      changes: { field_name: 'Agent', field_value: { from: '', to: 'aivi-agent' } },
      projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: 'I_1' },
    }),
  );
  await platform.deliver(
    delivery(
      'projects_v2_item',
      { action: 'reordered', projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: 'I_1' } },
      'dlv-2',
    ),
  );
  await settled();
  off();
  assert.deepEqual(events, [
    { kind: 'updated', conversation: GITHUB_FEED, issueId: 'acme/shop#47', changed: ['delegate'] },
  ]);
});

test('a ticket reads neutral: lane, delegate, verdict — in the project’s own board words', async t => {
  const { platform, root } = await harness({
    'POST /graphql': graphql({
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: 'Todo', agent: 'aivi-agent', labels: ['bug'] }) } }),
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const issue = await platform.issue(GITHUB_FEED, 'acme/shop#47');
  assert.equal(issue.id, 'acme/shop#47');
  assert.equal(issue.identifier, 'acme/shop#47');
  assert.equal(issue.teamId, 'acme/shop');
  assert.deepEqual(issue.state, { id: 'opt_todo', name: 'Todo', type: '' });
  assert.equal(issue.delegateId, 'aivi-agent');
  assert.equal(issue.completed, false);
  assert.deepEqual(
    issue.labels.map(l => l.name),
    ['bug'],
  );
});

test('a closed ticket is finished as far as work goes, off the board has no lane', async t => {
  const { platform, root } = await harness({
    'POST /graphql': graphql({
      IssueFacts: () => ({
        repository: { issue: issueNode({ state: 'CLOSED', stateReason: 'COMPLETED', lane: null }) },
      }),
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const issue = await platform.issue(GITHUB_FEED, 'acme/shop#47');
  assert.equal(issue.completed, true);
  assert.deepEqual(issue.state, { id: '', name: '', type: '' });
  assert.equal(issue.archived, false, 'GitHub never deletes an issue; that is the gone path');
});

test('apply moves the lane, adds and removes a label, and comments plainly', async t => {
  const mutations: string[] = [];
  const { platform, script, root } = await harness({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: 'Todo' }) } }),
      SetSelect: (v: any) => {
        mutations.push(`set:${v.optionId}`);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
    'POST /repos/acme/shop/issues/47/labels': () => ({ status: 200, body: [] }),
    'GET /repos/acme/shop/labels/needs-human': () => ({ status: 404, body: { message: 'Not Found' } }),
    'POST /repos/acme/shop/labels': () => ({ status: 201, body: {} }),
    'DELETE /repos/acme/shop/issues/47/labels/needs-human': () => ({ status: 200, body: [] }),
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 3, html_url: 'u' } }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await platform.apply(GITHUB_FEED, 'acme/shop#47', { kind: 'move', lane: 'In Progress' });
  assert.deepEqual(mutations, ['set:opt_prog']);
  await platform.apply(GITHUB_FEED, 'acme/shop#47', { kind: 'label', label: 'needs-human', on: true });
  await platform.apply(GITHUB_FEED, 'acme/shop#47', { kind: 'label', label: 'needs-human', on: false });
  await platform.apply(GITHUB_FEED, 'acme/shop#47', { kind: 'comment', text: 'plain words' });
  assert.ok(script.calls().includes('POST /repos/acme/shop/issues/47/labels'));
  assert.ok(script.calls().includes('DELETE /repos/acme/shop/issues/47/labels/needs-human'));
  assert.deepEqual(script.bodies('/repos/acme/shop/issues/47/comments')[0], { body: 'plain words' });
});

test('the desk escape hatch: a new ticket lands in the named lane or says the lane does not exist', async t => {
  const mutations: string[] = [];
  const { platform, root } = await harness({
    'POST /repos/acme/shop/issues': () => ({ status: 201, body: { number: 48 } }),
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: v => ({ repository: { issue: issueNode({ number: v.number, lane: null }) } }),
      AddItem: () => ({ addProjectV2ItemById: { item: { id: 'PVTI_48' } } }),
      SetSelect: (v: any) => {
        mutations.push(`set:${v.optionId}`);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_48' } } };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const made = await platform.createIssue(GITHUB_FEED, {
    teamId: 'acme/shop',
    title: 'Spin-off',
    description: 'why',
    lane: 'Backlog',
  });
  assert.deepEqual(mutations, ['set:opt_backlog']);
  assert.equal(made.id, 'acme/shop#48');
  await assert.rejects(
    platform.createIssue(GITHUB_FEED, { teamId: 'acme/shop', title: 'x', lane: 'Review' }),
    /no Status option "Review"/,
  );
});

test('the states a lane mapping is validated against are the board’s own, in board order', async t => {
  const { platform, root } = await harness({
    'POST /graphql': graphql({ BoardFields: v => boardFieldsAnswer('aivi-hq', v) }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const states = await platform.laneStates(GITHUB_FEED, 'acme/shop');
  assert.deepEqual(
    states.map(s => s.name),
    ['Backlog', 'Todo', 'In Progress', 'Done'],
  );
  await assert.rejects(platform.laneStates(GITHUB_FEED, 'acme/other'), /feeds no aivi project/);
});

test('the delegate aivi names itself with: the app’s own name, not a per-board id', async () => {
  const { platform, root } = await harness();
  try {
    assert.equal(platform.ownerOf(GITHUB_FEED), 'aivi-agent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
