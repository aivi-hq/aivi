import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLogger } from '@aivi/core';
import { PublicRoutes } from '@aivi/host';
import type { TrackerEvent } from '@aivi/plugin/tracker';
import { type AgentActivityInput, LinearClient, type LinearIssue } from '../src/client.ts';
import { linearSchema } from '../src/config.ts';
import { appWebhookPath } from '../src/routes.ts';
import { createLinearPlatform } from '../src/tracker.ts';
import { signWebhook } from '../src/webhook.ts';

/** Linear as the adapter sees it: records activities and delegate
 *  mutations, serves canned issues and teams. */
class FakeLinear extends LinearClient {
  activities: { agentSessionId: string; content: { type: string; body: string }; ephemeral?: boolean }[] = [];
  issues = new Map<string, LinearIssue>();
  delegated: [string, string | null][] = [];
  sessionsByIssue = new Map<string, { id: string; status: string }[]>();
  /** Issues whose delegate mutation makes no session: Linear's own silence,
   *  which the adapter must report as null rather than invent. */
  noSessionFor = new Set<string>();
  private sessionsCreated = 1;

  constructor() {
    super({ clientId: 'x', clientSecret: 'y' }, { baseUrl: 'http://127.0.0.1:1' });
  }
  override async viewer() {
    return { id: 'app-user-1', organizationId: 'org-1' };
  }
  override async createActivity(input: AgentActivityInput) {
    this.activities.push({
      agentSessionId: input.agentSessionId,
      content: input.content as { type: string; body: string },
      ...(input.ephemeral ? { ephemeral: true } : {}),
    });
    return `act-${this.activities.length}`;
  }
  override async issue(id: string) {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  }
  override async listTeams() {
    return [
      {
        id: 't-1',
        key: 'ENG',
        name: 'Engineering',
        states: [
          { id: 's1', name: 'Todo', type: 'unstarted' },
          { id: 's2', name: 'Done', type: 'completed' },
        ],
      },
    ];
  }
  override async setDelegate(issueId: string, delegateId: string | null) {
    this.delegated.push([issueId, delegateId]);
    const before = this.sessionsByIssue.get(issueId) ?? [];
    if (delegateId && !this.noSessionFor.has(issueId)) {
      const made = `as-auto-${this.sessionsCreated++}`;
      this.sessionsByIssue.set(issueId, [...before, { id: made, status: 'pending' }]);
    }
    return {
      success: true,
      issue: {
        identifier: issueId.toUpperCase(),
        agentSessions: {
          nodes: (this.sessionsByIssue.get(issueId) ?? []).map(s => ({
            id: s.id,
            status: s.status,
            startedAt: null,
            url: null,
          })),
        },
      },
    };
  }
  /** Closing-note surface: the standing comments per issue and the session
   *  urls, with every posted note recorded. */
  commentsByIssue = new Map<string, string[]>();
  sessionUrls = new Map<string, string>();
  posted: { issueId: string; body: string }[] = [];
  override async closingNoteFacts(issueId: string) {
    return {
      comments: (this.commentsByIssue.get(issueId) ?? []).map(body => ({ body })),
      sessions: [...(this.sessionsByIssue.get(issueId) ?? [])].map(s => ({
        id: s.id,
        url: this.sessionUrls.get(s.id) ?? null,
      })),
    };
  }
  override async createComment(issueId: string, body: string): Promise<void> {
    this.posted.push({ issueId, body });
    this.commentsByIssue.set(issueId, [...(this.commentsByIssue.get(issueId) ?? []), body]);
  }
  labelCalls: { issueId: string; labelId: string; on: boolean }[] = [];
  /** The team's label catalogue: only needs-human stands, anything else
   *  exercises the create-on-miss path. */
  labelIds = new Map<string, string>([['needs-human', 'lbl-needs-human']]);
  override async labelIdForTeam(_teamId: string, name: string): Promise<string> {
    const existing = this.labelIds.get(name);
    if (existing) return existing;
    const made = `lbl-${name}`;
    this.labelIds.set(name, made);
    return made;
  }
  override async addLabel(issueId: string, labelId: string): Promise<void> {
    this.labelCalls.push({ issueId, labelId, on: true });
  }
  override async removeLabel(issueId: string, labelId: string): Promise<void> {
    this.labelCalls.push({ issueId, labelId, on: false });
  }
}

