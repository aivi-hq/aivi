import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as prompts from '@clack/prompts';
import { PluginSetupCancelled, type PluginSetupContext, settled } from '../src/setup.ts';
import { LANE_KIND, laneKindLines } from '../src/setup-project.ts';

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
