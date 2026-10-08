/** The wizard's lane list: what it asks, in what order, and what each answer
 *  writes. **Every Status option is asked**: per option the person answers
 *  Agent, Human or None, and nothing is hidden because of an option's name
 *  or position — GitHub gives no state flag to hide behind. The queue rules
 *  are the lane model's own words. The board read, the field creation, and
 *  the label are faked at the client
 *  crossing, because the wizard's questions, order and written config are the
 *  unit — the GraphQL round trips are the live gate's, and the probe's own
 *  choices are proven below against the scripted GitHub. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ProjectLaneInput } from '@aivi/core';
import { GITHUB_WEBHOOK_SECRET_ENV, webhookSignature } from '@aivi/github';
import { LANE_KIND, PluginSetupCancelled } from '@aivi/plugin';
import {
  BoardSetupClient,
  boardSuggestion,
  type GithubSetupClient,
  makeContributor,
  markQueue,
  type ProbeHandles,
  queueCandidates,
  type SetupBoard,
  type SetupBoardOption,
} from '../src/setup-project.ts';
import { GITHUB_WEBHOOK_PATH } from '../src/tracker.ts';
import { type Answer, connectApp, connectRoutes, graphql, issueNode, type Seen, scripted } from './github-api.ts';

const statusOptions: SetupBoardOption[] = [
  // A board's Status options as GitHub answers them: board order already,
  // an id and a name and nothing else.
  { id: 'o-0', name: 'Backlog' },
  { id: 'o-1', name: 'Todo' },
  { id: 'o-2', name: 'In Progress' },
  { id: 'o-3', name: 'In Review' },
  { id: 'o-4', name: 'Done' },
  { id: 'o-5', name: 'Duplicate' },
];

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
 *  client). A question nobody scripted fails loudly. `tape` interleaves the
 *  questions (`q:`) and the log lines (`s:`) so the order between them is
 *  testable: the explanation must land once, before the first kind question.
 *  The health gate is asked of the config.json the context points at:
 *  `health: 'down'` (the default) has no readable file, so the gate question
 *  lands first and the script answers it like any other; `'up'` writes one and
 *  the probe runs, its diary rows signed with `secret` like GitHub signs
 *  them. */
