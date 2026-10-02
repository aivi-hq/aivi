/** The eligibility filter of the walk's board read (docs/linear.md): what
 *  Linear's words mean for eligibility — archived, needs-human and delegated
 *  tickets stay on the board (ruled 2026-10-02: a ticket with a delegate is
 *  not eligible), blocked ones wait with their flag on. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema, getLogger } from '@aivi/core';
import type { LinearIssue, LinearTeam } from '../src/client.ts';
import { LinearClient } from '../src/client.ts';
import { linearSchema } from '../src/config.ts';
import { linearBoard } from '../src/work.ts';

class FakeBoard extends LinearClient {
  pages = new Map<string, LinearIssue[]>();
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
    ];
  }
  override async issuesIn(teamId: string, stateId: string): Promise<{ issues: LinearIssue[]; truncated: boolean }> {
    return { issues: this.pages.get(`${teamId}/${stateId}`) ?? [], truncated: false };
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
