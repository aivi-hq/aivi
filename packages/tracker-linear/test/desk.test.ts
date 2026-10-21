/**
 * Linear's answer to the ticket desk, at its own seam: the desk is built
 * against a stub platform, because what this file tests is what each desk
 * call *is* on Linear — which app it speaks through, where a created ticket
 * is born, which words a label operation becomes. The tool ids, the argument
 * checks and the guard of who may call are the host's desk and live in
 * `packages/host/test/ticket-desk.test.ts`; the Linear wire shapes are the
 * client's own tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LoadedConfig } from '@aivi/core';
import { ToolError } from '@aivi/host';
import type { RunView } from '@aivi/plugin/run';
import type { Platform, TrackerIssue } from '@aivi/plugin/tracker';
import { linearSchema } from '../src/config.ts';
import { createLinearDesk } from '../src/desk.ts';

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

const run = (over: Partial<RunView> = {}): RunView =>
  ({
    id: 'run_1',
    projectId: 'p',
    trackerId: 'tracker-linear',
    ticketId: 't-1',
    lane: 'Triage',
    agent: 'product',
    state: 'working',
    updatedAt: 0,
    ...over,
  }) as RunView;

const harness = (written: { project?: Record<string, unknown>; defaults?: Record<string, unknown> } = {}) => {
  const platform = new FakePlatform();
  const loaded = {
    config: {
      projects: { p: { ...(written.project ? { 'tracker-linear': written.project } : {}) } },
      projectDefaults: { ...(written.defaults ? { 'tracker-linear': written.defaults } : {}) },
    },
    projects: [{ id: 'p', directory: '/checkout', lanes: [{ name: 'Triage' }, { name: 'Backlog' }, { name: 'Todo' }] }],
  } as unknown as LoadedConfig;
  return {
    platform,
    desk: createLinearDesk(loaded, linearSchema.parse({ apps: { dev: {} } }), platform as unknown as Platform),
  };
};

test('read answers the ticket as the run sees it; comment writes land on the ticket', async () => {
  const { platform, desk } = harness();
  assert.deepEqual(await desk.read(run()), {
    identifier: 'AIV-1',
    title: 'Ship it',
    description: 'Body',
    lane: 'Triage',
    labels: ['needs-human'],
    url: 'https://linear.app/x/issue/t-1',
  });
  assert.deepEqual(await desk.comment(run(), 'a note for people'), undefined);
  assert.equal(platform.comments['t-1']![0]!.body, 'a note for people', 'the note is on the ticket, not the session');
});

test('edit touches only what it names, and answers what stands now', async () => {
  const { platform, desk } = harness();
  assert.deepEqual(await desk.edit(run(), { title: 'Sharper' }), {
    identifier: 'AIV-1',
    title: 'Sharper',
    url: 'https://linear.app/x/issue/t-1',
  });
  assert.deepEqual(
    platform.edited[0]!.changes,
    { title: 'Sharper' },
    'the description was never mentioned, never touched',
  );
});

test('labels: the catalogue answers, add and remove are one apply each', async () => {
  const { platform, desk } = harness();
  assert.deepEqual(await desk.labels(run()), { team: ['needs-human', 'ready'], on: ['needs-human'] });
  await desk.label(run(), 'ready', true);
  await desk.label(run(), 'needs-human', false);
  assert.deepEqual(platform.applied, [
    { issueId: 't-1', label: 'ready', on: true },
    { issueId: 't-1', label: 'needs-human', on: false },
  ]);
});

test('create lands where the config says: project lane, then defaults, then the first lane', async () => {
  const own = harness({ project: { teams: ['team-1'], createLane: 'Backlog' } });
  assert.deepEqual(
    await own.desk.create(run(), { title: 'A separate thing', description: 'Found while sharpening AIV-1.' }),
    {
      identifier: 'AIV-9',
      url: 'https://linear.app/x/issue/t-1',
      lane: 'Backlog',
    },
  );
  assert.equal(own.platform.created[0]!.lane, 'Backlog', 'the project’s own createLane wins');

  const inherited = harness({ project: { teams: ['team-1'] }, defaults: { createLane: 'Todo' } });
  await inherited.desk.create(run(), { title: 'x', description: 'y' });
  assert.equal(inherited.platform.created[0]!.lane, 'Todo', 'projectDefaults is the next word');

  const plain = harness({ project: { teams: ['team-1'] } });
  await plain.desk.create(run(), { title: 'x', description: 'y' });
  assert.equal(plain.platform.created[0]!.lane, 'Triage', 'no config: the project’s first configured lane');

  const gone = harness({ project: { teams: ['team-1'], createLane: 'Gone' } });
  await assert.rejects(() => gone.desk.create(run(), { title: 'x', description: 'y' }), /names no state/);
  assert.equal(gone.platform.created.length, 0, 'a wrong createLane is said, never guessed past');
});

test('a desk that cannot speak for this project says so before Linear is called', async () => {
  const { desk } = harness();
  await assert.rejects(
    () => desk.create(run({ projectId: 'nowhere' }), { title: 'x', description: 'y' }),
    /no Linear teams/,
  );
});

test('no primary app means no desk, said as a configuration refusal', () => {
  const loaded = { config: { projects: {} }, projects: [] } as unknown as LoadedConfig;
  const config = linearSchema.parse({ apps: {} }); // no app to speak through
  assert.throws(
    () => createLinearDesk(loaded, config, new FakePlatform() as unknown as Platform),
    (e: unknown) => e instanceof ToolError && e.status === 409 && /no primary Linear app/.test(e.message),
  );
});