const cancel = Symbol('cancel');
const GATE = 'No live aivi answers its health endpoint — the probe watches what a running aivi records';
const wizard = (
  answers: unknown[],
  opts: {
    forgeConfigured?: boolean;
    /** The repository a forge settled, threaded into the context. */
    forgeRepository?: string;
    agents?: string[];
    options?: SetupBoardOption[];
    /** undefined: the board has the Agent field; 'none': it lacks it. */
    agentField?: 'none';
    repos?: string[];
    boardError?: string;
    labelError?: string;
    health?: 'up' | 'down';
    /** Diary rows the fake store answers with — signed deliveries. */
    rows?: { id: number; method: string; path: string; body: string; headers: Record<string, string> }[];
    /** View names the fake client says it changed; [] says all already show. */
    views?: string[];
    /** What the fake openProbe pays: signals asked, and whether Status was. */
    probe?: { asked: string[]; statusSkipped?: boolean };
    /** A message the fake openProbe dies with — the probe never starts. */
    probeError?: string;
  } = {},
) => {
  const asked: string[] = [];
  const said: string[] = [];
  const done: string[] = [];
  const live: string[] = [];
  const tape: string[] = [];
  const asks: { message: string; opts: Record<string, unknown> }[] = [];
  /** Every grant listing the fake client served: one entry per call, so a
   *  test can say the same-as-forge answer asked the app nothing. */
  const listed: string[] = [];
  let next = 0;
  const prompt = async (message: string) => {
    asked.push(message);
    tape.push(`q:${message}`);
    if (next >= answers.length) throw new Error(`the wizard asked "${message}"; the test scripted no answer`);
    return answers[next++];
  };
  let hasAgent = opts.agentField !== 'none';
  const root = mkdtempSync(join(tmpdir(), 'aivi-setup-project-'));
  const configPath = join(root, 'config.json');
  if (opts.health === 'up') writeFileSync(configPath, JSON.stringify({ host: { public: 'http://127.0.0.1:4100' } }));
  const rows = opts.rows ?? [];
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
        statusFieldId: 'F_status',
        ...(hasAgent ? { agentFieldId: 'F_agent' } : {}),
        agentOptions: hasAgent ? [{ id: 'o-agent', name: 'aivi-agent' }] : [],
      };
    },
    async createAgentField(_board, delegate) {
      done.push(`agent-field:${delegate}`);
      hasAgent = true; // the board answers its new field on the read-back
    },
    async showAgentOnViews() {
      const shown = opts.views ?? ['Main'];
      done.push(`views:${shown.join('+')}`);
      return shown;
    },
    async repositories() {
      listed.push('listed');
      return (opts.repos ?? ['acme/shop']).map(id => ({ id }));
    },
    async ensureLabel(repo, label) {
      if (opts.labelError) throw new Error(opts.labelError);
      done.push(`label:${repo}:${label}`);
    },
    async openProbe(repo): Promise<ProbeHandles> {
      if (opts.probeError) throw new Error(opts.probeError);
      done.push('probe-open');
      const askedSignals = opts.probe?.asked ?? ['issue opened', 'card added', 'Agent set', 'comment posted'];
      return {
        ref: `${repo}#9`,
        number: 9,
        nodeId: 'I_9',
        itemId: 'PVTI_9',
        projectId: 'PVT_1',
        agentFieldId: 'F_agent',
        commentId: 701,
        asked: askedSignals,
        statusSkipped: opts.probe?.statusSkipped ?? !askedSignals.includes('Status moved'),
      };
    },
    async closeProbe() {
      done.push('probe-close');
      // The production client answers how the card rests, in GitHub's real
      // terms; the wizard logs what it is handed. This is those terms.
      return 'acme/shop#9 is closed (not planned), its card archived, its comment deleted — GitHub has no API to delete an issue';
    },
  };
  const ctx = {
    config: {},
    configPath,
    forgeConfigured: opts.forgeConfigured ?? false,
    ...(opts.forgeRepository === undefined ? {} : { forgeRepository: opts.forgeRepository }),
    print: () => {},
    prompts: {
      text: async (options: { message: string }) => {
        asks.push({ message: options.message, opts: options });
        return prompt(options.message);
      },
      select: async (options: { message: string }) => {
        asks.push({ message: options.message, opts: options });
        return prompt(options.message);
      },
      multiselect: async ({ message }: { message: string }) => prompt(message),
      confirm: async ({ message }: { message: string }) => prompt(message),
      autocomplete: async ({ message }: { message: string }) => prompt(message),
      spinner: () => ({
        start: (line: string) => live.push(line),
        message: (line: string) => live.push(line),
        stop: (line: string) => live.push(line),
        cancel: (line: string) => live.push(line),
        error: (line: string) => live.push(line),
      }),
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
    withStore: async (fn: (store: unknown) => unknown) =>
      fn({
        requests: (filter: { method?: string; path?: string; sinceId?: number } = {}) =>
          rows.filter(
            row =>
              (filter.method === undefined || row.method === filter.method) &&
              (filter.path === undefined || row.path === filter.path) &&
              row.id > (filter.sinceId ?? 0),
          ),
      }),
  };
  return {
    contributor: makeContributor(async () => client),
    ctx: ctx as never,
    asked,
    said,
    done,
    live,
    tape,
    asks,
    listed,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

/** The six-option board answered by the kind question: Backlog and
 *  In Progress work, Todo and In Review are human lanes, Done and Duplicate
 *  are None — then Todo takes the queue mark. */
const KINDS = ['agent', 'developer', 'human', 'agent', 'developer', 'human', 'none', 'none'];

test('the wizard walks the board in order: gate, board, repositories, name, one kind question per option — closed ones included — then the one queue question', async t => {
  const { contributor, ctx, asked, said, done, tape, cleanup } = wizard([
    'skip',
    '1',
    ['acme/shop'],
    '',
    ...KINDS,
    'Todo',
  ]);
  t.after(cleanup);
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
    'board order, human lanes bare, the queue marked where the person chose, the None answers written nowhere',
  );
  assert.deepEqual(
    asked,
    [
      GATE,
      'The board number — the number at the end of the board URL (github.com/orgs/<org>/projects/1 is board 1)',
      'Which repositories hold the issues?',
      "Project id — aivi's name for it; GitHub never sees it.",
      'What kind of lane is the "Backlog" option?',
      'Which OpenCode agent works the "Backlog" lane?',
      'What kind of lane is the "Todo" option?',
      'What kind of lane is the "In Progress" option?',
      'Which OpenCode agent works the "In Progress" lane?',
      'What kind of lane is the "In Review" option?',
      'What kind of lane is the "Done" option?',
      'What kind of lane is the "Duplicate" option?',
      'Which lane waits with work while the working lanes are full (the queue)?',
    ],
    'the questions, in the ruled order — every option asked, Done and Duplicate included',
  );
  // The explanation: one entry, before the first kind question, carrying
  // all three answers' words and the queue sentence.
  const explained = tape.filter(line => line.includes('What each answer means'));
  assert.equal(explained.length, 1, `the explanation is one entry, never repeated: ${tape.join(' | ')}`);
  const entry = explained[0]!;
  for (const words of [
    LANE_KIND.agent.label,
    LANE_KIND.human.label,
    LANE_KIND.none.label,
    'A queue is where tickets wait while the working lanes are full',
  ])
    assert.ok(entry.includes(words), `the explanation says: ${words}`);
  const first = tape.findIndex(line => line.startsWith('q:What kind of lane'));
  assert.ok(tape.indexOf(explained[0]!) < first, 'the explanation comes before the first kind question');
  assert.deepEqual(
    done,
    ['views:Main', 'label:acme/shop:needs-human'],
    'the Agent field is shown on the views, the human label created in every mapped repository — and the probe was skipped with the gate',
  );
  assert.ok(said.some(line => line.includes('“needs-human” is ready in acme/shop.')));
  assert.ok(
    said.some(line => line.startsWith('UNVERIFIED')),
    'continue-anyway says the unproved fact, never a claimed success',
  );
});

test('the board number question really defaults to 1: Enter — an empty answer — takes it', async t => {
  // clack 1.x validates the raw input before finalize applies
  // defaultValue, so a validate that refuses '' makes the default
  // unreachable. The pin is the behavior, not the passed option: the
  // person presses Enter, an empty string comes back, and board 1 is what
  // gets read and written.
  const { contributor, ctx, asks, live, cleanup } = wizard(['skip', '', ['acme/shop'], '', ...KINDS, 'Todo']);
  t.after(cleanup);
  const result = await contributor.setup(ctx);
  assert.equal(result.section?.board, 1, 'the empty answer took board 1');
  assert.ok(
    live.some(line => line.startsWith('Reading board 1')),
    `the read that ran was board 1: ${live.join(' | ')}`,
  );
  const board = asks.find(a => a.message.startsWith('The board number'));
  assert.equal(board?.opts.defaultValue, '1', 'the option is there for when clack applies defaults itself');
  assert.equal(board?.opts.placeholder, '1', 'and what Enter takes is visible while typing');
});

test('the kind question offers the three answers in the ruled words', async t => {
  const { contributor, ctx, asks, cleanup } = wizard(['skip', '1', ['acme/shop'], '', ...KINDS, 'Todo']);
  t.after(cleanup);
  await contributor.setup(ctx);
  const kind = asks.find(a => a.message === 'What kind of lane is the "Backlog" option?');
  assert.ok(kind, 'the kind question was asked');
  assert.deepEqual((kind.opts as { options: unknown[] }).options, [LANE_KIND.agent, LANE_KIND.human, LANE_KIND.none]);
});

test('a forge that settled a repository is the first answer, and taking it asks the app nothing', async t => {
  const { contributor, ctx, asked, asks, listed, done, cleanup } = wizard(['skip', '1', 'same', '', ...KINDS, 'Todo'], {
    forgeRepository: 'acme/shop',
  });
  t.after(cleanup);
  const result = await contributor.setup(ctx);
  assert.deepEqual(result.section, { board: 1, repos: ['acme/shop'] }, 'the forge answer is the section answer');
  assert.ok(asked.includes('Which repository holds the issues?'), 'the two-option question was asked');
  assert.ok(!asked.includes('Which repositories hold the issues?'), 'the pick-list was not');
  assert.equal(listed.length, 0, 'the app was asked nothing: the forge proved it reads this repository');
  const question = asks.find(a => a.message === 'Which repository holds the issues?');
  assert.deepEqual((question!.opts as { options: { value: string; label: string }[] }).options, [
    { value: 'same', label: 'Same as forge: acme/shop' },
    { value: 'other', label: 'choose a different repository' },
  ]);
  assert.deepEqual(done, ['views:Main', 'label:acme/shop:needs-human'], 'the label is still created there');
});

test('“choose a different repository” opens the grant pick-list, listed once', async t => {
  const { contributor, ctx, asked, listed, cleanup } = wizard(
    ['skip', '1', 'other', ['other/repo'], '', ...KINDS, 'Todo'],
    { forgeRepository: 'acme/shop' },
  );
  t.after(cleanup);
  const result = await contributor.setup(ctx);
  assert.deepEqual(result.section, { board: 1, repos: ['other/repo'] }, 'the pick-list answer is written');
  const at = asked.indexOf('Which repository holds the issues?');
  assert.ok(at >= 0, 'the two-option question was asked first');
  assert.equal(asked[at + 1], 'Which repositories hold the issues?', 'the pick-list follows the refusal');
  assert.equal(listed.length, 1, 'the grant is listed once, only when a pick-list is needed');
});

test('with a forge configured a worked lane is asked whether it works on the ticket branch; a human lane never is', async t => {
  const withForge = wizard(
    [
      'skip',
      '1',
      ['acme/shop'],
      '',
      'agent',
      'developer',
      'yes',
      'human',
      'agent',
      'developer',
      'no',
      'human',
      'none',
      'none',
      'Todo',
    ],
    { forgeConfigured: true },
  );
  t.after(withForge.cleanup);
  const result = await withForge.contributor.setup(withForge.ctx);
  assert.deepEqual(result.lanes, [
    { name: 'Backlog', agent: 'developer', worktree: true },
    { name: 'Todo', queue: true },
    { name: 'In Progress', agent: 'developer' },
    { name: 'In Review' },
  ]);
  const branchQuestions = withForge.asked.filter(m => /on the ticket's branch \(git worktree\)/.test(m));
  assert.deepEqual(
    branchQuestions.map(m => /"([^"]+)"/.exec(m)?.[1]),
    ['Backlog', 'In Progress'],
    'the worktree question comes only after an agent answer',
  );
  const withoutForge = wizard(['skip', '1', ['acme/shop'], '', ...KINDS, 'Todo']);
  t.after(withoutForge.cleanup);
  await withoutForge.contributor.setup(withoutForge.ctx);
  assert.ok(!withoutForge.asked.some(m => /worktree/.test(m)), 'no forge, no worktrees to promise');
});

test('a board without the Agent field is asked before it is touched, and the yes creates it with the app’s own name', async t => {
  const { contributor, ctx, asked, done, said, cleanup } = wizard(
    ['skip', '1', true, ['acme/shop'], '', ...KINDS, 'Todo'],
    { agentField: 'none' },
  );
  t.after(cleanup);
  const result = await contributor.setup(ctx);
  assert.equal(
    asked[2],
    'Create the “Agent” single-select field on board “aivi HQ board”, with the option “aivi-agent”? Apps cannot be assignees on GitHub — this field is how aivi gets delegated.',
  );
  assert.deepEqual(done, ['agent-field:aivi-agent', 'views:Main', 'label:acme/shop:needs-human']);
  assert.ok(
    said.some(line => line === 'Created “Agent” on board “aivi HQ board” with the option “aivi-agent”.'),
    'the created field is said with its option',
  );
  assert.ok(
    said.some(line => line === '“Agent” now shows on: Main.'),
    'the field is appended to the views',
  );
  assert.equal(result.lanes?.length, 4);
});

test('a board that already shows the Agent field is written to no more', async t => {
  const { contributor, ctx, said, done, cleanup } = wizard(['skip', '1', ['acme/shop'], '', ...KINDS, 'Todo'], {
    views: [],
  });
  t.after(cleanup);
  await contributor.setup(ctx);
  assert.ok(done.includes('views:'), 'the views were read');
  assert.ok(
    said.some(line => line === '“Agent” already shows on the board’s views.'),
    'idempotent: nothing was written back',
  );
});

test('a refused Agent field is a decision the tracker cannot work past', async t => {
  const { contributor, ctx, done, cleanup } = wizard(['skip', '1', false], { agentField: 'none' });
  t.after(cleanup);
  await assert.rejects(contributor.setup(ctx), /creating one was refused/);
  assert.deepEqual(done, [], 'the refusal is respected: nothing was created');
});

test('a board the app cannot read ends the wizard with the permission that unlocks it', async t => {
  const { contributor, ctx, cleanup } = wizard(['skip', '1'], {
    boardError:
      'board 1 is not visible to the app in aivi-hq: check the number at the end of the board URL, and that the installation has “Organization projects: Read & write”',
  });
  t.after(cleanup);
  await assert.rejects(contributor.setup(ctx), /Organization projects: Read & write/);
});

test('a human label that cannot be created is said with its repository and its remedy', async t => {
  const { contributor, ctx, done, cleanup } = wizard(['skip', '1', ['acme/shop'], '', ...KINDS, 'Todo'], {
    labelError: 'gh: Not Found',
  });
  t.after(cleanup);
  await assert.rejects(
    contributor.setup(ctx),
    /label “needs-human” could not be created in acme\/shop: .*Issues: Read & write/,
  );
  assert.deepEqual(
    done,
    ['views:Main'],
    'the failed label is the failure, not a done line — only the views were written before it',
  );
});

test('a cancelled answer stops the wizard, and nothing further is written', async t => {
  const { contributor, ctx, done, cleanup } = wizard(['skip', '1', cancel]);
  t.after(cleanup);
  await assert.rejects(contributor.setup(ctx), PluginSetupCancelled);
  assert.deepEqual(done, ['views:Main'], 'the views stand alone; the cancelled repositories wrote nothing else');
});

/** The probe's diary rows, signed the way GitHub signs: the wizard verifies
 *  every row with the module's own seal check, so a fake that signs nothing
 *  would fake the fact under test. */
const PROBE_SECRET = 'dlf-probe-secret';
const row = (id: number, event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  return {
    id,
    method: 'POST',
    path: GITHUB_WEBHOOK_PATH,
    body,
    headers: { 'x-github-event': event, 'x-hub-signature-256': webhookSignature(PROBE_SECRET, body) },
  };
};
const FIVE = [
  row(1, 'issues', { action: 'opened', issue: { number: 9 }, repository: { full_name: 'acme/shop' } }),
  row(2, 'projects_v2_item', {
    action: 'created',
    project_node_id: 'PN_1',
    projects_v2_item: { content: { node_id: 'I_9' } },
    repository: { full_name: 'acme/shop' },
  }),
  row(3, 'projects_v2_item', {
    action: 'edited',
    changes: { field_name: 'Status' },
    project_node_id: 'PN_1',
    projects_v2_item: { content: { node_id: 'I_9' } },
    repository: { full_name: 'acme/shop' },
  }),
  row(4, 'projects_v2_item', {
    action: 'edited',
    changes: { field_value: { field_name: 'Agent' } }, // the spelling the live probe saw too
    project_node_id: 'PN_1',
    projects_v2_item: { content: { node_id: 'I_9' } },
    repository: { full_name: 'acme/shop' },
  }),
  row(5, 'issue_comment', {
    action: 'created',
    comment: {
      id: 701,
      body: 'aivi projects add test — safe to ignore.',
      user: { login: 'aivi-agent[bot]', type: 'Bot' },
    },
    issue: { number: 9 },
    repository: { full_name: 'acme/shop' },
  }),
];
const ALL_ASKED = ['issue opened', 'card added', 'Agent set', 'comment posted', 'Status moved'];

/** The wizard's answers up to the end of the questions (no gate: health is
 *  up in these tests); the probe then runs unasked. */
const QUESTIONS = ['1', ['acme/shop'], '', ...KINDS, 'Todo'];

const secrets = (t: TestContext, values: Record<string, string | undefined>) => {
  const had = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, process.env[name]]));
  const put = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value; // process.env stringifies: assigning undefined writes the string "undefined"
  };
  for (const [name, value] of Object.entries(values)) put(name, value);
  t.after(() => {
    for (const [name, value] of Object.entries(had)) put(name, value);
  });
};

