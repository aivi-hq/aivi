/** The wizard's lane list: what it asks, in what order, and what it never
 *  asks. The live test of 2026-10-01 caught the client sorting by `position`
 *  across type groups (Linear scopes position **within** a group), which
 *  shoved Done/Canceled/Duplicate before a late `started` lane; and the
 *  operator ruled the closed states are not lanes at all. `listTeams` sorts
 *  (client.test.ts), `openStates` filters — together they are the board. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinearTeam } from '../src/client.ts';
import { openStates } from '../src/setup-project.ts';

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
