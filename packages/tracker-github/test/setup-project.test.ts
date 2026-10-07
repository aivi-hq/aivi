/** The wizard's lane list: what it asks, in what order, and what it never
 *  asks. GitHub's own `status` on a Status option is the closed-state signal —
 *  `DONE` ends work and is not a lane, the mirror of the Linear ruling of
 *  2026-10-02; the queue rules are that ruling's own words. The board read,
 *  the field creation, and the label are faked at the client crossing, because
 *  the wizard's questions, order and written config are the unit — the GraphQL
 *  round trips are the live gate's. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectLaneInput } from '@aivi/core';
import { PluginSetupCancelled } from '@aivi/plugin';
import {
  boardSuggestion,
  type GithubSetupClient,
  makeContributor,
  markQueue,
  openStatusOptions,
  queueCandidates,
  type SetupBoard,
  type SetupBoardOption,
} from '../src/setup-project.ts';

const statusOptions: SetupBoardOption[] = [
  // A board's Status options as GitHub returns them: board order already.
  { id: 'o-0', name: 'Backlog', status: 'TODO' },
  { id: 'o-1', name: 'Todo', status: 'TODO' },
  { id: 'o-2', name: 'In Progress', status: 'STARTED' },
  { id: 'o-3', name: 'In Review', status: 'STARTED' },
  { id: 'o-4', name: 'Done', status: 'DONE' },
  { id: 'o-5', name: 'Duplicate', status: 'DONE' },
];

test('openStatusOptions keeps the open lanes in board order and drops every closed state', () => {
  assert.deepEqual(
    openStatusOptions(statusOptions).map(o => o.name),
    ['Backlog', 'Todo', 'In Progress', 'In Review'],
  );
});

test('openStatusOptions dedupes a shared option name, keeping the first', () => {
  const twice = [
    ...statusOptions,
    { id: 'x', name: 'In Progress', status: 'STARTED' },
    { id: 'y', name: 'Triage', status: 'TODO' },
  ];
  assert.deepEqual(
    openStatusOptions(twice).map(o => o.name),
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
});

test('a workflow with no worker lane asks no queue question — and none was ruled a valid answer', () => {
  const lanes = [{ name: 'Backlog' }, { name: 'Todo' }];
  assert.deepEqual(queueCandidates(lanes), [], 'nothing could legally wait work yet');
  markQueue(lanes, '');
  assert.deepEqual(lanes, [{ name: 'Backlog' }, { name: 'Todo' }]);
});

test('a board title folds to a project id the way a repository name does', () => {
  assert.equal(boardSuggestion('My Board'), 'my-board');
  assert.equal(boardSuggestion('1000 Boats!'), 'p-1000-boats-', 'a name that no longer starts with a letter keeps one');
});

/** The wizard as a unit: every prompt is on record — asked in order, answered
 *  from the script — and GitHub is faked at its one crossing (the setup
 *  client). A question nobody scripted fails loudly. */
const cancel = Symbol('cancel');
const wizard = (
  answers: unknown[],
  opts: {
    forgeConfigured?: boolean;
    agents?: string[];
    options?: SetupBoardOption[];
    /** undefined: the board has the Agent field; 'none': it lacks it. */
    agentField?: 'none';
    repos?: string[];
    boardError?: string;
    labelError?: string;
  } = {},
) => {
  const asked: string[] = [];
  const said: string[] = [];
  const done: string[] = [];
  let next = 0;
  const prompt = async (message: string) => {
    asked.push(message);
    if (next >= answers.length) throw new Error(`the wizard asked "${message}"; the test scripted no answer`);
    return answers[next++];
  };
  const client: GithubSetupClient = {
    delegate: 'aivi-agent',
    async readBoard(number): Promise<SetupBoard> {
      if (opts.boardError) throw new Error(opts.boardError);
      return {
        id: 'PVT_1',
        number,
        orgId: 'O_1',
        title: 'aivi HQ board',
        statusOptions: opts.options ?? statusOptions,
        ...(opts.agentField === 'none' ? {} : { agentFieldId: 'F_agent' }),
      };
    },
    async createAgentField(_board, delegate) {
      done.push(`agent-field:${delegate}`);
    },
    async repositories() {
      return (opts.repos ?? ['acme/shop']).map(id => ({ id }));
    },
    async ensureLabel(repo, label) {
      if (opts.labelError) throw new Error(opts.labelError);
      done.push(`label:${repo}:${label}`);
    },
  };
  const ctx = {
    config: {},
    forgeConfigured: opts.forgeConfigured ?? false,
    print: () => {},
    prompts: {
      text: async ({ message }: { message: string }) => prompt(message),
      select: async ({ message }: { message: string }) => prompt(message),
      multiselect: async ({ message }: { message: string }) => prompt(message),
      confirm: async ({ message }: { message: string }) => prompt(message),
      autocomplete: async ({ message }: { message: string }) => prompt(message),
      spinner: () => ({ start: () => {}, stop: () => {}, error: () => {}, message: () => {} }),
      log: { message: async (line: string) => void said.push(line) },
      isCancel: (value: unknown) => value === cancel,
    },
    agents: async () => opts.agents ?? ['developer', 'reviewer'],
    fetch: async () => new Response(),
    withStore: async (fn: (store: unknown) => unknown) => fn({}),
  };
  return { contributor: makeContributor(async () => client), ctx: ctx as never, asked, said, done };
};

