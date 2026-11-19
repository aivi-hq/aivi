import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewFacts } from '@aivi/plugin/forge';
import { ToolError } from '../src/tools.ts';
import { call, fails, fakeForge, pull, scriptedGit, seeded, started, words, world } from './orch-fixture.ts';

const success = { outcome: 'success', summary: 'done' };
const author = { login: 'octocat', bot: false };
const intro =
  '[aivi started this run for you (project p, lane "Doing"). You work in the project\'s checkout /checkout; the agent file says what you may change.]';
const commentsHeading =
  'Plain comments on the pull request (answer them in the conversation too; aivi_review has the full text):';
const comments = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    author: { login: `user${i}`, bot: false },
    body: `comment ${i}`,
    createdAt: '2026-11-18T10:00:00Z',
  }));

/** The walk starts a run over a pull request the forge reports as `facts`, on the branch the tracker names:
 *  what comes back is the first prompt, split into its paragraphs. */
async function startedOver(facts: Partial<ReviewFacts>) {
  const w = world({ deps: { prompt: words() } });
  const forge = fakeForge();
  w.forges.register(forge);
  forge.prForBranch.does(async () => pull());
  forge.reviewFeedback.does(async () => ({ pr: pull(), reviews: [], threads: [], comments: [], ...facts }));
  w.tracker.tickets.does(async () => [{ id: 't-1', blocked: false }]);
  w.tracker.initWork.does(async () => ({ summary: 'do t-1', branch: 'me/t-1' }));

  await w.orchestrator.wake('p');
  await w.tracker.startWork.next();

  const [first] = await w.opencode.session.prompt.next();
  return { run: w.ledger.activeByTicket('test-tracker', 't-1')!, told: first.text.split('\n\n'), w };
}

test('a run that starts over an open pull request is told what it owes: threads, recent comments, and a merge that is not clean', async () => {
  const { w, run, told } = await startedOver({
    pr: pull({ mergeable: 'dirty' }),
    threads: [
      { id: 'T1', path: 'src/a.ts', state: 'open', question: 'Why   is this\nnil?', replies: [] },
      { id: 'T2', state: 'open', question: 'x'.repeat(600), replies: [] },
    ],
    comments: comments(12),
  });

  const guidance = [
    `REVIEWED ${pull().url}`,
    '- [T1] src/a.ts: Why is this nil?',
    `- [T2] ${'x'.repeat(500)}…`,
    commentsHeading,
    ...Array.from({ length: 10 }, (_, i) => `- user${i + 2}: comment ${i + 2}`),
    '(2 older comments: aivi_review)',
    'The pull request does not merge cleanly into its base right now: integrate before you finish — aivi_sync, then merge or rebase with your git.',
  ].join('\n');
  assert.deepEqual(told, [intro, 'do t-1', guidance, 'POSTURE\nPRBODY', 'CONTRACT /checkout']);
  assert.deepEqual(w.ledger.get(run.id)?.feedback, { openThreadIds: ['T1', 'T2'], attempts: 0, escalated: false });
});

test('a pull request with a few plain comments and no thread lists them all, owes nothing, and mentions no older ones', async () => {
  const { w, run, told } = await startedOver({ comments: comments(3) });

  const guidance = [commentsHeading, '- user0: comment 0', '- user1: comment 1', '- user2: comment 2'].join('\n');
  assert.deepEqual(told, [intro, 'do t-1', guidance, 'POSTURE\nPRBODY', 'CONTRACT /checkout']);
  assert.equal(w.ledger.get(run.id)?.feedback, undefined, 'no thread is open: nothing is ever owed');
});

test('empty writing-style prompts leave no empty paragraph in the first prompt', async () => {
  const w = world({ deps: { prompt: words({ 'review-posture': '', 'pr-body': '' }) } });

  await started(w);

  assert.deepEqual(w.opencode.session.prompt.mock.calls[0]?.arguments[0].text.split('\n\n'), [
    intro,
    'delegated t-1',
    'CONTRACT /checkout',
  ]);
});

