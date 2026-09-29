import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getLogger } from '@aivi/core';
import { PublicRoutes } from '@aivi/host';
import type { TrackerEvent } from '@aivi/plugin/tracker';
import { type AgentActivityInput, LinearClient, type LinearIssue } from '../src/client.ts';
import { linearSchema } from '../src/config.ts';
import { appWebhookPath } from '../src/routes.ts';
import { createLinearTracker } from '../src/tracker.ts';
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
  const tracker = await createLinearTracker(
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
    updatedFrom: { title: 'old', stateId: 'todo', delegateId: null },
  });
  assert.deepEqual(seen.at(-1), {
    kind: 'updated',
    conversation: 'dev',
    issueId: 'eng-1',
    changed: ['state', 'delegate'],
  });
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

test('the neutral issue is translated at the border: archived, delegate, and blockers in the platform own words', async t => {
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
    blockedByStates: ['started'],
  });
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
