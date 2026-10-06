/**
 * The ticket desk (`aivi_ticket_*`) at its own seam: the tools are built
 * against a stub platform and a stub orchestrator, because what this file
 * tests is the desk's contract — which ids exist, whose ticket a call may
 * touch, and where a created ticket is born. The Linear wire shapes are the
 * client's own tests; the permission gate is OpenCode's and proven live.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LoadedConfig } from '@aivi/core';
import { type AiviServices, ToolError } from '@aivi/host';
import { TICKET_TOOL_ACTIONS } from '@aivi/plugin';
import type { RunView } from '@aivi/plugin/run';
import type { Platform, TrackerIssue } from '@aivi/plugin/tracker';
import { linearSchema } from '../src/config.ts';
import { createTicketTools } from '../src/tools.ts';

const issue = (over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: 't-1',
  identifier: 'AIV-1',
  title: 'Ship it',
  description: 'Body',
  branchName: 'aiv-1',
  url: 'https://linear.app/x/issue/t-1',
  state: { id: 's1', name: 'Triage', type: 'triage' },
  teamId: 'team-1',
  labels: [{ id: 'l1', name: 'needs-human' }],
  delegateId: null,
  assignee: null,
  archived: false,
  completed: false,
  blockedBy: [],
  ...over,
});

class FakePlatform {
  issues = new Map<string, TrackerIssue>([['t-1', issue()]]);
  comments: Record<string, { author: string | null; body: string; at: string }[]> = {};
  applied: { issueId: string; label: string; on: boolean }[] = [];
  created: { teamId: string; title: string; description?: string; lane?: string }[] = [];
  edited: { issueId: string; changes: { title?: string; description?: string } }[] = [];
  teamStates: Record<string, string[]> = { 'team-1': ['Triage', 'Backlog', 'Todo'] };

  async issue(_conversation: string, issueId: string): Promise<TrackerIssue> {
    const found = this.issues.get(issueId);
    if (!found) throw new Error(`no issue ${issueId}`);
    return found;
  }
  async laneStates(_conversation: string, teamId: string) {
    return (this.teamStates[teamId] ?? []).map(name => ({ id: `s-${name}`, name, type: 'unstarted' }));
  }
  async ticketComments(_conversation: string, issueId: string) {
    return this.comments[issueId] ?? [];
  }
  async addComment(_conversation: string, issueId: string, text: string): Promise<void> {
    const trail = this.comments[issueId] ?? [];
    trail.push({ author: 'aivi', body: text, at: '2026-10-06' });
    this.comments[issueId] = trail;
  }
  async editIssue(_conversation: string, issueId: string, changes: { title?: string; description?: string }) {
    this.edited.push({ issueId, changes });
    const found = this.issues.get(issueId)!;
    if (changes.title !== undefined) found.title = changes.title;
    if (changes.description !== undefined) found.description = changes.description;
    return found;
  }
  async createIssue(
    _conversation: string,
    input: { teamId: string; title: string; description?: string; lane?: string },
  ) {
    this.created.push(input);
    return issue({
      id: 't-new',
      identifier: 'AIV-9',
      title: input.title,
      state: { id: 's', name: input.lane ?? 'Triage', type: 'triage' },
    });
  }
  async teamLabels(_conversation: string, teamId: string) {
    return teamId === 'team-1' ? ['needs-human', 'ready'] : [];
  }
  async apply(
    _conversation: string,
    issueId: string,
    update: { kind: string; label?: string; on?: boolean },
  ): Promise<void> {
    if (update.kind === 'label') this.applied.push({ issueId, label: update.label!, on: update.on! });
  }
}

const harness = (written: { project?: Record<string, unknown>; defaults?: Record<string, unknown> } = {}) => {
  const platform = new FakePlatform();
  const runs = new Map<string, RunView>();
  const wakes: string[] = [];
  const claims: string[] = [];
  const loaded = {
    config: {
      projects: { p: { ...(written.project ? { 'tracker-linear': written.project } : {}) } },
      projectDefaults: { ...(written.defaults ? { 'tracker-linear': written.defaults } : {}) },
    },
    projects: [{ id: 'p', directory: '/checkout', lanes: [{ name: 'Triage' }, { name: 'Backlog' }, { name: 'Todo' }] }],
  } as unknown as LoadedConfig;
  const services = {
    loaded,
    orchestrator: {
      runBySession: (session: string) => runs.get(session),
      wake: async (projectId?: string) => {
        if (projectId) wakes.push(projectId);
      },
    },
    tools: {
      claim: (d: { namespace: string; name: string }) => void claims.push(`${d.namespace}_${d.name}`),
      release: () => {},
    },
    log: { debug: () => {}, getChild: () => ({ debug: () => {} }) },
  } as unknown as AiviServices;
  const tools = createTicketTools(services, linearSchema.parse({ apps: { dev: {} } }), platform as unknown as Platform);
  const byId = new Map(tools.map(t => [`${t.descriptor.namespace}_${t.descriptor.name}`, t]));
  return {
    platform,
    wakes,
    claims,
    tools,
    startRun: (over: Partial<RunView> = {}) => {
      runs.set('ses_w', {
        id: 'run_1',
        projectId: 'p',
        trackerId: 'tracker-linear',
        ticketId: 't-1',
        lane: 'Triage',
        agent: 'product',
        state: 'working',
        updatedAt: 0,
        ...over,
      } as RunView);
    },
    call: (id: string, input: Record<string, unknown> = {}, session = 'ses_w') =>
      byId.get(id)!.handler({ sessionId: session, input }),
  };
};

test('the desk claims exactly the ids the kit names — no more, no less', () => {
  const owned = harness();
  assert.deepEqual(
    owned.tools.map(t => `${t.descriptor.namespace}_${t.descriptor.name}`).sort(),
    [...TICKET_TOOL_ACTIONS].sort(),
    'the desk is TICKET_TOOL_ACTIONS, what the installer’s wildcard must cover and the agent file allows',
  );
});

test('the desk answers the run that owns the ticket, and nobody else’s session', async () => {
  const owned = harness();
  await assert.rejects(
    () => owned.call('aivi_ticket_read', {}, 'ses_stranger'),
    (e: unknown) => e instanceof ToolError && e.status === 404 && /not an aivi run/.test(e.message),
    'a session outside the ledger gets the plain reason, never a ticket',
  );
  owned.startRun({ trackerId: 'other-tracker' });
  await assert.rejects(() => owned.call('aivi_ticket_read'), /not worked on Linear/);
  owned.startRun({ state: 'completed' });
  await assert.rejects(() => owned.call('aivi_ticket_read'), /run has ended/);
});

test('read answers the ticket as the run sees it; comment writes land on the ticket', async () => {
  const owned = harness();
  owned.startRun();
  assert.deepEqual(await owned.call('aivi_ticket_read'), {
    identifier: 'AIV-1',
    title: 'Ship it',
    description: 'Body',
    lane: 'Triage',
    labels: ['needs-human'],
    url: 'https://linear.app/x/issue/t-1',
  });
  assert.deepEqual(await owned.call('aivi_ticket_comment', { text: 'a note for people' }), { posted: true });
  assert.equal(
    owned.platform.comments['t-1']![0]!.body,
    'a note for people',
    'the note is on the ticket, not the session',
  );
});

test('edit touches only what it names, and never an empty hand', async () => {
  const owned = harness();
  owned.startRun();
  await assert.rejects(() => owned.call('aivi_ticket_edit', {}), /Give a title, a description, or both/);
  assert.deepEqual(await owned.call('aivi_ticket_edit', { title: 'Sharper' }), {
    identifier: 'AIV-1',
    title: 'Sharper',
    url: 'https://linear.app/x/issue/t-1',
  });
  assert.deepEqual(
    owned.platform.edited[0]!.changes,
    { title: 'Sharper' },
    'the description was never mentioned, never touched',
  );
});

test('labels: the catalogue answers, add and remove are one operation each', async () => {
  const owned = harness();
  owned.startRun();
  assert.deepEqual(await owned.call('aivi_ticket_labels'), { team: ['needs-human', 'ready'], on: ['needs-human'] });
  await owned.call('aivi_ticket_add_label', { label: 'ready' });
  await owned.call('aivi_ticket_remove_label', { label: 'needs-human' });
  assert.deepEqual(owned.platform.applied, [
    { issueId: 't-1', label: 'ready', on: true },
    { issueId: 't-1', label: 'needs-human', on: false },
  ]);
});

test('create lands where the config says: project lane, then defaults, then the first lane', async () => {
  const own = harness({ project: { teams: ['team-1'], createLane: 'Backlog' } });
  own.startRun();
  assert.deepEqual(
    await own.call('aivi_ticket_create', { title: 'A separate thing', description: 'Found while sharpening AIV-1.' }),
    {
      identifier: 'AIV-9',
      url: 'https://linear.app/x/issue/t-1',
      lane: 'Backlog',
    },
  );
  assert.equal(own.platform.created[0]!.lane, 'Backlog', 'the project’s own createLane wins');
  assert.deepEqual(own.wakes, ['p'], 'the escape hatch wakes the walk itself, webhook or no webhook');

  const inherited = harness({ project: { teams: ['team-1'] }, defaults: { createLane: 'Todo' } });
  inherited.startRun();
  await inherited.call('aivi_ticket_create', { title: 'x', description: 'y' });
  assert.equal(inherited.platform.created[0]!.lane, 'Todo', 'projectDefaults is the next word');

  const plain = harness({ project: { teams: ['team-1'] } });
  plain.startRun();
  await plain.call('aivi_ticket_create', { title: 'x', description: 'y' });
  assert.equal(plain.platform.created[0]!.lane, 'Triage', 'no config: the project’s first configured lane');

  const gone = harness({ project: { teams: ['team-1'], createLane: 'Gone' } });
  gone.startRun();
  await assert.rejects(() => gone.call('aivi_ticket_create', { title: 'x', description: 'y' }), /names no state/);
  assert.equal(gone.platform.created.length, 0, 'a wrong createLane is said, never guessed past');
});

test('a desk that cannot speak for this project says so before Linear is called', async () => {
  const owned = harness();
  owned.startRun({ projectId: 'nowhere' });
  await assert.rejects(
    () => owned.call('aivi_ticket_create', { title: 'x', description: 'y' }),
    /no Linear teams|no project/,
  );
});
