import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fillPrompt,
  installPrompts,
  PROMPT_NAMES,
  PROMPT_WARNING,
  promptDefaults,
  readPrompt,
  stripPromptHeader,
} from '@aivi/core';

test('every ruled name has a built-in carrying the slots composition fills', () => {
  assert.deepEqual(
    [...PROMPT_NAMES],
    [
      'worker-contract',
      'nudge',
      'permission-denied',
      'feedback-loop',
      'review-posture',
      'pr-body',
      'escalation',
      'job-result',
    ],
    'the set grows only by ruling',
  );
  for (const name of PROMPT_NAMES) assert.ok(promptDefaults[name].trim().length, `${name} has words`);
  assert.match(promptDefaults['worker-contract'], /\{directory\}/);
  assert.match(
    promptDefaults['worker-contract'],
    /aivi_work_complete/,
    'the completion sentence: the run depends on it',
  );
  assert.match(promptDefaults['feedback-loop'], /\{pull\}/);
  assert.match(promptDefaults['feedback-loop'], /aivi_respond_feedback/);
  assert.match(promptDefaults.escalation, /\{pull\}.*\{list\}/s);
  assert.match(promptDefaults['job-result'], /\{text\}$/);
  assert.match(promptDefaults['review-posture'], /request changes/i);
});

test('fillPrompt fills every slot and a dropped slot is simply absent', () => {
  assert.equal(fillPrompt('a {x} b {x}', { x: '1' }), 'a 1 b 1');
  assert.equal(fillPrompt('keep the {missing} as written', {}), 'keep the {missing} as written');
});

test('installPrompts copies the set once and never overwrites the operator’s words', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-prompts-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const first = await installPrompts(home);
  assert.deepEqual([...first.written].sort(), [...PROMPT_NAMES].sort(), 'a fresh home gets the whole set');
  assert.deepEqual(first.kept, []);
  const file = join(home, 'prompts', 'nudge.md');
  const installed = await readFile(file, 'utf8');
  assert.ok(installed.startsWith(PROMPT_WARNING), 'the copy opens with the warning header');
  assert.match(installed, /Delete this file to get the built-in back/);

  await writeFile(file, 'Speak softly.\n');
  const second = await installPrompts(home);
  assert.deepEqual(second.written, [], 'an existing file is nobody’s to overwrite');
  assert.deepEqual([...second.kept].sort(), [...PROMPT_NAMES].sort());
  assert.equal(await readFile(file, 'utf8'), 'Speak softly.\n');
});

test('the warning header is file instruction, never prompt text', () => {
  assert.equal(stripPromptHeader(`${PROMPT_WARNING}Hello.\n`), 'Hello.');
  assert.equal(stripPromptHeader('No header here.'), 'No header here.');
});

test('readPrompt reads at use: edits land, deletes restore, and nothing in between is an error', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-prompts-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(await readPrompt(home, 'nudge'), promptDefaults.nudge, 'a home with no prompts/ speaks the built-in');
  await installPrompts(home);
  assert.equal(
    await readPrompt(home, 'nudge'),
    promptDefaults.nudge,
    'the fresh copy speaks the built-in words, header stripped',
  );

  const file = join(home, 'prompts', 'nudge.md');
  await writeFile(file, `${PROMPT_WARNING}Second chances are free.\n`);
  assert.equal(await readPrompt(home, 'nudge'), 'Second chances are free.', 'the edit lands on the next read');

  await writeFile(file, '   \n');
  assert.equal(
    await readPrompt(home, 'nudge'),
    promptDefaults.nudge,
    'an emptied file asks for the default and gets it',
  );

  await rm(file);
  assert.equal(await readPrompt(home, 'nudge'), promptDefaults.nudge, 'delete is instant restoration');
});
