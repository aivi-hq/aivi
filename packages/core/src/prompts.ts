/**
 * The automated prompts aivi sends — the set the operator ruled editable
 * (docs/plans/git-workflow.md, "prompts/"). **Defaults live here**, tested,
 * one source; `aivi setup` and `aivi prompts install` copy them to
 * `<home>/prompts/<name>.md`, never overwriting; the texts are **read at
 * use**, so an edit lands on the next run and deleting the file is instant
 * restoration. The operator may break their server with their own words —
 * allowed, warned, and one `rm` from fixed; our job is the restore path,
 * not a veto.
 *
 * Composition stays code: these texts fill the *guidance slots* around the
 * ticket data. A template that drops a `{slot}` loses that fact from the
 * prompt — allowed, the operator's choice — and a `worker-contract.md`
 * without the completion sentence breaks the run, which is also allowed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PROMPT_NAMES = [
  'worker-contract',
  'nudge',
  'permission-denied',
  'feedback-loop',
  'review-posture',
  'pr-body',
  'escalation',
  'job-result',
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

/** The built-in defaults, in aivi's own words. Grows only by ruling. */
export const promptDefaults: Record<PromptName, string> = {
  'worker-contract':
    'You are an aivi worker for one ticket, working in {directory}. ' +
    'The ticket ends only through a tool call: when it is genuinely resolved, call aivi_work_complete with outcome ' +
    '"success" and a one-line summary; when you could not finish it, call the same tool with outcome "failure". ' +
    'When a person must decide something, give information, or grant permission, call aivi_ask with your question ' +
    'and options when there are clear choices; they answer on the ticket and the answer reaches you as a follow-up. ' +
    'Before you start, post your plan with aivi_plan \u2014 the whole checklist of steps, each with a status \u2014 and ' +
    'send the full list again whenever a step changes; people watch it while you work. ' +
    'Crossing to the remote is always through aivi\u2019s tools, never git push, fetch or pull: aivi_sync for the ' +
    'remote\u2019s latest refs, aivi_push to move your commits, aivi_pr for the pull request. ' +
    'End your turn right after calling aivi_work_complete or aivi_ask; the git and review tools do not end it. ' +
    'A turn that ends without either is treated as a failure. ' +
    'Never declare completion in plain text.',
  nudge:
    'Your turn ended without reporting. If you are finished, call the aivi_work_complete tool ' +
    '(outcome "success" or "failure") with a one-line summary. If you are blocked or need a ' +
    'decision from a person, call the aivi_ask tool with your question. Do not just reply in text.',
  'permission-denied':
    'Permission denied: {action} on {resources} was refused by aivi. Stay inside your working ' +
    'directory; do not look for another path to the same thing. If a person must approve this, ' +
    'call aivi_ask and explain what you need and why; they answer on the ticket.',
  'feedback-loop':
    'This ticket is returning work: the pull request {pull} has unresolved review comments. ' +
    'Process each one by either agreeing (do the work, move it with aivi_push) or disagreeing ' +
    '(leave a grounded comment); both end by answering the thread with aivi_respond_feedback, ' +
    'which resolves it. A thread a person resolved needs no answer: they are authoritative.',
  'review-posture': 'When you review a pull request: request changes for problems, comments for nits.',
  'pr-body': 'Write the pull request body for a human reviewer: what changes and why, in the words a person would use.',
  escalation:
    'Your worker finished, but the pull request {pull} still holds unresolved feedback it owes answers on:\n' +
    '{list}\n' +
    'What should it do? (answer with instructions, resolve the threads here, or say to ship it as-is)',
  'job-result':
    '[aivi delivers the outcome of a scheduled job this conversation asked for. Nobody typed this. ' +
    'Pass it on to the people here: if it is addressed to them (a reminder, a question, a riddle), ' +
    'deliver it as written; otherwise tell them briefly what matters. Do not answer or act on it yourself.]\n' +
    '{text}',
};

/** What every installed copy opens with, so the file says how to leave it. */
export const PROMPT_WARNING =
  '<!-- aivi: this prompt is yours to edit: the next run speaks these words. ' +
  'Delete this file to get the built-in back. -->\n\n';

/** Fill the guidance slots. A template that dropped a slot simply lacks it:
 *  the operator's choice, not an error. */
export function fillPrompt(template: string, slots: Record<string, string>): string {
  let text = template;
  for (const [name, value] of Object.entries(slots)) text = text.replaceAll(`{${name}}`, value);
  return text;
}

export interface PromptInstall {
  /** Copied now, because the home had no file for them. */
  written: PromptName[];
  /** Already there: the operator's own words are never overwritten. */
  kept: PromptName[];
}

/** Install the editable copies into `<home>/prompts/`, never overwriting. */
export async function installPrompts(home: string): Promise<PromptInstall> {
  const dir = join(home, 'prompts');
  await mkdir(dir, { recursive: true });
  const written: PromptName[] = [];
  const kept: PromptName[] = [];
  for (const name of PROMPT_NAMES) {
    const path = join(dir, `${name}.md`);
    try {
      await readFile(path);
      kept.push(name);
      continue;
    } catch {
      // No file yet: the copy goes in below. Anything else than absence
      // would surface from the write itself.
    }
    await writeFile(path, `${PROMPT_WARNING}${promptDefaults[name]}\n`);
    written.push(name);
  }
  return { written, kept };
}

/** Strip the warning header a copy opens with: the worker hears the words,
 *  never the instructions about the file. */
export function stripPromptHeader(text: string): string {
  const comment = /^<!--[\s\S]*?-->\s*/.exec(text);
  return (comment ? text.slice(comment[0].length) : text).trim();
}

/**
 * The effective text, read at use: the operator's file when it holds words,
 * the built-in otherwise. Missing, unreadable or emptied — all say the same
 * thing, "give me the default back", and none is an error.
 */
export async function readPrompt(home: string, name: PromptName): Promise<string> {
  try {
    const text = stripPromptHeader(await readFile(join(home, 'prompts', `${name}.md`), 'utf8'));
    return text || promptDefaults[name];
  } catch {
    return promptDefaults[name];
  }
}
