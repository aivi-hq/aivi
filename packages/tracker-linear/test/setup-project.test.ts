/** The wizard's lane list: what it asks, in what order, and what each answer
 *  writes. The live test of 2026-10-01 caught the client sorting by `position`
 *  across type groups (Linear scopes position **within** a group), which
 *  shoved Done/Canceled/Duplicate before a late `started` lane; `listTeams`
 *  sorts (client.test.ts) and `boardStates` dedupes. **Every state is
 *  asked**: Linear's `type` is real API data, so it sets which answer the
 *  kind question starts on — it hides nothing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectLaneInput } from '@aivi/core';
import { LANE_KIND, PluginSetupCancelled } from '@aivi/plugin';
import type { LinearTeam } from '../src/client.ts';
import {
  boardStates,
  laneKindDefault,
  type MakeTeamsClient,
  makeContributor,
  markQueue,
  queueCandidates,
} from '../src/setup-project.ts';

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

test('boardStates keeps every state in board order and dedupes a shared name across teams, keeping the first', () => {
  const twice = [
    ...states,
    { id: 'x', name: 'In Progress', type: 'started' },
    { id: 'y', name: 'Triage', type: 'triage' },
  ];
  assert.deepEqual(
    boardStates(twice).map(s => s.name),
    ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled', 'Duplicate', 'Triage'],
    'nothing is dropped: what a state is for is the person’s answer, not aivi’s guess',
  );
});

test('the kind question starts on what Linear’s type suggests — a highlight, not a ruling', () => {
  assert.equal(laneKindDefault('completed'), 'human', 'finished work goes to a person');
  assert.equal(laneKindDefault('canceled'), 'none', 'canceled ends out of the workflow');
  assert.equal(laneKindDefault('duplicate'), 'none', 'duplicate ends out of the workflow');
  assert.equal(laneKindDefault('started'), 'agent');
  assert.equal(laneKindDefault('backlog'), 'agent');
  assert.equal(laneKindDefault('triage'), 'agent', 'an unknown type starts on the working answer');
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
  // where people wait for a worker, never a working lane itself. A **human**
  // lane is a legal queue: that is what "used as a queue" means.
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

/** The wizard as a unit: every prompt is on record — asked in order, answered
 *  from the script, options and defaults included (`asks`) — and Linear is
 *  faked at its one crossing (`listTeams`), because the GraphQL round trip is
 *  client.test.ts's subject and the live gate's. A question nobody scripted
 *  fails loudly. `tape` interleaves questions (`q:`) and log lines (`s:`) so
 *  the explanation's place — once, before the first kind question — is
 *  testable. */
const cancel = Symbol('cancel');
const wizard = (
  answers: unknown[],
  opts: { forgeConfigured?: boolean; agents?: string[]; teams?: LinearTeam[]; teamListError?: string } = {},
) => {
  const asked: string[] = [];
  const said: string[] = [];
  const tape: string[] = [];
  const asks: { message: string; opts: Record<string, unknown> }[] = [];
  let next = 0;
  const prompt = async (message: string) => {
    asked.push(message);
    tape.push(`q:${message}`);
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
      select: async (options: { message: string }) => {
        asks.push({ message: options.message, opts: options });
        return prompt(options.message);
      },
      multiselect: async ({ message }: { message: string }) => prompt(message),
      text: async ({ message }: { message: string }) => prompt(message),
      spinner: () => ({ start: () => {}, stop: () => {}, error: () => {} }),
      log: {
        message: async (line: string) => {
          said.push(line);
          tape.push(`s:${line}`);
        },
      },
      isCancel: (value: unknown) => value === cancel,
    },
    agents: async () => opts.agents ?? ['developer', 'reviewer'],
    fetch: async () => new Response(),
    withStore: async (fn: (store: unknown) => unknown) => fn({}),
  };
  return { contributor: makeContributor(makeClient), ctx: ctx as never, asked, said, tape, asks };
};

/** The four-state board answered by the kind question: Backlog and
 *  In Progress work, Todo is a human lane that takes the queue, and Done —
 *  asked like every other state — is a human lane too. */
const KINDS = ['agent', 'developer', 'human', 'agent', 'developer', 'human'];