test('with a live aivi the wizard ends with the board probe: every sealed delivery, then cleanup', async t => {
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: PROBE_SECRET });
  const { contributor, ctx, asked, said, done, live, cleanup } = wizard(QUESTIONS, {
    health: 'up',
    rows: FIVE,
    probe: { asked: ALL_ASKED },
  });
  t.after(cleanup);
  const result = await contributor.setup(ctx);
  assert.equal(
    asked[0],
    'The board number — the number at the end of the board URL (github.com/orgs/<org>/projects/1 is board 1)',
    'health answered: the gate asked nothing',
  );
  assert.ok(!said.some(line => line.startsWith('UNVERIFIED')), 'a verified wizard says no UNVERIFIED');
  assert.ok(done.includes('probe-open') && done.includes('probe-close'), 'the probe was paid and laid to rest');
  assert.ok(
    done.indexOf('label:acme/shop:needs-human') < done.indexOf('probe-open'),
    'the probe comes after everything it tests',
  );
  assert.ok(
    live.some(line => line.startsWith('Heard: issues opened')),
    'each delivery is said the moment it lands',
  );
  assert.ok(
    live.some(line => line === 'the board speaks — all 5 deliveries arrived and verified — every seal matched'),
    `the verdict names what arrived: ${live.join(' | ')}`,
  );
  assert.ok(
    said.some(line => line.includes('GitHub has no API to delete an issue')),
    'the card’s resting line is what closeProbe answered, said with the cleanup',
  );
  assert.ok(
    said.some(line => line.startsWith('the reaction surface answered too')),
    'the reaction is said as paid and read back, never as a delivery',
  );
  assert.equal(result.section?.board, 1, 'the mapping stands');
});

