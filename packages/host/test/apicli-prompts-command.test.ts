/** The prompts commands as a unit: where each prompt's words come from, what
 *  install copies into the home and says about it, and what show prints. The
 *  home's context is a module mock that names a scratch home; `print` is its
 *  recorder, so nothing here writes to the terminal. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, mock, type TestContext, test } from 'node:test';
import { installPrompts, PROMPT_NAMES, promptDefaults } from '@aivi/core';
import { parse, scratchDir } from './apicli-fixture.ts';

const world = { home: '' };
const print = mock.fn();

mock.module('../src/cli/context.ts', { exports: { home: () => world.home, print } });

const { registerPrompts } = await import('../src/cli/commands/prompts.ts');

beforeEach(() => print.mock.resetCalls());

/** A home with no prompts in it yet, removed when the test ends. */
async function scratchHome(t: TestContext): Promise<string> {
  world.home = await scratchDir(t, 'aivi-prompts-command-');
  return world.home;
}

const printed = () => print.mock.calls.map(call => call.arguments);

test('install copies every built-in text into a bare home and says which, then that nothing is left to copy', async t => {
  const home = await scratchHome(t);
  await parse(registerPrompts, 'prompts', 'install');
  await parse(registerPrompts, 'prompts', 'install');
  assert.deepEqual(printed(), [
    [
      { written: [...PROMPT_NAMES], kept: [] },
      [
        { type: 'log', text: `Installed: ${PROMPT_NAMES.join(', ')}.` },
        { type: 'log', text: `Edit them under ${join(home, 'prompts')}; delete a file to get the built-in back.` },
      ],
    ],
    [
      { written: [], kept: [...PROMPT_NAMES] },
      [
        { type: 'log', text: 'Nothing to install: every copy is already in the home.' },
        { type: 'log', text: `Edit them under ${join(home, 'prompts')}; delete a file to get the built-in back.` },
      ],
    ],
  ]);
});

test('a copy the operator emptied is no copy: the list and show both say built-in', async t => {
  const home = await scratchHome(t);
  await installPrompts(home);
  await writeFile(join(home, 'prompts', 'nudge.md'), '');
  await parse(registerPrompts, 'prompts');
  const rows = printed()[0]![0] as { name: string; source: string; path: string }[];
  assert.deepEqual(
    rows.map(row => [row.name, row.source]),
    PROMPT_NAMES.map(name => [name, name === 'nudge' ? 'built-in' : 'file']),
  );
  assert.equal(rows[1]!.path, join(home, 'prompts', 'nudge.md'));

  await parse(registerPrompts, 'prompts', 'show', 'nudge');
  assert.deepEqual(printed()[1], [
    { name: 'nudge', source: 'built-in', text: promptDefaults.nudge },
    promptDefaults.nudge,
  ]);
});
