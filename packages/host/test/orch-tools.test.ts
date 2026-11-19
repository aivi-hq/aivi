import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewFacts } from '@aivi/plugin/forge';
import { ToolError } from '../src/tools.ts';
import { call, fakeForge, type GitAnswers, pull, scriptedGit, seeded, world } from './orch-fixture.ts';

const success = { outcome: 'success', summary: 'done' };

const refusal = (status: number, message: string) => (error: unknown) =>
  error instanceof ToolError && error.status === status && error.message === message;

const ended = 'This run already ended (completed).';
const tools = [
  { name: 'aivi_work_complete', tool: 'completeTool', input: success, ended },
  {
    name: 'aivi_ask',
    tool: 'askTool',
    input: { question: 'Which shade?' },
    ended: 'Cannot ask while the run is completed.',
  },
  { name: 'aivi_plan', tool: 'planTool', input: { steps: [{ content: 'Look', status: 'pending' }] }, ended },
  { name: 'aivi_push', tool: 'pushTool', input: {}, ended },
  { name: 'aivi_sync', tool: 'syncTool', input: {}, ended },
  { name: 'aivi_pr', tool: 'prTool', input: { title: 'Widget' }, ended },
  { name: 'aivi_review', tool: 'reviewTool', input: {}, ended },
  { name: 'aivi_respond_feedback', tool: 'respondTool', input: { body: 'Done' }, ended },
  { name: 'aivi_submit_review', tool: 'submitReviewTool', input: { body: 'Fine', state: 'COMMENT' }, ended },
] as const;

for (const { name, tool, input, ended } of tools) {
  test(`${name} refuses a session that is not an aivi run, and a run that already ended`, async () => {
    const w = world();
    await assert.rejects(
      () => w.orchestrator[tool]({ sessionId: 'ses_unknown', input }),
      refusal(404, `This session is not an aivi run; ${name} is not available here.`),
    );

    const run = seeded(w);
    await w.orchestrator.completeTool(call(run, success));
    await assert.rejects(() => w.orchestrator[tool](call(run, input)), refusal(409, ended));
  });
}

const reports = [
  { input: { outcome: 'success' }, outcome: { kind: 'success', summary: 'Completed.' } },
  { input: { outcome: 'success', summary: 7 }, outcome: { kind: 'success', summary: 'Completed.' } },
  { input: { outcome: 'success', summary: 'shipped' }, outcome: { kind: 'success', summary: 'shipped' } },
  { input: { outcome: 'failure' }, outcome: { kind: 'failure', reason: 'The worker reported failure.' } },
  { input: { outcome: 'failure', summary: 'stuck' }, outcome: { kind: 'failure', reason: 'stuck' } },
];

for (const { input, outcome } of reports) {
  test(`aivi_work_complete with ${JSON.stringify(input)} ends the run as ${outcome.kind}: ${JSON.stringify(outcome)}`, async () => {
    const w = world();
    const run = seeded(w);

    assert.deepEqual(await w.orchestrator.completeTool(call(run, input)), { recorded: true, outcome: outcome.kind });

    assert.deepEqual(w.ledger.get(run.id)?.outcome, outcome);
  });
}

test('aivi_work_complete refuses an outcome that is neither success nor failure, and the run goes on', async () => {
  const w = world();
  const run = seeded(w);

  for (const input of [{}, { outcome: 'maybe' }])
    await assert.rejects(
      () => w.orchestrator.completeTool(call(run, input)),
      refusal(400, 'outcome must be "success" or "failure".'),
    );

  assert.equal(w.ledger.get(run.id)?.state, 'working');
});

test('aivi_ask refuses a question that is blank or not words', async () => {
  const w = world();
  const run = seeded(w);

  for (const input of [{}, { question: '   ' }, { question: 5 }])
    await assert.rejects(() => w.orchestrator.askTool(call(run, input)), refusal(400, 'question is required.'));
});

test('aivi_ask offers only the options that have a label and a value, as suggestions and not a cage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world();
  const run = seeded(w);
  const options = [{ label: 'Deep', value: 'deep' }, { label: 'no value' }, null, { value: 'no label' }, 'text'];

  assert.deepEqual(await w.orchestrator.askTool(call(run, { question: ' Which shade? ', options })), {
    delivered: true,
    endYourTurn: true,
  });

  assert.deepEqual(w.opencode.session.form.create.mock.calls[0]?.arguments[0], {
    sessionID: run.sessionId,
    title: 'Which shade?',
    fields: [
      {
        key: 'answer',
        type: 'string',
        title: 'Which shade?',
        required: true,
        options: [{ value: 'deep', label: 'Deep' }],
        custom: true,
      },
    ],
  });
  assert.deepEqual(w.tracker.question.mock.calls[0]?.arguments[1], {
    question: 'Which shade?',
    options: [{ label: 'Deep', value: 'deep' }],
    formId: 'form_1',
  });
});

