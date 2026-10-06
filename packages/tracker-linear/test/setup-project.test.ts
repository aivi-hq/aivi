/** The wizard's lane list: what it asks, in what order, and what it never
 *  asks. The live test of 2026-10-01 caught the client sorting by `position`
 *  across type groups (Linear scopes position **within** a group), which
 *  shoved Done/Canceled/Duplicate before a late `started` lane; and the
 *  operator ruled the closed states are not lanes at all. `listTeams` sorts
 *  (client.test.ts), `openStates` filters — together they are the board. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectLaneInput } from '@aivi/core';
import { PluginSetupCancelled } from '@aivi/plugin';
import type { LinearTeam } from '../src/client.ts';
import { type MakeTeamsClient, makeContributor, markQueue, openStates, queueCandidates } from '../src/setup-project.ts';

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
  // Backlog's next works nobody; the last lane feeds nothing; and a lane
  // with an agent is never a queue option (ruled 2026-10-02) — the queue is
  // where people wait for a worker, never a working lane itself.
  assert.deepEqual(
    queueCandidates(lanes).map(l => l.name),
    ['Todo'],
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

/** The wizard as a unit: every prompt is on record — asked in order,
 *  answered from the script — and Linear is faked at its one crossing
 *  (`listTeams`), because the GraphQL round trip is client.test.ts's
 *  subject and the live gate's. A question nobody scripted fails loudly. */
const cancel = Symbol('cancel');
const wizard = (
  answers: unknown[],
  opts: { forgeConfigured?: boolean; agents?: string[]; teams?: LinearTeam[]; teamListError?: string } = {},
) => {
  const asked: string[] = [];
  const said: string[] = [];
  let next = 0;
  const prompt = async (message: string) => {
    asked.push(message);
    if (next >= answers.length) throw new Error(`the wizard asked "${message}"; the test scripted no answer`);
    return answers[next++];
  };
  const teams = opts.teams ?? [
    {
      id: 't-1',
      key: 'WEB',
      name: 'Web',
      states: [
        { id: 's-1', name: 'Backlog', type: 'backlog' },
        { id: 's-2', name: 'Todo', type: 'unstarted' },
        { id: 's-3', name: 'In Progress', type: 'started' },
        { id: 's-5', name: 'Done', type: 'completed' },
      ],
    },
  ];
  const makeClient: MakeTeamsClient = () => ({
    async listTeams() {
      if (opts.teamListError) throw new Error(opts.teamListError);
      return teams;
    },
  });
  const ctx = {
    config: { apps: { dev: {} } },
    forgeConfigured: opts.forgeConfigured ?? false,
    print: () => {},
    prompts: {
      select: async ({ message }: { message: string }) => prompt(message),
      multiselect: async ({ message }: { message: string }) => prompt(message),
      text: async ({ message }: { message: string }) => prompt(message),
      spinner: () => ({ start: () => {}, stop: () => {}, error: () => {} }),
      log: { message: async (line: string) => void said.push(line) },
      isCancel: (value: unknown) => value === cancel,
    },
    agents: async () => opts.agents ?? ['developer', 'reviewer'],
    fetch: async () => new Response(),
    withStore: async (fn: (store: unknown) => unknown) => fn({}),
  };
  return { contributor: makeContributor(makeClient), ctx: ctx as never, asked, said };
};

test('the wizard walks the board in order: teams, name, one agent per open state, then the one queue question', async () => {
  const { contributor, ctx, asked } = wizard([
    ['t-1'], // multiselect: which teams may work here
    '', // project id: blank takes the offered suggestion
    'developer', // Backlog
    '', // Todo: a human lane, the orchestrator's silence
    'developer', // In Progress
    'Todo', // the queue question
  ]);
  const result = await contributor.setup(ctx);
  assert.equal(result.id, 'web', 'the first team’s key, lower-cased, when no earlier role settled a name');
  assert.equal(result.cloned, false, 'a tracker has no checkout to give');
  assert.deepEqual(result.section, { teams: ['t-1'] }, 'the linear section holds team ids, not labels');
  assert.deepEqual(
    result.lanes,
    [
      { name: 'Backlog', agent: 'developer' },
      { name: 'Todo', queue: true },
      { name: 'In Progress', agent: 'developer' },
    ],
    'board order, human lanes bare, the queue marked where the person chose',
  );
  assert.deepEqual(
    asked,
    [
      'Which teams may work in this project?',
      "Project id — aivi's name for it; Linear never sees it.",
      'Which OpenCode agent works the "Backlog" lane?',
      'Which OpenCode agent works the "Todo" lane?',
      'Which OpenCode agent works the "In Progress" lane?',
      'Which lane waits with work while the working lanes are full (the queue)?',
    ],
    'the questions, in the ruled order — and Done was never asked: closed states are not lanes',
  );
});