const linearIssue = (id: string, extra: Partial<LinearIssue> = {}): LinearIssue => ({
  id,
  identifier: id.toUpperCase(),
  title: 'Fix header',
  description: null,
  branchName: `me/${id}`,
  url: `https://linear.app/x/issue/${id.toUpperCase()}`,
  state: { id: 's', name: 'In Progress', type: 'started' },
  team: { id: 't-1', key: 'ENG' },
  labels: [],
  delegate: null,
  assignee: null,
  archivedAt: null,
  blockedBy: [],
  priority: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

/** A tracker wired to the fake Linear: what it registers, and the events it speaks. */
async function wired(t: { after(fn: () => Promise<void>): void }, apps = ['dev', 'face']) {
  // The adapter takes credentials from the environment, as it does in life;
  // the clients are the injected fakes, so nothing here reaches the network.
  // The primary carries the bare LINEAR_* names; a face its own prefix.
  process.env.LINEAR_CLIENT_ID = 'cid';
  process.env.LINEAR_CLIENT_SECRET = 'sec';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec-dev';
  process.env.LINEAR_FACE_CLIENT_ID = 'face-cid';
  process.env.LINEAR_FACE_CLIENT_SECRET = 'face-sec';
  process.env.LINEAR_FACE_WEBHOOK_SECRET = 'whsec-face';
  const routes = new PublicRoutes();
  const client = new FakeLinear();
  const tracker = await createLinearPlatform(
    linearSchema.parse({ primary: 'dev', apps: Object.fromEntries(apps.map(a => [a, {}])) }),
    routes,
    new Map(apps.map(a => [a, client])),
    getLogger(['aivi', 'linear', 'test']),
  );
  const seen: TrackerEvent[] = [];
  const unsubscribe = tracker.events(async event => {
    seen.push(event);
  });
  t.after(async () => unsubscribe());
  const deliver = async (app: string, payload: Record<string, unknown>, secret = `whsec-${app}`) => {
    const body = Buffer.from(JSON.stringify({ organizationId: 'org-1', webhookTimestamp: Date.now(), ...payload }));
    const answer = await routes.get(appWebhookPath(app))!({
      method: 'POST',
      headers: { 'linear-signature': signWebhook(body, secret), 'linear-delivery': 'd' },
      body,
    });
    await new Promise(r => setTimeout(r, 10)); // the dispatch settles after the acknowledgement
    return answer;
  };
  return { routes, client, tracker, seen, deliver };
}

test('a verified agent-session webhook becomes a neutral started event; bad signatures and stale stamps are refused', async t => {
  const { client, seen, deliver } = await wired(t);
  client.issues.set('eng-1', linearIssue('eng-1'));
  assert.deepEqual(
    await deliver('dev', {
      type: 'AgentSessionEvent',
      action: 'created',
      agentSession: { id: 'as-1', issue: { id: 'eng-1' } },
      promptContext: '<issue identifier="ENG-1"></issue>',
    }),
    { status: 200, body: { ok: true } },
    'Linear is acknowledged so it stops retrying',
  );
  assert.deepEqual(seen, [
    {
      kind: 'started',
      conversation: 'dev:as-1',
      issueId: 'eng-1',
      promptContext: '<issue identifier="ENG-1"></issue>',
    },
  ]);
  assert.equal(seen.length, 1, 'one delivery, one event');
});

test('a prompted webhook carries its message and signal; a data change narrows to the routing-relevant fields', async t => {
  const { client, seen, deliver } = await wired(t);
  client.issues.set('eng-1', linearIssue('eng-1'));
  await deliver('face', {
    type: 'AgentSessionEvent',
    action: 'prompted',
    agentSession: { id: 'as-9', issue: { id: 'eng-1' } },
    agentActivity: { id: 'act-9', content: { type: 'prompt', body: 'keep going' }, signal: null },
  });
  assert.deepEqual(seen.at(-1), {
    kind: 'prompted',
    id: 'act-9',
    conversation: 'face:as-9',
    body: 'keep going',
    signal: null,
  });
  await deliver('dev', {
    type: 'Issue',
    action: 'update',
    data: { id: 'eng-1', identifier: 'ENG-1' },
    updatedFrom: { title: 'old', stateId: 'todo', delegateId: null, archivedAt: null },
  });
  assert.deepEqual(
    seen.at(-1),
    {
      kind: 'updated',
      conversation: 'dev',
      issueId: 'eng-1',
      changed: ['state', 'delegate', 'archive'],
    },
    'archivedAt is a routing-relevant change: a deleted ticket stops what works it',
  );
});

test('a data change on a face route is a misroute: acknowledged, dropped; an unknown route is refused', async t => {
  const { seen, deliver } = await wired(t);
  const answer = await deliver('face', {
    type: 'Issue',
    action: 'update',
    data: { id: 'eng-1' },
    updatedFrom: { stateId: 'todo' },
  });
  assert.equal(answer.status, 200, 'a working endpoint is acknowledged so Linear does not retry');
  assert.deepEqual(seen, [], 'and dropped: a face carries no data feed');
});

test('a delivery that fails the signature or the timestamp is refused and speaks nothing', async t => {
  const { routes, seen } = await wired(t);
  const body = Buffer.from(
    JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org-1',
      webhookTimestamp: Date.now(),
      agentSession: { id: 'as-1', issue: { id: 'eng-1' } },
    }),
  );
  assert.equal(
    (
      await routes.get(appWebhookPath('dev'))!({
        method: 'POST',
        headers: { 'linear-signature': signWebhook(body, 'wrong'), 'linear-delivery': 'd' },
        body,
      })
    ).status,
    401,
  );
  const stale = Buffer.from(
    JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org-1',
      webhookTimestamp: Date.now() - 10 * 60_000,
      agentSession: { id: 'as-1', issue: { id: 'eng-1' } },
    }),
  );
  assert.equal(
    (
      await routes.get(appWebhookPath('dev'))!({
        method: 'POST',
        headers: { 'linear-signature': signWebhook(stale, 'whsec-dev'), 'linear-delivery': 'd' },
        body: stale,
      })
    ).status,
    401,
    'outside the replay window',
  );
  assert.deepEqual(seen, []);
});

