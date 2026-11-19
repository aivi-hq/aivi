/** The eligibility filter of the walk's board read (docs/linear.md): what
 *  Linear's words mean for eligibility — archived, needs-human and delegated
 *  tickets stay on the board (ruled 2026-10-02: a ticket with a delegate is
 *  not eligible), blocked ones wait with their flag on — and how the walk
 *  reads the rest of the board: which projects it speaks for, which lane
 *  holds what, how a ticket enters a lane and the ticket's words. */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema, getLogger } from '@aivi/core';
import { recorder } from '../../host/test/support.ts';
import type { LinearIssue, LinearTeam } from '../src/client.ts';
import { LinearClient } from '../src/client.ts';
import { linearSchema } from '../src/config.ts';
import { linearBoard } from '../src/work.ts';

class FakeBoard extends LinearClient {
  pages = new Map<string, LinearIssue[]>();
  issues = new Map<string, LinearIssue>();
  /** The (team, state) pairs the walk asked for, and the moves it made. */
  asked: string[] = [];
  transitions: [string, string][] = [];
  truncated = false;
  constructor() {
    super({ clientId: 'x', clientSecret: 'y' }, { baseUrl: 'http://127.0.0.1:1' });
  }
  override async listTeams(): Promise<LinearTeam[]> {
    return [
      {
        id: 't-1',
        key: 'ENG',
        name: 'Engineering',
        states: [
          { id: 'todo', name: 'Todo', type: 'unstarted' },
          { id: 'done', name: 'Done', type: 'completed' },
        ],
      },
      { id: 't-2', key: 'OPS', name: 'Operations', states: [{ id: 'ops-done', name: 'Done', type: 'completed' }] },
    ];
  }
  override async issuesIn(teamId: string, stateId: string): Promise<{ issues: LinearIssue[]; truncated: boolean }> {
    this.asked.push(`${teamId}/${stateId}`);
    return { issues: this.pages.get(`${teamId}/${stateId}`) ?? [], truncated: this.truncated };
  }
  override async issue(id: string): Promise<LinearIssue> {
    return this.issues.get(id)!;
  }
  override async transitionIssue(issueId: string, stateId: string): Promise<void> {
    this.transitions.push([issueId, stateId]);
  }
}