test('with a forge configured a working lane is asked whether it works on the ticket branch; without one it never is', async () => {
  const withForge = wizard([['t-1'], '', 'developer', 'yes', '', 'developer', '', 'Todo'], { forgeConfigured: true });
  const result = await withForge.contributor.setup(withForge.ctx);
  assert.deepEqual(result.lanes, [
    { name: 'Backlog', agent: 'developer', worktree: true },
    { name: 'Todo', queue: true },
    { name: 'In Progress', agent: 'developer' },
  ]);
  assert.ok(
    withForge.asked.some(m => /on the ticket's branch \(git worktree\)/.test(m)),
    'the worktree question was asked for the worked lane',
  );

  // "no" is not a promise of read-only — nothing is written for it (the
  // agent file's own deny says read-only, never aivi's config).
  const plain = wizard([['t-1'], '', 'developer', 'no', '', 'developer', '', 'Todo'], { forgeConfigured: true });
  const plainResult = await plain.contributor.setup(plain.ctx);
  assert.deepEqual(plainResult.lanes, [
    { name: 'Backlog', agent: 'developer' },
    { name: 'Todo', queue: true },
    { name: 'In Progress', agent: 'developer' },
  ]);

  // No forge: no worktree question at all — there are no worktrees to promise.
  const noForge = wizard([['t-1'], '', 'developer', '', 'developer', 'Todo']);
  await noForge.contributor.setup(noForge.ctx);
  assert.ok(!noForge.asked.some(m => /on the ticket's branch/.test(m)), 'without a forge the question is never asked');
});

test('a cancelled answer cancels the setup by name — nothing half-written goes to core', async () => {
  const laneCancel = wizard([['t-1'], '', cancel]);
  await assert.rejects(
    () => laneCancel.contributor.setup(laneCancel.ctx),
    (error: unknown) => error instanceof PluginSetupCancelled && /lane setup incomplete/.test(String(error)),
  );
  const idCancel = wizard([['t-1'], cancel]);
  await assert.rejects(
    () => idCancel.contributor.setup(idCancel.ctx),
    (error: unknown) => error instanceof PluginSetupCancelled && /no project id given/.test(String(error)),
  );
});

test('a dead app and an empty team list stop the wizard with their plain words', async () => {
  const dead = wizard([], { teamListError: 'Linear says no' });
  await assert.rejects(() => dead.contributor.setup(dead.ctx), /Linear says no/, 'the app’s own error rides out');
  const empty = wizard([], { teams: [] });
  await assert.rejects(
    () => empty.contributor.setup(empty.ctx),
    /that Linear app sees no teams — a private team needs the app added to it/,
  );
});

test('no agents is said and stops — aivi always ships at least two, so silence means broken', async () => {
  const broken = wizard([['t-1'], ''], { agents: [] });
  await assert.rejects(
    () => broken.contributor.setup(broken.ctx),
    /Unable to configure lanes: there appear to be no agents available/,
  );
});

test('teams whose board has no open states get the honest note and no lanes', async () => {
  const { contributor, ctx, said } = wizard([['t-1'], ''], {
    teams: [{ id: 't-1', key: 'WEB', name: 'Web', states: [{ id: 's-1', name: 'Done', type: 'completed' }] }],
  });
  const result = await contributor.setup(ctx);
  assert.equal(result.lanes, undefined, 'no lanes, not an empty array: core writes nothing it was not given');
  assert.deepEqual(said, ['these teams have no workflow states yet — lanes get written once the board has some']);
});