test('the neutral kinds render as Linear agent-session activities: visible answers and outcomes, ephemeral progress', async t => {
  const { client, tracker } = await wired(t);
  await tracker.comment('dev:as-1', 'the answer', 'answer');
  await tracker.comment('dev:as-1', 'working', 'progress');
  await tracker.comment('dev:as-1', 'a durable line', 'note');
  await tracker.comment('dev:as-1', 'it ended badly', 'outcome');
  assert.deepEqual(
    client.activities.map(a => `${a.content.type}${a.ephemeral ? '~' : ''}`),
    ['response', 'thought~', 'thought', 'error'],
  );
  assert.deepEqual(
    [...new Set(client.activities.map(a => a.agentSessionId))],
    ['as-1'],
    'the session id is read out of the conversation',
  );
});

test('progress stream: a running tool is an ephemeral action, anything else an ephemeral thought', async t => {
  const { client, tracker } = await wired(t);
  await tracker.progress('dev:as-1', { text: '🔧 reading src/x.ts', tool: { name: 'read', detail: 'src/x.ts' } });
  await tracker.progress('dev:as-1', { text: '⏳ thinking…' });
  assert.deepEqual(
    client.activities.map(a => `${a.content.type}${a.ephemeral ? '~' : ''}`),
    ['action~', 'thought~'],
    'both progress kinds are ephemeral: the person sees the current moment, never a trail',
  );
  assert.deepEqual(client.activities[0]!.content, { type: 'action', action: 'read', parameter: 'src/x.ts' });
  assert.deepEqual(client.activities[1]!.content, { type: 'thought', body: '⏳ thinking…' });
});