test('a probe nobody answered is a verdict, not a rewrite: the mapping stands and the silence is said', async t => {
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: PROBE_SECRET, AIVI_PROBE_WINDOW_MS: '10' });
  const { contributor, ctx, said, done, live, cleanup } = wizard(QUESTIONS, {
    health: 'up',
    rows: [],
    probe: { asked: ALL_ASKED },
  });
  t.after(cleanup);
  const result = await contributor.setup(ctx);
  assert.ok(
    live.some(line => line.startsWith('board probe — ') && line.includes('did not arrive')),
    `the missing signals are the verdict: ${live.join(' | ')}`,
  );
  assert.ok(done.includes('probe-close'), 'cleanup runs whatever the verdict');
  assert.ok(said.some(line => line.includes('GitHub has no API to delete an issue')));
  assert.equal(result.section?.board, 1, 'the mapping on disk is right; what is missing is reach');
});

test('a delivery that fails the seal ends the wizard with the secret remedy', async t => {
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: PROBE_SECRET, AIVI_PROBE_WINDOW_MS: '10' });
  const tampered = { ...FIVE[0]!, headers: { ...FIVE[0]!.headers, 'x-hub-signature-256': 'sha256=nope' } };
  const { contributor, ctx, cleanup } = wizard(QUESTIONS, {
    health: 'up',
    rows: [tampered],
    probe: { asked: ALL_ASKED },
  });
  t.after(cleanup);
  await assert.rejects(contributor.setup(ctx), /failed the module's own check: bad signature/);
});

