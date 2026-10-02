/** The wizard's lane list: what it asks, in what order, and what it never
 *  asks. The live test of 2026-10-01 caught the client sorting by `position`
 *  across type groups (Linear scopes position **within** a group), which
 *  shoved Done/Canceled/Duplicate before a late `started` lane; and the
 *  operator ruled the closed states are not lanes at all. `listTeams` sorts
 *  (client.test.ts), `openStates` filters — together they are the board. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectLaneInput } from '@aivi/core';
import type { LinearTeam } from '../src/client.ts';
import { markQueue, openStates, queueCandidates } from '../src/setup-project.ts';

const states: LinearTeam['states'] = [
  // A team's states as listTeams returns them: board order already.
  { id: 's-0', name: 'Backlog', type: 'backlog' },
  { id: 's-1', name: 'Todo', type: 'unstarted' },
  { id: 's-2', name: 'In Progress', type: 'started' },
  { id: 's-4', name: 'In Review', type: 'started' },
  { id: 's-3', name: 'Done', type: 'completed' },
  { id: 's-5', name: 'Canceled', type: 'canceled' },
  { id: 's-6', name: 'Duplicate', type: 'duplicate' },
];

test('openStates keeps the open lanes in board order and drops every closed state', () => {
  assert.deepEqual(
    openStates(states).map(s => s.name),
    ['Backlog', 'Todo', 'In Progress', 'In Review'],
  );
});

test('openStates dedupes a shared state name across teams, keeping the first', () => {
  const twice = [
    ...states,
    { id: 'x', name: 'In Progress', type: 'started' },
    { id: 'y', name: 'Triage', type: 'triage' },
  ];
  assert.deepEqual(
    openStates(twice).map(s => s.name),
    ['Backlog', 'Todo', 'In Progress', 'In Review', 'Triage'],
  );
});

test('the queue question is one question over the lanes that could legally wait work', () => {
  const lanes: ProjectLaneInput[] = [
    { name: 'Backlog' },
    { name: 'Todo' },
    { name: 'In Progress', agent: 'developer' },
    { name: 'In Review', agent: 'reviewer' },
  ];
  // Backlog's next works nobody; the last lane feeds nothing. Everything
  // else sits before a worker and could hold the queue.
  assert.deepEqual(
    queueCandidates(lanes).map(l => l.name),
    ['Todo', 'In Progress'],
  );

  const said = markQueue(lanes, 'In Progress');
  assert.deepEqual(said, ['"In Progress" works nobody then — it waits work instead'], 'the loss is said');
  assert.deepEqual(lanes[2], { name: 'In Progress', queue: true }, 'the later word wins: the queue lane works none');
  assert.equal(
    lanes.findIndex(l => l.queue),
    2,
  );
});

test('a workflow with no worker lane asks no queue question — and none was ruled a valid answer', () => {
  const lanes = [{ name: 'Backlog' }, { name: 'Todo' }];
  assert.deepEqual(queueCandidates(lanes), [], 'nothing could legally wait work yet');
  // The wizard offers '-- None --': marking nobody changes nothing.
  markQueue(lanes, '');
  assert.deepEqual(lanes, [{ name: 'Backlog' }, { name: 'Todo' }]);
});
