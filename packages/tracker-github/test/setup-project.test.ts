/** The wizard's lane list: what it asks, in what order, and what it never
 *  asks. GitHub's own `status` on a Status option is the closed-state signal —
 *  `DONE` ends work and is not a lane, the mirror of the Linear ruling of
 *  2026-10-02; the queue rules are that ruling's own words. The board read,
 *  the field creation, and the label are faked at the client crossing, because
 *  the wizard's questions, order and written config are the unit — the GraphQL
 *  round trips are the live gate's. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ProjectLaneInput } from '@aivi/core';
import { GITHUB_WEBHOOK_SECRET_ENV, webhookSignature } from '@aivi/github';
import { PluginSetupCancelled } from '@aivi/plugin';
import {
  boardSuggestion,
  type GithubSetupClient,
  makeContributor,
  markQueue,
  openStatusOptions,
  type ProbeHandles,
  queueCandidates,
  type SetupBoard,
  type SetupBoardOption,
} from '../src/setup-project.ts';
import { GITHUB_WEBHOOK_PATH } from '../src/tracker.ts';

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
 *  client). A question nobody scripted fails loudly. The health gate is asked
 *  of the config.json the context points at: `health: 'down'` (the default)
 *  has no readable file, so the gate question lands first and the script
 *  answers it like any other; `'up'` writes one and the probe runs, its diary
 *  rows signed with `secret` like GitHub signs them. */
const cancel = Symbol('cancel');
const GATE = 'No live aivi answers its health endpoint — the probe watches what a running aivi records';
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
    health?: 'up' | 'down';
    /** Diary rows the fake store answers with — signed deliveries. */
    rows?: { id: number; method: string; path: string; body: string; headers: Record<string, string> }[];
    /** View names the fake client says it changed; [] says all already show. */
    views?: string[];
    /** What the fake openProbe pays: signals asked, and whether Status was. */
    probe?: { asked: string[]; statusSkipped?: boolean };
  } = {},
) => {
  const asked: string[] = [];
  const said: string[] = [];
  const done: string[] = [];
  const live: string[] = [];
  let next = 0;
  const prompt = async (message: string) => {
    asked.push(message);
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
      return (opts.repos ?? ['acme/shop']).map(id => ({ id }));
    },
    async ensureLabel(repo, label) {
      if (opts.labelError) throw new Error(opts.labelError);
      done.push(`label:${repo}:${label}`);
    },
    async openProbe(repo): Promise<ProbeHandles> {
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
    },
  };
  const ctx = {
    config: {},
    configPath,
    forgeConfigured: opts.forgeConfigured ?? false,
    print: () => {},
    prompts: {
      text: async ({ message }: { message: string }) => prompt(message),
      select: async ({ message }: { message: string }) => prompt(message),
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
      log: { message: async (line: string) => void said.push(line) },
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
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test('the wizard walks the board in order: gate, board, repositories, name, one agent per open option, then the one queue question', async t => {
  const { contributor, ctx, asked, said, done, cleanup } = wizard([
    'skip', // the health gate: continue anyway — this aivi has no live server under it
    '1', // the board number
    ['acme/shop'], // multiselect: which repositories feed this project
    '', // project id: blank takes the offered suggestion
    'developer', // Backlog
    '', // Todo: a human lane, the orchestrator's silence
    'developer', // In Progress
    '', // In Review: a human lane
    'Todo', // the queue question
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
    'board order, human lanes bare, the queue marked where the person chose',
  );
  assert.deepEqual(
    asked,
    [
      GATE,
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

test('with a forge configured a working lane is asked whether it works on the ticket branch; without one it never is', async t => {
  const withForge = wizard(['skip', '1', ['acme/shop'], '', 'developer', 'yes', '', 'developer', 'no', '', 'Todo'], {
    forgeConfigured: true,
  });
  t.after(withForge.cleanup);
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
  const withoutForge = wizard(['skip', '1', ['acme/shop'], '', 'developer', '', 'developer', '', 'Todo']);
  t.after(withoutForge.cleanup);
  await withoutForge.contributor.setup(withoutForge.ctx);
  assert.ok(!withoutForge.asked.some(m => /worktree/.test(m)), 'no forge, no worktrees to promise');
});

test('a board without the Agent field is asked before it is touched, and the yes creates it with the app’s own name', async t => {
  const { contributor, ctx, asked, done, said, cleanup } = wizard(
    ['skip', '1', true, ['acme/shop'], '', '', '', '', ''],
    {
      agentField: 'none',
    },
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
  const { contributor, ctx, said, done, cleanup } = wizard(['skip', '1', ['acme/shop'], '', '', '', '', '', ''], {
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
  const { contributor, ctx, done, cleanup } = wizard(['skip', '1', ['acme/shop'], '', '', '', '', '', ''], {
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
  row(1, 'issues', { action: 'opened', number: 9, repository: { full_name: 'acme/shop' } }),
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
const QUESTIONS = ['1', ['acme/shop'], '', 'developer', '', 'developer', '', 'Todo'];

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
    said.some(line => line.startsWith('GitHub has no API to delete an issue')),
    'the no-delete truth is said with the cleanup',
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
  assert.ok(said.some(line => line.startsWith('GitHub has no API to delete an issue')));
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

test('a board with one open Status option skips the Status signal — skipped is said, never failed', async t => {
  secrets(t, { [GITHUB_WEBHOOK_SECRET_ENV]: PROBE_SECRET });
  const four = ALL_ASKED.filter(name => name !== 'Status moved');
  const { contributor, ctx, said, live, cleanup } = wizard(['1', ['acme/shop'], '', 'developer'], {
    health: 'up',
    options: [
      { id: 'o-0', name: 'Todo', status: 'TODO' },
      { id: 'o-4', name: 'Done', status: 'DONE' },
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