test('no webhook secret in the home stops the probe with its remedy', async t => {
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: undefined });
  const { contributor, ctx, cleanup } = wizard(QUESTIONS, { health: 'up', rows: FIVE });
  t.after(cleanup);
  await assert.rejects(contributor.setup(ctx), /aivi add @aivi\/tracker-github/);
});

test('a probe that dies mid-flight stops the spinner with its error — never left turning', async t => {
  // The live failure this pins: GitHub refused the walk's read while the
  // probe spinner was turning; the run printed "Setup stopped" under a
  // spinner that kept moving. The error must land on the spinner, and the
  // card's fate must be said — a partial test card may stand on the board.
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: PROBE_SECRET });
  const { contributor, ctx, live, done, cleanup } = wizard(QUESTIONS, {
    health: 'up',
    rows: FIVE,
    probeError: "Field 'projectItems' doesn't accept argument 'archived'",
  });
  t.after(cleanup);
  await assert.rejects(contributor.setup(ctx), /doesn't accept argument/);
  assert.ok(
    live.some(line => line.startsWith('the probe could not start:') && line.includes("doesn't accept argument")),
    `the spinner was stopped with the error, not left turning: ${live.join(' | ')}`,
  );
  assert.ok(
    live.some(line => line.includes('close it by hand')),
    'a card the probe may have left on the board is said, not left silent',
  );
  assert.ok(!done.includes('probe-close'), 'cleanup is not paid when the probe never started');
});