test('the wizard walks the board in order: board, repositories, name, one agent per open option, then the one queue question', async () => {
  const { contributor, ctx, asked, said, done } = wizard([
    '1', // the board number
    ['acme/shop'], // multiselect: which repositories feed this project
    '', // project id: blank takes the offered suggestion
    'developer', // Backlog
    '', // Todo: a human lane, the orchestrator's silence
    'developer', // In Progress
    '', // In Review: a human lane
    'Todo', // the queue question
  ]);
  const result = await contributor.setup(ctx);
  assert.equal(result.id, 'aivi-hq-board', 'the board title, folded, when no earlier role settled a name');
  assert.equal(result.cloned, false, 'a tracker has no checkout to give');
  assert.deepEqual(
    result.section,
    { board: 1, repos: ['acme/shop'] },
    'the section holds the board number and repo ids',
  );
  assert.deepEqual(
    result.lanes,
    [
      { name: 'Backlog', agent: 'developer' },
      { name: 'Todo', queue: true },
      { name: 'In Progress', agent: 'developer' },
      { name: 'In Review' },
    ],
    'board order, human lanes bare, the queue marked where the person chose',
  );
  assert.deepEqual(
    asked,
    [
      'The board number — the number at the end of the board URL (github.com/orgs/<org>/projects/1 is board 1)',
      'Which repositories feed this project?',
      "Project id — aivi's name for it; GitHub never sees it.",
      'Which OpenCode agent works the "Backlog" lane?',
      'Which OpenCode agent works the "Todo" lane?',
      'Which OpenCode agent works the "In Progress" lane?',
      'Which OpenCode agent works the "In Review" lane?',
      'Which lane waits with work while the working lanes are full (the queue)?',
    ],
    'the questions, in the ruled order — and Done and Duplicate were never asked: closed states are not lanes',
  );
  assert.deepEqual(done, ['label:acme/shop:needs-human'], 'the human label is created in every mapped repository');
  assert.ok(said.some(line => line.includes('“needs-human” is ready in acme/shop.')));
});

test('with a forge configured a working lane is asked whether it works on the ticket branch; without one it never is', async () => {
  const withForge = wizard(['1', ['acme/shop'], '', 'developer', 'yes', '', 'developer', 'no', '', 'Todo'], {
    forgeConfigured: true,
  });
  const result = await withForge.contributor.setup(withForge.ctx);
  assert.deepEqual(result.lanes, [
    { name: 'Backlog', agent: 'developer', worktree: true },
    { name: 'Todo', queue: true },
    { name: 'In Progress', agent: 'developer' },
    { name: 'In Review' },
  ]);
  assert.ok(
    withForge.asked.some(m => /on the ticket's branch \(git worktree\)/.test(m)),
    'the worktree question was asked for the worked lane',
  );
  const withoutForge = wizard(['1', ['acme/shop'], '', 'developer', '', 'developer', '', 'Todo']);
  await withoutForge.contributor.setup(withoutForge.ctx);
  assert.ok(!withoutForge.asked.some(m => /worktree/.test(m)), 'no forge, no worktrees to promise');
});

test('a board without the Agent field is asked before it is touched, and the yes creates it with the app’s own name', async () => {
  const { contributor, ctx, asked, done, said } = wizard(['1', true, ['acme/shop'], '', '', '', '', ''], {
    agentField: 'none',
  });
  const result = await contributor.setup(ctx);
  assert.equal(
    asked[1],
    'Create the “Agent” single-select field on board “aivi HQ board”, with the option “aivi-agent”? Apps cannot be assignees on GitHub — this field is how aivi gets delegated.',
  );
  assert.deepEqual(done, ['agent-field:aivi-agent', 'label:acme/shop:needs-human']);
  assert.ok(said.some(line => line.includes('Routing reads the field, not the view')));
  assert.equal(result.lanes?.length, 4);
});

test('a refused Agent field is a decision the tracker cannot work past', async () => {
  const { contributor, ctx, done } = wizard(['1', false], { agentField: 'none' });
  await assert.rejects(contributor.setup(ctx), /creating one was refused/);
  assert.deepEqual(done, [], 'the refusal is respected: nothing was created');
});

test('a board the app cannot read ends the wizard with the permission that unlocks it', async () => {
  const { contributor, ctx } = wizard(['1'], {
    boardError:
      'board 1 is not visible to the app in aivi-hq: check the number at the end of the board URL, and that the installation has “Organization projects: Read & write”',
  });
  await assert.rejects(contributor.setup(ctx), /Organization projects: Read & write/);
});

test('a human label that cannot be created is said with its repository and its remedy', async () => {
  const { contributor, ctx, done } = wizard(['1', ['acme/shop'], '', '', '', '', '', ''], {
    labelError: 'gh: Not Found',
  });
  await assert.rejects(
    contributor.setup(ctx),
    /label “needs-human” could not be created in acme\/shop: .*Issues: Read & write/,
  );
  assert.deepEqual(done, [], 'the failed label is the failure, not a done line');
});

test('a cancelled answer stops the wizard, and nothing further is written', async () => {
  const { contributor, ctx, done } = wizard(['1', cancel]);
  await assert.rejects(contributor.setup(ctx), PluginSetupCancelled);
  assert.deepEqual(done, []);
});
