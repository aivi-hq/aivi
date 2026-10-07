/** The desk as the worker's hand: what each `aivi_ticket_*` answer *is* on
 *  GitHub. The platform under it is a recorder — what the platform *does*
 *  is `tracker.test.ts`'s subject, not this file's. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type LoadedConfig, loadConfig } from '@aivi/core';
import type { RunView } from '@aivi/plugin/run';
import type { Platform, TrackerIssue } from '@aivi/plugin/tracker';
import { githubSchema } from '../src/config.ts';
import { createGithubDesk } from '../src/desk.ts';
import { GITHUB_FEED } from '../src/tracker.ts';

const config = githubSchema.parse({});

async function loaded(projects: Record<string, unknown>): Promise<LoadedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'aivi-github-desk-'));
  for (const id of Object.keys(projects)) await mkdir(join(root, `projects/${id}/source`), { recursive: true });
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({ version: 1, knowledge: [{ id: 'company', path: 'kb' }], projects }));
  const loaded = await loadConfig(path);
  return loaded;
}

const run = (ticketId: string, projectId = 'site'): RunView => ({ ticketId, projectId }) as RunView;

const issue = (over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: 'acme/shop#47',
  identifier: 'acme/shop#47',
  title: 'Fix it',
  description: 'please',
  branchName: '',
  url: 'https://github.com/acme/shop/issues/47',
  state: { id: 'opt_todo', name: 'Todo', type: '' },
  teamId: 'acme/shop',
  labels: [{ id: 'L1', name: 'bug' }],
  delegateId: 'aivi-agent',
  assignee: null,
  archived: false,
  completed: false,
  blockedBy: [],
  ...over,
});

function recorder(states: { name: string }[], standing: TrackerIssue = issue()) {
  const calls: string[] = [];
  const platform = {
    async issue() {
      calls.push('issue');
      return standing;
    },
    async ticketComments() {
      calls.push('ticketComments');
      return [{ author: 'person', body: 'hello', at: 'now' }];
    },
    async teamLabels() {
      calls.push('teamLabels');
      return ['bug', 'needs-human'];
    },
    async editIssue(_c: string, _i: string, changes: any) {
      calls.push(`editIssue:${changes.title ?? ''}`);
      return { ...standing, title: changes.title ?? standing.title };
    },
    async addComment() {
      calls.push('addComment');
    },
    async createIssue(_c: string, input: any) {
      calls.push(`createIssue:${input.teamId}:${input.lane ?? 'none'}`);
      return {
        ...standing,
        id: 'acme/shop#48',
        identifier: 'acme/shop#48',
        url: 'u48',
        state: { id: 'x', name: input.lane ?? '', type: '' },
      };
    },
    async apply(_c: string, _i: string, update: any) {
      calls.push(`apply:${update.kind}:${update.label ?? update.lane ?? ''}:${update.on ?? ''}`);
    },
    async laneStates() {
      calls.push('laneStates');
      return states.map((s, i) => ({ id: `opt${i}`, name: s.name, type: '' }));
    },
  } as unknown as Platform;
  return { platform, calls };
}

test('the desk reads the ticket as it stands, in neutral words', async t => {
  const l = await loaded({ site: { 'tracker-github': { board: 1, repos: ['acme/shop'] } } });
  const { platform, calls } = recorder([]);
  const desk = createGithubDesk(l, config, platform);
  assert.deepEqual(await desk.read(run('acme/shop#47')), {
    identifier: 'acme/shop#47',
    title: 'Fix it',
    description: 'please',
    lane: 'Todo',
    labels: ['bug'],
    url: 'https://github.com/acme/shop/issues/47',
  });
  assert.deepEqual(await desk.comments(run('acme/shop#47')), [{ author: 'person', body: 'hello', at: 'now' }]);
  assert.deepEqual(await desk.labels(run('acme/shop#47')), { team: ['bug', 'needs-human'], on: ['bug'] });
  assert.deepEqual(await desk.edit(run('acme/shop#47'), { title: 'Renamed' }), {
    identifier: 'acme/shop#47',
    title: 'Renamed',
    url: 'https://github.com/acme/shop/issues/47',
  });
  await desk.comment(run('acme/shop#47'), 'a plain word');
  await desk.label(run('acme/shop#47'), 'bug', false);
  assert.deepEqual(calls, [
    'issue',
    'ticketComments',
    'issue',
    'teamLabels',
    'editIssue:Renamed',
    'addComment',
    'apply:label:bug:false',
  ]);
});

test('a new ticket is born where the config says, never where the caller wishes', async t => {
  const l = await loaded({
    site: {
      lanes: [{ name: 'Triage', worktree: false }],
      'tracker-github': { board: 1, repos: ['acme/shop'], createLane: 'Triage' },
    },
  });
  const { platform, calls } = recorder([{ name: 'Triage' }, { name: 'Todo' }]);
  const desk = createGithubDesk(l, config, platform);
  const made = await desk.create(run('acme/shop#47'), { title: 'Spin-off', description: 'why' });
  assert.ok(calls.includes('createIssue:acme/shop:Triage'));
  assert.deepEqual(made, { identifier: 'acme/shop#48', url: 'u48', lane: 'Triage' });
});

test('the create lane falls back to the project’s first lane, then to the repository’s own default', async t => {
  const l = await loaded({
    site: {
      lanes: [{ name: 'Backlog', worktree: false }],
      'tracker-github': { board: 1, repos: ['acme/shop'] },
    },
  });
  const { platform, calls } = recorder([{ name: 'Backlog' }]);
  await createGithubDesk(l, config, platform).create(run('x'), { title: 't', description: 'd' });
  assert.ok(calls.includes('createIssue:acme/shop:Backlog'), 'the first configured lane names a state: it lands there');

  const l2 = await loaded({
    site: {
      lanes: [{ name: 'Icebox', worktree: false }],
      'tracker-github': { board: 1, repos: ['acme/shop'] },
    },
  });
  const r2 = recorder([{ name: 'Todo' }]);
  await createGithubDesk(l2, config, r2.platform).create(run('x'), { title: 't', description: 'd' });
  assert.ok(
    r2.calls.includes('createIssue:acme/shop:none'),
    'no board carries the fallback name: GitHub’s own default takes it',
  );
});

test('an explicit create lane the board does not carry is said, never guessed past', async t => {
  const l = await loaded({
    site: { 'tracker-github': { board: 1, repos: ['acme/shop'], createLane: 'Review' } },
  });
  const { platform } = recorder([{ name: 'Todo' }]);
  const desk = createGithubDesk(l, config, platform);
  await assert.rejects(
    desk.create(run('x'), { title: 't', description: 'd' }),
    /createLane "Review" names no Status option/,
  );
});

test('a project with no repositories has nowhere to create, and says so', async t => {
  const l = await loaded({ site: { enabled: true } });
  const { platform } = recorder([]);
  const desk = createGithubDesk(l, config, platform);
  await assert.rejects(desk.create(run('x', 'site'), { title: 't', description: 'd' }), /no GitHub repositories/);
});

test('every desk call speaks on the app’s own feed, never a session', async t => {
  const l = await loaded({ site: { 'tracker-github': { board: 1, repos: ['acme/shop'] } } });
  const seen: unknown[] = [];
  const { platform } = recorder([]);
  const wrapped = new Proxy(platform, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (
          typeof args[0] === 'string' &&
          ['issue', 'ticketComments', 'teamLabels', 'editIssue', 'addComment', 'apply'].includes(String(prop))
        )
          seen.push(args[0]);
        return (value as Function).apply(target, args);
      };
    },
  }) as unknown as Platform;
  const desk = createGithubDesk(l, config, wrapped);
  await desk.read(run('acme/shop#47'));
  await desk.comment(run('acme/shop#47'), 'word');
  assert.deepEqual([...new Set(seen)], [GITHUB_FEED]);
});