test('a board with one Status option skips the Status signal — skipped is said, never failed', async t => {
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: PROBE_SECRET });
  const four = ALL_ASKED.filter(name => name !== 'Status moved');
  const { contributor, ctx, said, live, cleanup } = wizard(['1', ['acme/shop'], '', 'agent', 'developer', 'human'], {
    health: 'up',
    options: [
      { id: 'o-0', name: 'Todo' },
      { id: 'o-4', name: 'Done' },
    ],
    rows: FIVE.filter(
      r => r.headers['x-github-event'] !== 'projects_v2_item' || JSON.parse(r.body).changes?.field_name !== 'Status',
    ),
    probe: { asked: four },
  });
  t.after(cleanup);
  await contributor.setup(ctx);
  assert.ok(
    said.some(line => line.includes('the Status signal is skipped, not failed')),
    'a move nobody could pay is not charged as a miss',
  );
  assert.ok(
    live.some(line => line.startsWith('the board speaks')),
    `the four paid signals still prove the board: ${live.join(' | ')}`,
  );
});

// ——— the production probe client, against the scripted GitHub ———

/** The board BoardSetupClient reads: Status options in board order (the
 *  human's own board shape, Done mid-array), the Agent field named for the
 *  app, and the ids the probe mutations are addressed with. */