test('notify is the plain ticket comment: the app feed speaks where no session exists yet', async t => {
  const { client, tracker } = await wired(t);
  await tracker.notify('dev', 'eng-9', 'I could not start work on this ticket: nothing landed.');
  assert.deepEqual(client.posted.at(-1), {
    issueId: 'eng-9',
    body: 'I could not start work on this ticket: nothing landed.',
  });
});

test('startSession is the delegate mutation: the pending session in its own answer, or null and unassigned', async t => {
  const { client, tracker } = await wired(t);
  const made = await tracker.startSession('dev', 'eng-7');
  assert.equal(made, 'as-auto-1', 'the session Linear created in the mutation answer');
  assert.deepEqual(client.delegated.at(-1), ['eng-7', 'app-user-1']);
  client.noSessionFor.add('eng-8');
  assert.equal(await tracker.startSession('dev', 'eng-8'), null, 'a mutation that made no session is not a session');
  await tracker.unassign('dev', 'eng-8');
  assert.deepEqual(client.delegated.at(-1), ['eng-8', null]);
});

test('the neutral issue is translated at the border: archived, delegate, and the closed-verdict on blockers', async t => {
  const { client, tracker } = await wired(t);
  client.issues.set(
    'eng-2',
    linearIssue('eng-2', {
      archivedAt: '2026-09-26T10:00:00.000Z',
      delegate: { id: 'app-user-1' },
      blockedBy: [{ id: 'eng-0', state: { id: 's', name: 'In Progress', type: 'started' } }],
    }),
  );
  assert.deepEqual(await tracker.issue('dev', 'eng-2'), {
    id: 'eng-2',
    identifier: 'ENG-2',
    title: 'Fix header',
    description: null,
    branchName: 'me/eng-2',
    url: 'https://linear.app/x/issue/ENG-2',
    state: { id: 's', name: 'In Progress', type: 'started' },
    teamId: 't-1',
    labels: [],
    delegateId: 'app-user-1',
    assignee: null,
    archived: true,
    completed: false,
    blockedBy: [{ id: 'eng-0', completed: false }],
  });
  // The closed-verdict is the adapter's: both of Linear's finished words —
  // Done and Won't Fix — say the blocker holds nothing back.
  client.issues.set(
    'eng-3',
    linearIssue('eng-3', {
      state: { id: 'd', name: 'Done', type: 'completed' },
      blockedBy: [{ id: 'eng-0', state: { id: 'w', name: "Won't Fix", type: 'canceled' } }],
    }),
  );
  const verdict = await tracker.issue('dev', 'eng-3');
  assert.equal(verdict.completed, true);
  assert.deepEqual(verdict.blockedBy, [{ id: 'eng-0', completed: true }]);
});

test('lane states come from the live board; identities come from the credentials', async t => {
  const { tracker } = await wired(t);
  assert.deepEqual(await tracker.laneStates('dev', 't-1'), [
    { id: 's1', name: 'Todo', type: 'unstarted' },
    { id: 's2', name: 'Done', type: 'completed' },
  ]);
  await assert.rejects(tracker.laneStates('dev', 't-9'), /not visible/);
  assert.equal(await tracker.orgOf('face:as-1'), 'org-1');
  assert.equal(tracker.ownerOf('face:as-1'), 'app-user-1');
  assert.equal(tracker.idFor('as-3'), 'dev:as-3', 'sessions the platform names live on the primary');
  assert.deepEqual(tracker.parts('face:as-3'), { app: 'face', session: 'as-3' });
  assert.deepEqual(tracker.parts('dev'), { app: 'dev', session: '' }, 'a bare app id is the app own feed');
  await assert.rejects(tracker.comment('dev', 'nowhere to speak', 'answer'), /names no agent session/);
});