test('aivi_ask without usable options asks for free text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world();
  const run = seeded(w);

  await w.orchestrator.askTool(call(run, { question: 'Which shade?', options: 'whichever' }));

  assert.deepEqual(w.opencode.session.form.create.mock.calls[0]?.arguments[0].fields, [
    { key: 'answer', type: 'string', title: 'Which shade?', required: true },
  ]);
  assert.deepEqual(w.tracker.question.mock.calls[0]?.arguments[1], { question: 'Which shade?', formId: 'form_1' });
});

const stepsRefused = 'every step needs content and a status of pending, inProgress, completed or canceled.';
const noSteps = 'steps must hold at least one step.';
const plans: [unknown, string][] = [
  [{}, noSteps],
  [{ steps: [] }, noSteps],
  [{ steps: 'later' }, noSteps],
  [{ steps: [{ content: '   ', status: 'pending' }] }, stepsRefused],
  [{ steps: [{ content: 5, status: 'pending' }] }, stepsRefused],
  [{ steps: [{ content: 'Look', status: 'later' }] }, stepsRefused],
  [{ steps: [{ content: 'Look' }] }, stepsRefused],
  [{ steps: [null] }, stepsRefused],
];

for (const [input, message] of plans) {
  test(`aivi_plan refuses ${JSON.stringify(input)}`, async () => {
    const w = world();
    const run = seeded(w);

    await assert.rejects(
      () => w.orchestrator.planTool(call(run, input as Record<string, unknown>)),
      refusal(400, message),
    );

    assert.equal(w.tracker.plan.mock.callCount(), 0);
  });
}

test('aivi_plan forwards the whole plan to the tracker, its steps trimmed', async () => {
  const w = world();
  const run = seeded(w);
  const steps = [
    { content: ' Look ', status: 'inProgress' },
    { content: 'Fix', status: 'pending' },
  ];

  assert.deepEqual(await w.orchestrator.planTool(call(run, { steps })), { recorded: true, steps: 2 });

  assert.deepEqual(w.tracker.plan.mock.calls[0]?.arguments[1], {
    steps: [
      { content: 'Look', status: 'inProgress' },
      { content: 'Fix', status: 'pending' },
    ],
  });
});

/** A run on branch `me/t-1` in a project whose remote a scripted forge owns. */
function onBranch(answers: GitAnswers = {}) {
  const w = world({ deps: { git: scriptedGit({ 'symbolic-ref --quiet --short HEAD': 'me/t-1', ...answers }) } });
  const forge = fakeForge();
  w.forges.register(forge);
  return { w, forge, run: seeded(w) };
}

test('the tools that talk to the forge refuse input that lacks its words, before they ask anybody', async () => {
  const { w, forge, run } = onBranch();
  const needsFinding = 'each finding needs a path and a body: what you found, on which file.';
  const noBody = 'body is required: what you say to the feedback, grounded in the work.';
  const review = { body: 'Fine', state: 'COMMENT' };

  const refused: [() => Promise<unknown>, string][] = [
    [() => w.orchestrator.prTool(call(run, {})), 'title is required.'],
    [() => w.orchestrator.prTool(call(run, { title: 4 })), 'title is required.'],
    [() => w.orchestrator.respondTool(call(run, {})), noBody],
    [() => w.orchestrator.respondTool(call(run, { body: '  ' })), noBody],
    [() => w.orchestrator.submitReviewTool(call(run, {})), 'body is required: the review, in words a human reads.'],
    [
      () => w.orchestrator.submitReviewTool(call(run, { body: 'Fine' })),
      'state is required: COMMENT or REQUEST_CHANGES. Approval stays a human button.',
    ],
    [() => w.orchestrator.submitReviewTool(call(run, { ...review, findings: [{ body: 'no file' }] })), needsFinding],
    [() => w.orchestrator.submitReviewTool(call(run, { ...review, findings: [{ path: 'a.ts' }] })), needsFinding],
    [() => w.orchestrator.submitReviewTool(call(run, { ...review, findings: [{ path: 7, body: 'x' }] })), needsFinding],
  ];
  for (const [tool, message] of refused) await assert.rejects(tool, refusal(400, message));

  assert.equal(forge.prForBranch.mock.callCount(), 0);
});