function probeRoutes(
  extra: Record<string, (call: Seen) => Answer> = {},
  issue: Record<string, unknown> = {},
): Record<string, (call: Seen) => Answer> {
  return connectRoutes({
    'POST /repos/acme/shop/issues': () => ({ status: 201, body: { number: 9 } }),
    'POST /repos/acme/shop/issues/9/comments': () => ({ status: 201, body: { id: 701 } }),
    'POST /repos/acme/shop/issues/9/reactions': () => ({ status: 201, body: { id: 501 } }),
    'GET /repos/acme/shop/issues/9/reactions': () => ({
      status: 200,
      body: [{ id: 501, user: { login: 'aivi-agent[bot]', type: 'Bot' } }],
    }),
    'DELETE /repos/acme/shop/issues/9/reactions/501': () => ({ status: 204, body: null }),
    'DELETE /repos/acme/shop/issues/comments/701': () => ({ status: 204, body: null }),
    'GET /repos/acme/shop/issues/9': () => ({ status: 200, body: { state: 'open', state_reason: null, ...issue } }),
    'PATCH /repos/acme/shop/issues/9': () => ({ status: 200, body: { state: 'closed' } }),
    'POST /graphql': graphql({
      BoardSetup: () => ({
        organization: {
          id: 'O_1',
          projectV2: {
            id: 'PVT_1',
            title: 'aivi HQ board',
            fields: {
              nodes: [
                {
                  id: 'F_status',
                  name: 'Status',
                  options: [
                    { id: 'opt_backlog', name: 'Backlog' },
                    { id: 'opt_todo', name: 'Todo' },
                    { id: 'opt_prog', name: 'In Progress' },
                    { id: 'opt_done', name: 'Done' },
                  ],
                },
                { id: 'F_agent', name: 'Agent', options: [{ id: 'opt_aivi', name: 'aivi-agent' }] },
              ],
            },
          },
        },
      }),
      // The card lands on Backlog: GitHub's own default column answers it.
      IssueFacts: () => ({ repository: { issue: issueNode({ number: 9, lane: 'Backlog' }) } }),
      ProbeAddItem: () => ({ addProjectV2ItemById: { item: { id: 'PVTI_9' } } }),
      ProbeSetSelect: () => ({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_9' } } }),
      ProbeClearSelect: () => ({ clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_9' } } }),
      ProbeArchiveItem: () => ({ archiveProjectV2Item: { item: { id: 'PVTI_9' } } }),
    }),
    ...extra,
  });
}

const setupClient = async (routes: Record<string, (call: Seen) => Answer>) => {
  const harness = scripted(routes);
  const app = await connectApp(harness.fetch);
  return { client: new BoardSetupClient(app), ...harness };
};

test('the probe pays the next Status option in board order the card is not on', async () => {
  const { client, bodies } = await setupClient(probeRoutes());
  const board = await client.readBoard(1);
  const probe = await client.openProbe('acme/shop', board);
  assert.deepEqual(probe.asked, ['issue opened', 'card added', 'Agent set', 'comment posted', 'Status moved']);
  assert.equal(probe.statusSkipped, false, 'a board with two options can always show a move');
  const sets = bodies('/graphql')
    .map(v => v.variables)
    .filter(v => v?.optionId);
  // The card landed on Backlog; the paid move is the **next** option in
  // board order — Todo. Not "the first open one": GitHub has no open set.
  assert.deepEqual(
    sets.map(v => [v.fieldId, v.optionId]),
    [
      ['F_status', 'opt_todo'],
      ['F_agent', 'opt_aivi'],
    ],
    'Status moves to the next option in board order, then the Agent field speaks',
  );
});

test('the probe pays its reaction and reads it back — the permission the status surface needs', async () => {
  const { client, calls } = await setupClient(probeRoutes());
  const board = await client.readBoard(1);
  const probe = await client.openProbe('acme/shop', board);
  assert.ok(calls().includes('POST /repos/acme/shop/issues/9/reactions'), 'the eyes is paid');
  assert.ok(calls().includes('GET /repos/acme/shop/issues/9/reactions'), 'and read back');
  assert.ok(probe, 'the reaction is not a signal: no delivery is waited for');
});

test('a reaction that does not land stops the probe with the permission named', async () => {
  const { client } = await setupClient(
    probeRoutes({
      'GET /repos/acme/shop/issues/9/reactions': () => ({ status: 200, body: [] }), // the eyes vanished
    }),
  );
  const board = await client.readBoard(1);
  await assert.rejects(client.openProbe('acme/shop', board), /the eyes reaction did not land/);
});

test('cleanup reports GitHub’s own close when a workflow closed the test card', async () => {
  const { client, calls } = await setupClient(
    probeRoutes({}, { state: 'closed', state_reason: 'completed' }), // GitHub answers the card already closed
  );
  const board = await client.readBoard(1);
  const probe = await client.openProbe('acme/shop', board);
  const rest = await client.closeProbe(probe);
  assert.match(rest, /rests closed by GitHub itself \(completed\)/, "GitHub's answer is said, not aivi's intent");
  assert.ok(!calls().includes('PATCH /repos/acme/shop/issues/9'), 'aivi closes nothing GitHub already closed');
  assert.ok(calls().includes('DELETE /repos/acme/shop/issues/9/reactions/501'), 'the eyes is taken off');
});

test('cleanup closes the card itself when GitHub left it open', async () => {
  const { client, calls, bodies } = await setupClient(probeRoutes());
  const board = await client.readBoard(1);
  const probe = await client.openProbe('acme/shop', board);
  const rest = await client.closeProbe(probe);
  assert.match(rest, /is closed \(not planned\), its card archived, its comment deleted/);
  assert.ok(calls().includes('PATCH /repos/acme/shop/issues/9'), 'aivi paid the close itself');
  const patch = bodies('/repos/acme/shop/issues/9').find(b => b.state === 'closed');
  assert.equal(patch?.state_reason, 'not_planned', 'closed as not planned, the honest reason for a test card');
});