test('the wizard walks the board in order: teams, name, one kind question per state — Done included — then the one queue question', async () => {
  const { contributor, ctx, asked, tape } = wizard([['t-1'], '', ...KINDS, 'Todo']);
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
      { name: 'Done' },
    ],
    'board order, human lanes bare, the queue marked where the person chose',
  );
  assert.deepEqual(
    asked,
    [
      'Which teams may work in this project?',
      "Project id — aivi's name for it; Linear never sees it.",
      'What kind of lane is the "Backlog" state?',
      'Which OpenCode agent works the "Backlog" lane?',
      'What kind of lane is the "Todo" state?',
      'What kind of lane is the "In Progress" state?',
      'Which OpenCode agent works the "In Progress" lane?',
      'What kind of lane is the "Done" state?',
      'Which lane waits with work while the working lanes are full (the queue)?',
    ],
    'the questions, in the ruled order — Done asked like every other state',
  );
  // The explanation: one entry, before the first kind question, carrying
  // all three answers' words and the queue sentence.
  const explained = tape.filter(line => line.includes('What each answer means'));
  assert.equal(explained.length, 1, `the explanation is one entry, never repeated: ${tape.join(' | ')}`);
  for (const words of [
    LANE_KIND.agent.label,
    LANE_KIND.human.label,
    LANE_KIND.none.label,
    'A queue is where tickets wait while the working lanes are full',
  ])
    assert.ok(explained[0]!.includes(words), `the explanation says: ${words}`);
  const first = tape.findIndex(line => line.startsWith('q:What kind of lane'));
  assert.ok(tape.indexOf(explained[0]!) < first, 'the explanation comes before the first kind question');
});

test('the question starts a completed state on Human and a working state on Agent', async () => {
  const { contributor, ctx, asks } = wizard([['t-1'], '', ...KINDS, 'Todo']);
  await contributor.setup(ctx);
  const backlog = asks.find(a => a.message === 'What kind of lane is the "Backlog" state?');
  assert.ok(backlog, 'the kind question was asked');
  assert.deepEqual((backlog.opts as { options: unknown[] }).options, [
    LANE_KIND.agent,
    LANE_KIND.human,
    LANE_KIND.none,
  ]);
  const done = asks.find(a => a.message === 'What kind of lane is the "Done" state?');
  assert.ok(done, 'Done is asked like every other state');
  assert.deepEqual((done.opts as { options: unknown[] }).options, [LANE_KIND.human, LANE_KIND.agent, LANE_KIND.none]);
});

test('with a forge configured a worked lane is asked whether it works on the ticket branch; a human lane never is', async () => {
  const withForge = wizard(
    [['t-1'], '', 'agent', 'developer', 'yes', 'human', 'agent', 'developer', 'no', 'human', 'Todo'],
    { forgeConfigured: true },
  );
  const result = await withForge.contributor.setup(withForge.ctx);
  assert.deepEqual(result.lanes, [
    { name: 'Backlog', agent: 'developer', worktree: true },
    { name: 'Todo', queue: true },
    { name: 'In Progress', agent: 'developer' },
    { name: 'Done' },
  ]);
  const branchQuestions = withForge.asked.filter(m => /on the ticket's branch \(git worktree\)/.test(m));
  assert.deepEqual(
    branchQuestions.map(m => /"([^"]+)"/.exec(m)?.[1]),
    ['Backlog', 'In Progress'],
    'the worktree question comes only after an agent answer',
  );

  // "no" is not a promise of read-only — nothing is written for it (the
  // agent file's own deny says read-only, never aivi's config).
  const plain = wizard(
    [['t-1'], '', 'agent', 'developer', 'no', 'human', 'agent', 'developer', 'no', 'human', 'Todo'],
    {
      forgeConfigured: true,
    },
  );
  const plainResult = await plain.contributor.setup(plain.ctx);
  assert.deepEqual(plainResult.lanes, [
    { name: 'Backlog', agent: 'developer' },
    { name: 'Todo', queue: true },
    { name: 'In Progress', agent: 'developer' },
    { name: 'Done' },
  ]);

  // No forge: no worktree question at all — there are no worktrees to promise.
  const noForge = wizard([['t-1'], '', ...KINDS, 'Todo']);
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

test('a team answered “None” on every state gets the honest note and no lanes', async () => {
  const { contributor, ctx, said } = wizard([['t-1'], '', 'none'], {
    teams: [{ id: 't-1', key: 'WEB', name: 'Web', states: [{ id: 's-1', name: 'Done', type: 'completed' }] }],
  });
  const result = await contributor.setup(ctx);
  assert.equal(result.lanes, undefined, 'no lanes, not an empty array: core writes nothing it was not given');
  assert.deepEqual(
    said.filter(l => !l.includes('What each answer means')),
    [
      'no lanes were written — the boards had no states, or every state was answered “None” — so aivi works no tickets until lanes exist',
    ],
  );
});