test('a plain answer to feedback ignores a thread id that is not text, and a review without findings posts none', async () => {
  const { w, forge, run } = onBranch();
  forge.prForBranch.does(async () => pull());

  assert.deepEqual(await w.orchestrator.respondTool(call(run, { body: 'Rebased.', threadId: 7 })), {
    commented: true,
    pull: pull().url,
  });
  assert.deepEqual(
    await w.orchestrator.submitReviewTool(call(run, { body: 'Fine', state: 'COMMENT', findings: 'none' })),
    {
      reviewed: true,
      state: 'COMMENT',
      findings: 0,
    },
  );

  assert.deepEqual(forge.commentPr.mock.calls[0]?.arguments[2], { author: 'dev', text: 'Rebased.' });
  assert.deepEqual(forge.submitReview.mock.calls[0]?.arguments[2], { author: 'dev', body: 'Fine', state: 'COMMENT' });
});

test('a finding keeps its line only when the line is a number', async () => {
  const { w, forge, run } = onBranch();
  forge.prForBranch.does(async () => pull());
  const findings = [
    { path: 'a.ts', line: 7, body: ' Unbounded ' },
    { path: 'b.ts', line: '9', body: 'Off by one' },
  ];

  await w.orchestrator.submitReviewTool(call(run, { body: 'Two', state: 'REQUEST_CHANGES', findings }));

  assert.deepEqual(forge.submitReview.mock.calls[0]?.arguments[2], {
    author: 'dev',
    body: 'Two',
    state: 'REQUEST_CHANGES',
    comments: [
      { path: 'a.ts', line: 7, body: 'Unbounded' },
      { path: 'b.ts', body: 'Off by one' },
    ],
  });
});

const noPull: [string, GitAnswers, ReturnType<typeof pull> | undefined, string][] = [
  [
    'a detached HEAD',
    { 'symbolic-ref --quiet --short HEAD': { fail: '' } },
    undefined,
    'This run sits on a detached HEAD; no branch, no pull request to read.',
  ],
  [
    'a branch with no pull request',
    {},
    undefined,
    'No open pull request stands for me/t-1: aivi_pr opens one when the work is ready.',
  ],
  [
    'a branch whose last pull request is closed',
    {},
    pull({ state: 'merged' }),
    'No open pull request stands for me/t-1 (the last one is merged): aivi_pr opens one when the work is ready.',
  ],
];

for (const [name, answers, existing, message] of noPull) {
  test(`the tools that read the pull request say plainly that ${name} has none to read`, async () => {
    const { w, forge, run } = onBranch(answers);
    forge.prForBranch.does(async () => existing);

    for (const tool of [w.orchestrator.reviewTool, w.orchestrator.respondTool, w.orchestrator.submitReviewTool])
      await assert.rejects(() => tool(call(run, { body: 'Fine', state: 'COMMENT' })), refusal(409, message));
  });
}

test('aivi_review gives the pull request fresh: threads with their replies, comments, approvals and mergeability', async () => {
  const { w, forge, run } = onBranch();
  const octocat = { login: 'octocat', bot: false };
  const aivi = { login: 'aivi[bot]', worker: 'dev', bot: true };
  const facts: ReviewFacts = {
    pr: pull({ mergeable: 'dirty' }),
    reviews: [{ author: octocat, state: 'CHANGES_REQUESTED' }],
    threads: [
      {
        id: 'T1',
        path: 'src/a.ts',
        state: 'open',
        question: 'Why   is\nthis nil?',
        replies: [
          { author: octocat, body: 'Because.' },
          { author: aivi, body: 'Fixed.' },
        ],
      },
      { id: 'T2', state: 'open', question: 'x'.repeat(4_500), replies: [] },
    ],
    comments: [
      { author: octocat, body: 'Nice', createdAt: '2026-11-18T10:00:00Z' },
      { author: aivi, body: 'Ack', createdAt: '2026-11-18T11:00:00Z' },
    ],
  };
  forge.prForBranch.does(async () => pull());
  forge.reviewFeedback.does(async () => facts);

  assert.deepEqual(await w.orchestrator.reviewTool(call(run)), {
    pull: pull().url,
    state: 'open',
    mergeable: 'dirty',
    threads: [
      {
        id: 'T1',
        path: 'src/a.ts',
        state: 'open',
        question: 'Why is this nil?',
        replies: [
          { author: 'octocat', body: 'Because.' },
          { author: 'aivi[bot]', worker: 'dev', body: 'Fixed.' },
        ],
      },
      { id: 'T2', state: 'open', question: `${'x'.repeat(4_000)}…`, replies: [] },
    ],
    comments: [
      { author: 'octocat', body: 'Nice', createdAt: '2026-11-18T10:00:00Z' },
      { author: 'aivi[bot]', worker: 'dev', body: 'Ack', createdAt: '2026-11-18T11:00:00Z' },
    ],
    reviews: [{ author: 'octocat', state: 'CHANGES_REQUESTED' }],
  });
});
