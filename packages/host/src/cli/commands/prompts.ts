/** The prompts: the texts aivi speaks by itself — worker contract, nudge,
 *  feedback loop, review posture, PR body, escalation, job-result. The
 *  built-ins live in `@aivi/core`; the home's `prompts/` copies are the
 *  operator's words, read at use: an edit lands on the next run, and
 *  deleting a file is instant restoration (docs/plans/git-workflow.md).
 *  This command is the sight and the copy-step: list, install, show. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPrompts, PROMPT_NAMES, type PromptName, readPrompt, stripPromptHeader } from '@aivi/core';
import type { Command } from 'commander';
import { home, print } from '../context.ts';

const promptsDir = join(home, 'prompts');

/** Where one name's words come from right now: the home's file when it
 *  holds words, the built-in otherwise — the same reading `readPrompt` gives. */
function promptSource(name: PromptName): 'file' | 'built-in' {
  try {
    return stripPromptHeader(readFileSync(join(promptsDir, `${name}.md`), 'utf8')) ? 'file' : 'built-in';
  } catch {
    return 'built-in';
  }
}

export function registerPrompts(program: Command): void {
  const prompts = program
    .command('prompts')
    .description('The automated texts aivi speaks: list them, install editable copies, or show one')
    .helpGroup('Server')
    .action(() => {
      print(PROMPT_NAMES.map(name => ({ name, source: promptSource(name), path: join(promptsDir, `${name}.md`) })));
    });
  prompts
    .command('install')
    .description(
      "Copy the built-in texts into the home for editing; a file that is already there is nobody's to overwrite",
    )
    .action(async () => {
      const { written, kept } = await installPrompts(home);
      print({ written, kept }, [
        {
          type: 'log',
          text: written.length
            ? `Installed: ${written.join(', ')}.`
            : 'Nothing to install: every copy is already in the home.',
        },
        { type: 'log', text: `Edit them under ${promptsDir}; delete a file to get the built-in back.` },
      ]);
    });
  prompts
    .command('show <name>')
    .description(
      "The words aivi speaks today for one prompt: the home's file when it holds them, the built-in otherwise",
    )
    .action(async (name: string) => {
      if (!(PROMPT_NAMES as readonly string[]).includes(name))
        throw new Error(`Unknown prompt: ${name}. The set is: ${PROMPT_NAMES.join(', ')}.`);
      const text = await readPrompt(home, name as PromptName);
      print({ name, source: promptSource(name as PromptName), text }, text);
    });
}
