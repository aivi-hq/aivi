import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as prompts from '@clack/prompts';
import { PluginSetupCancelled, type PluginSetupContext, pollWithin, settled } from '../src/setup.ts';
import { askAgentLane, LANE_KIND, laneKindLines, type ProjectSetupContext } from '../src/setup-project.ts';

const ctx = { prompts } as PluginSetupContext;

test('settled stops setup for cancellation and an empty submission', () => {
  assert.throws(
    () => settled(ctx, prompts.CANCEL_SYMBOL),
    error => error instanceof PluginSetupCancelled && error.message === 'a prompt was cancelled',
  );
  assert.throws(
    () => settled(ctx, undefined),
    error => error instanceof PluginSetupCancelled && error.message === 'a prompt was submitted empty',
  );
});

test('settled returns actual answers unchanged, including false and zero', () => {
  for (const answer of ['chosen', false, 0, ['dev'], { value: 'human' }]) assert.equal(settled(ctx, answer), answer);
});

test('pollWithin looks at once, again after every pause, and once more when the window ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let looks = 0;
  const waited = pollWithin({ windowMs: 5000, pollMs: 2000 }, () => {
    looks++;
  });
  assert.equal(looks, 1, 'what arrived before the watching began is seen at once');
  t.mock.timers.tick(2000);
  t.mock.timers.tick(2000);
  assert.equal(looks, 3, 'and again after every pause');
  t.mock.timers.tick(1000);
  await waited;
  assert.equal(looks, 4, 'the window ends with one last look, so a late tick loses nothing');
  t.mock.timers.tick(60_000);
  assert.equal(looks, 4, 'and no timer outlives the verdict');
});

test('pollWithin ends when a read has what it waited for, with that read looked at once more', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let looks = 0;
  const waited = pollWithin({ windowMs: 90_000, pollMs: 2000 }, stop => {
    looks++;
    if (looks === 2) stop();
  });
  t.mock.timers.tick(2000);
  await waited;
  assert.equal(looks, 3, 'the stop looks once more, and a read that stops again changes nothing');
  t.mock.timers.tick(90_000);
  assert.equal(looks, 3, 'neither the next pause nor the window fires after the verdict');
});

const failures: Array<[when: string, failingLook: number, advance: number[]]> = [
  ['at the first look', 1, []],
  ['after a pause', 2, [2000]],
  ['at the end of the window', 3, [2000, 1000]],
];
for (const [when, failingLook, advance] of failures) {
  test(`pollWithin fails with the error of a read that throws ${when}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let looks = 0;
    const waited = assert.rejects(
      pollWithin({ windowMs: 3000, pollMs: 2000 }, () => {
        if (++looks === failingLook) throw new Error('the diary is unreadable');
      }),
      /the diary is unreadable/,
    );
    for (const ms of advance) t.mock.timers.tick(ms);
    await waited;
    t.mock.timers.tick(60_000);
    assert.equal(looks, failingLook, 'and no look follows the failure');
  });
}

test('the lane explanation includes each offered answer and prepends an optional platform note once', () => {
  const lines = laneKindLines();
  assert.equal(lines[0], 'Every option is asked, in board order. What each answer means:');
  for (const kind of Object.values(LANE_KIND)) assert.equal(lines.filter(line => line === `  ${kind.label}`).length, 1);
  assert.match(lines.at(-1)!, /A queue is where tickets wait/);
  assert.deepEqual(laneKindLines('GitHub cannot explain these lanes.'), [
    'GitHub cannot explain these lanes.',
    ...lines,
  ]);
});

const cancelled = Symbol('cancelled');

/** A project-setup context that answers its questions in order, and records them. */
function laneContext(answers: unknown[], forgeConfigured: boolean) {
  const asked: string[] = [];
  const ask = async (question: { message: string }) => {
    asked.push(question.message);
    return answers.shift();
  };
  const ctx = {
    forgeConfigured,
    prompts: { autocomplete: ask, select: ask, isCancel: (value: unknown) => value === cancelled },
  } as unknown as ProjectSetupContext;
  return { ctx, asked };
}

test('an agent lane asks which agent works it and, with a forge, whether on the ticket’s branch; only a yes is a worktree', async () => {
  const yes = laneContext(['reviewer', 'yes'], true);
  assert.deepEqual(await askAgentLane(yes.ctx, 'Review', ['reviewer']), { agent: 'reviewer', worktree: true });
  assert.deepEqual(yes.asked, [
    'Which OpenCode agent works the "Review" lane?',
    'Does work in the "Review" lane happen on the ticket\'s branch (git worktree)?',
  ]);

  const no = laneContext([' builder ', 'no'], true);
  assert.deepEqual(await askAgentLane(no.ctx, 'Build', ['builder']), { agent: 'builder', worktree: false });
});

test('without a forge, or without an agent named, there is no branch question', async () => {
  const bare = laneContext(['builder'], false);
  assert.deepEqual(await askAgentLane(bare.ctx, 'Build', ['builder']), { agent: 'builder', worktree: false });
  assert.equal(bare.asked.length, 1);

  const unnamed = laneContext(['  '], true);
  assert.deepEqual(await askAgentLane(unnamed.ctx, 'Build', ['builder']), { agent: '', worktree: false });
  assert.equal(unnamed.asked.length, 1);
});

test('a cancelled agent pick or branch answer stops the lane setup', async () => {
  for (const answers of [[cancelled], ['builder', cancelled]])
    await assert.rejects(
      askAgentLane(laneContext(answers, true).ctx, 'Build', ['builder']),
      error => error instanceof PluginSetupCancelled && error.message === 'lane setup incomplete',
    );
});