/** A run that started over one open thread, `T1`, on branch `me/t-1`, ready to report done. */
function owing(options: { forge?: boolean; head?: string | { fail: string } } = {}) {
  const { forge: forged = true, head = 'me/t-1' } = options;
  const w = world({ deps: { git: scriptedGit({ 'symbolic-ref --quiet --short HEAD': head }), prompt: words() } });
  const forge = fakeForge();
  if (forged) w.forges.register(forge);
  forge.prForBranch.does(async () => pull());
  forge.reviewFeedback.does(async (_repo, pr) => ({
    pr,
    reviews: [],
    comments: [],
    threads: [{ id: 'T1', state: 'open', question: 'Why is this nil?', replies: [{ author, body: 'Hm.' }] }],
  }));
  const run = seeded(w);
  w.ledger.snapshotFeedback(run.id, ['T1']);
  return { w, forge, run };
}

const cannotRead =
  'The feedback gate cannot read the pull request right now (this run has no forge or no branch to ask by); call aivi_work_complete again.';

for (const [lacks, options] of [
  ['no forge', { forge: false }],
  ['no branch', { head: { fail: '' } }],
] as const) {
  test(`the gate refuses to guess when the run has ${lacks}: it asks the worker to report again`, async () => {
    const { w, run } = owing(options);

    await assert.rejects(
      () => w.orchestrator.completeTool(call(run, success)),
      (error: unknown) => error instanceof ToolError && error.status === 502 && error.message === cannotRead,
    );

    assert.equal(w.ledger.get(run.id)?.state, 'working');
  });
}

test('a pull request that is no longer open owes nothing: the completion goes through', async () => {
  const { w, forge, run } = owing();
  forge.prForBranch.does(async () => pull({ state: 'merged' }));

  assert.deepEqual(await w.orchestrator.completeTool(call(run, success)), { recorded: true, outcome: 'success' });

  assert.equal(forge.reviewFeedback.mock.callCount(), 0);
});

test('a forge that cannot be read at the gate is said, and the worker is asked to report again', async () => {
  const { w, forge, run } = owing();
  forge.reviewFeedback.does(fails(new Error('the forge is down')));

  await assert.rejects(
    () => w.orchestrator.completeTool(call(run, success)),
    (error: unknown) =>
      error instanceof ToolError &&
      error.status === 502 &&
      error.message ===
        `The feedback gate could not read ${pull().url} this time: the forge is down. Call aivi_work_complete again.`,
  );

  assert.equal(w.ledger.get(run.id)?.state, 'working');
});

test('the gate lists an owed thread that names no file by its words alone, and counts the refusal', async () => {
  const { w, run } = owing();

  await assert.rejects(
    () => w.orchestrator.completeTool(call(run, success)),
    (error: unknown) =>
      error instanceof ToolError &&
      error.status === 409 &&
      error.message.includes('\n- Why is this nil? (id T1)\n') &&
      error.message.includes('This refusal is 1 of 3'),
  );

  assert.equal(w.ledger.get(run.id)?.feedback?.attempts, 1);
});

test('when the person cannot be asked at the third refusal the strike stands, and the next refusal asks again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, run } = owing();
  const failure = new Error('OpenCode is down');
  w.opencode.session.form.create.does(fails(failure));
  const refused = () =>
    assert.rejects(
      () => w.orchestrator.completeTool(call(run, success)),
      (error: unknown) => error instanceof ToolError && error.status === 409,
    );

  for (const _strike of [1, 2, 3]) await refused();

  assert.deepEqual(w.log.said('warn').at(-1), {
    level: 'warn',
    event: 'run.feedback.form.failed',
    run: run.id,
    error: failure,
  });
  assert.equal(w.ledger.get(run.id)?.state, 'working', 'no question was parked');
  assert.deepEqual(w.ledger.get(run.id)?.feedback, { openThreadIds: ['T1'], attempts: 3, escalated: false });

  w.opencode.session.form.create.does(async () => ({ id: 'form_9' }));
  await refused();

  assert.equal(w.ledger.get(run.id)?.state, 'awaiting_input', 'now the person has been asked');
  assert.deepEqual(w.ledger.get(run.id)?.feedback, {
    openThreadIds: ['T1'],
    attempts: 4,
    escalated: true,
    formId: 'form_9',
  });
});