test('the closing note stands on the ticket once: linked to its session, never posted twice', async t => {
  const { client, tracker } = await wired(t);
  client.sessionsByIssue.set('eng-1', [{ id: 'as-1', status: 'active' }]);
  client.sessionUrls.set('as-1', 'https://linear.app/x/agent-session/as-1');
  await tracker.closingNote!('dev:as-1', 'eng-1', 'Header aligned.');
  assert.deepEqual(client.posted, [
    {
      issueId: 'eng-1',
      body: 'Header aligned.\n\n— aivi · [agent session](https://linear.app/x/agent-session/as-1)',
    },
  ]);
  // A retry — the wake or the boot pass driving an owed ending again — sees
  // the session id standing on the ticket and says nothing twice.
  await tracker.closingNote!('dev:as-1', 'eng-1', 'Header aligned.');
  assert.equal(client.posted.length, 1, 'a note already standing is not posted twice');
  // A session the platform names no url for still gets its note, marked by id.
  client.sessionsByIssue.set('eng-2', [{ id: 'as-2', status: 'active' }]);
  await tracker.closingNote!('dev:as-2', 'eng-2', 'Stopped: a person takes over.');
  assert.equal(client.posted[1]!.body, 'Stopped: a person takes over.\n\n— aivi · agent session `as-2`');
  // Workers are invited to talk about their sessions. A
  // comment quoting the id in prose is the worker's text, not the note
  // standing — the closing still lands. Only the trailer closes a comment.
  const { client: quoting, tracker: quotingTracker } = await wired(t);
  quoting.sessionsByIssue.set('eng-3', [{ id: 'as-3', status: 'active' }]);
  quoting.sessionUrls.set('as-3', 'https://linear.app/x/agent-session/as-3');
  quoting.commentsByIssue.set('eng-3', ['I finished this in session ses_as-3, all tests green.']);
  await quotingTracker.closingNote!('dev:as-3', 'eng-3', 'Done.');
  assert.equal(quoting.posted.length, 1, 'a quoted id in prose does not silence the closing note');
  // The note's own trailer, standing on the ticket, does.
  await quotingTracker.closingNote!('dev:as-3', 'eng-3', 'Done.');
  assert.equal(quoting.posted.length, 1, 'and the standing trailer is honored on the retry');
});

test('the human label rides: apply adds the named label to the issue and lifts it back', async t => {
  // The branch the quality scan's dead-code report exposed as a throw: the
  // module has asked for this update on every stop and failed closing since
  // the stop-sticks ruling, and only the fake ever delivered it.
  const { client, tracker } = await wired(t);
  client.issues.set('eng-9', linearIssue('eng-9'));
  await tracker.apply('dev:as-9', 'eng-9', { kind: 'label', label: 'needs-human', on: true });
  assert.deepEqual(client.labelCalls, [{ issueId: 'eng-9', labelId: 'lbl-needs-human', on: true }]);
  await tracker.apply('dev:as-9', 'eng-9', { kind: 'label', label: 'needs-human', on: false });
  assert.deepEqual(client.labelCalls.at(-1), { issueId: 'eng-9', labelId: 'lbl-needs-human', on: false });
  // A name the catalogue does not carry is created on the team, then rides.
  await tracker.apply('dev:as-9', 'eng-9', { kind: 'label', label: 'blocked-on-person', on: true });
  assert.deepEqual(client.labelCalls.at(-1), { issueId: 'eng-9', labelId: 'lbl-blocked-on-person', on: true });
});