const linearIssue = (id: string, extra: Partial<LinearIssue> = {}): LinearIssue => ({
  id,
  identifier: id.toUpperCase(),
  title: 'Fix header',
  description: null,
  branchName: `me/${id}`,
  url: `https://linear.app/x/issue/${id.toUpperCase()}`,
  state: { id: 'todo', name: 'Todo', type: 'unstarted' },
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

const config = configSchema.parse({
  version: 1,
  plugins: { 'tracker-linear': { primary: 'dev', apps: { dev: {} } } },
  projects: {
    api: {
      'tracker-linear': { teams: ['t-1'] },
      lanes: [{ name: 'Todo', agent: 'developer' }, { name: 'Done' }],
    },
  },
});
const loaded: LoadedConfig = {
  config,
  path: '/home/config.json',
  projects: [{ id: 'api', directory: '/src', lanes: config.projects.api!.lanes! }],
  sources: [],
};

/** The config as the board reads it: projects, and the Linear teams each one maps. */
const mapping = (projects: { id: string; removed?: true; teams?: string[] }[]) =>
  ({
    projects: projects.map(({ id, removed }) => ({
      id,
      directory: `/projects/${id}`,
      ...(removed ? { removed } : {}),
    })),
    config: {
      projects: Object.fromEntries(projects.map(({ id, teams }) => [id, teams ? { 'tracker-linear': { teams } } : {}])),
      projectDefaults: {},
    },
  }) as unknown as LoadedConfig;

const linear = linearSchema.parse({ primary: 'dev', apps: { dev: {} } });

test('the walk read is eligibility: archived, needs-human and delegated tickets are left on the board', async () => {
  const client = new FakeBoard();
  client.pages.set('t-1/todo', [
    linearIssue('plain'),
    linearIssue('delegated', { delegate: { id: 'app-user-1' } }),
    linearIssue('archived', { archivedAt: '2026-10-01T12:00:00.000Z' }),
    linearIssue('owned', { labels: [{ id: 'l', name: 'needs-human' }] }),
    linearIssue('waiting', { blockedBy: [{ id: 'b', state: { id: 's', name: 'In Progress', type: 'started' } }] }),
  ]);
  const board = linearBoard(
    linearSchema.parse({ primary: 'dev', apps: { dev: {} } }),
    { loaded },
    getLogger(['aivi', 'linear', 'test']),
    () => client,
  );
  assert.deepEqual(
    await board.tickets('api', 'Todo'),
    [
      { id: 'plain', blocked: false },
      { id: 'waiting', blocked: true },
    ],
    'alive, unlabeled, un-delegated — a blocked ticket waits with its flag on',
  );
});

test('the walk speaks for the projects that map Linear teams — never a removed project, never one with no Linear section', () => {
  const board = linearBoard(
    linear,
    {
      loaded: mapping([{ id: 'api', teams: ['t-1'] }, { id: 'old', removed: true, teams: ['t-1'] }, { id: 'plain' }]),
    },
    getLogger(['aivi', 'linear', 'test']),
    () => new FakeBoard(),
  );
  assert.deepEqual(board.projects(), ['api']);
});

test('a lane answers only where the project’s teams carry it: a team the app cannot see and a team without the lane are passed over', async () => {
  const client = new FakeBoard();
  client.pages.set('t-1/todo', [linearIssue('plain')]);
  const opened = mock.fn(() => client);
  const board = linearBoard(
    linear,
    { loaded: mapping([{ id: 'api', teams: ['t-9', 't-2', 't-1'] }, { id: 'plain' }]) },
    getLogger(['aivi', 'linear', 'test']),
    opened,
  );
  assert.deepEqual(await board.tickets('plain', 'Todo'), [], 'a project that maps no team has no lane to read');
  assert.equal(opened.mock.callCount(), 0, 'and Linear is not even asked');
  assert.deepEqual(await board.tickets('api', 'Todo'), [{ id: 'plain', blocked: false }]);
  assert.deepEqual(client.asked, ['t-1/todo'], 't-9 is not visible to the app and t-2 has no Todo');
  assert.equal(opened.mock.callCount(), 1, 'one client serves the whole board');
});

test('a lane with more tickets than one page holds says so, and the walk still gets what was read', async () => {
  const client = new FakeBoard();
  client.pages.set('t-1/todo', [linearIssue('plain')]);
  client.truncated = true;
  const lines = recorder();
  const board = linearBoard(linear, { loaded }, lines.log, () => client);
  assert.deepEqual(await board.tickets('api', 'Todo'), [{ id: 'plain', blocked: false }]);
  assert.deepEqual(lines.said('warn'), [
    { level: 'warn', event: 'walk.board.truncated', project: 'api', lane: 'Todo', team: 'ENG' },
  ]);
});

test('the walk moves a ticket into the lane its team carries, once; a lane its team lacks is said with the project that asked', async () => {
  const client = new FakeBoard();
  client.issues.set('iss-1', linearIssue('iss-1'));
  client.issues.set('iss-2', linearIssue('iss-2', { team: { id: 't-9', key: 'SEC' } }));
  const board = linearBoard(linear, { loaded }, getLogger(['aivi', 'linear', 'test']), () => client);
  await board.moveTo('api', 'iss-1', 'Done');
  assert.deepEqual(client.transitions, [['iss-1', 'done']]);
  await board.moveTo('api', 'iss-1', 'Todo');
  assert.equal(
    client.transitions.length,
    1,
    'the ticket is there already: a move that landed before a crash says nothing',
  );
  await assert.rejects(
    board.moveTo('api', 'iss-1', 'Review'),
    /Linear team ENG has no state "Review": iss-1 cannot enter project api/,
  );
  await assert.rejects(
    board.moveTo('api', 'iss-2', 'Todo'),
    /Linear team SEC has no state "Todo": iss-2 cannot enter project api/,
    'a team the app cannot see has no states at all',
  );
  assert.equal(client.transitions.length, 1);
});

test('the ticket’s words for the stages: its identifier, team, lane and branch; a deleted ticket has none', async () => {
  const client = new FakeBoard();
  client.issues.set(
    'iss-1',
    linearIssue('iss-1', { description: 'please', state: { id: 'done', name: 'Done', type: 'completed' } }),
  );
  client.issues.set('iss-2', linearIssue('iss-2'));
  client.issues.set('iss-3', linearIssue('iss-3', { archivedAt: '2026-10-01T12:00:00.000Z' }));
  const board = linearBoard(linear, { loaded }, getLogger(['aivi', 'linear', 'test']), () => client);
  assert.deepEqual(await board.issue('iss-1'), {
    identifier: 'ISS-1',
    title: 'Fix header',
    description: 'please',
    teamId: 't-1',
    stateName: 'Done',
    branchName: 'me/iss-1',
  });
  assert.equal((await board.issue('iss-2'))?.description, null, 'no description stays none');
  assert.equal(await board.issue('iss-3'), undefined, 'a deleted ticket is not work, and the stage says so');
});

test('by default the board reads through the primary app’s own credentials, opened only when the board is first read', async t => {
  t.mock.property(process, 'env', {
    ...process.env,
    LINEAR_CLIENT_ID: 'cid',
    LINEAR_CLIENT_SECRET: 'sec',
    LINEAR_WEBHOOK_SECRET: 'whsec',
  });
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
    const { labels, blockedBy: _blockedBy, ...rest } = linearIssue('iss-1');
    return url.endsWith('/oauth/token')
      ? Response.json({ access_token: 'tok', expires_in: 86_399 })
      : Response.json({ data: { issue: { ...rest, labels: { nodes: labels }, inverseRelations: { nodes: [] } } } });
  });
  const board = linearBoard(linear, { loaded }, getLogger(['aivi', 'linear', 'test']));
  assert.deepEqual(sent, [], 'nothing is asked until the board is read');
  assert.equal((await board.issue('iss-1'))?.identifier, 'ISS-1');
  assert.deepEqual(sent, [
    `https://api.linear.app/oauth/token Basic ${Buffer.from('cid:sec').toString('base64')}`,
    'https://api.linear.app/graphql Bearer tok',
  ]);
});
