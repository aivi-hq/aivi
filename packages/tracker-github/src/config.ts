/** The GitHub tracker's registry declaration, at its `./config` subpath: the
 *  module id, the block's own schema, and the bridge to the module code. The
 *  CLI imports this for every command, so nothing here pulls octokit.
 *
 *  One board is one project's whole board (ruled 2026-10-07): the block names
 *  the projectsV2 board by number, the repositories whose issues feed it, and
 *  nothing else. The **lanes are core's** (`projects.<id>.lanes`, ordered);
 *  they map onto the board's own `Status` options, and aivi never creates or
 *  renames one (D4) — a lane whose option is missing is said, never guessed
 *  past. The `Agent` single-select field is aivi's own (D5): apps cannot be
 *  assignees (proven 403), so the board carries the delegate in a field aivi
 *  created. The app's identity is the environment's — `GITHUB_APP_ID` and
 *  `GITHUB_APP_PRIVATE_KEY` in `<home>/.env`, shared with the forge through
 *  `@aivi/github`.
 */
import { PROJECT_ID } from '@aivi/core';
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

const id = z.string().regex(PROJECT_ID);

/** The module id: the key of this plugin's block in `config.json`
 *  (`plugins.tracker-github`), its `/status` id and its log category — the
 *  package's short name, ruled 2026-09-30. What deliberately keeps the
 *  shorter `github` is everything naming the **platform**: the SQLite table
 *  prefix, the conversation prefix (`github:…`), the webhook route
 *  (`/github/webhooks`) and the session origin. */
export const MODULE_ID = 'tracker-github';

/** The board's own field names, as aivi created them (D5): the delegate
 *  lives in `Agent`, the lane lives in `Status`. One pair of names for every
 *  board; a board that lacks them fails setup with the remedy, not a guess. */
export const STATUS_FIELD = 'Status';
export const AGENT_FIELD = 'Agent';

export const githubSchema = z.strictObject({
  agent: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The OpenCode agent that answers people on GitHub — comment mentions no run is working: the assistant. Default: the aivi name.',
    ),
  humanLabel: z
    .string()
    .min(1)
    .default('needs-human')
    .describe('Issues carrying this label are never worked automatically; setup creates it in each mapped repository.'),
  pool: id.default('default').describe('Dispatcher pool an assistant turn takes a slot in.'),
  progress: z
    .enum(['silent', 'status', 'tools'])
    .default('tools')
    .describe('What the status comment shows while a worker runs: silent, the one line, or the line with its tool.'),
  trust: z
    .enum(['members', 'everyone'])
    .default('members')
    .describe(
      'Who comments may reach aivi — form answers, run steering, the assistant. `members`: GitHub’s OWNER, MEMBER and COLLABORATOR only; a CONTRIBUTOR or a stranger is heard as nothing, not a word and not a log line. `everyone`: any GitHub user.',
    ),
});
export type GithubConfig = z.infer<typeof githubSchema>;

/** The plugin's section under a project entry (`projects.<id>.tracker-github`).
 *  Core reads none of it. */
export const githubProjectSchema = z.strictObject({
  board: z
    .number()
    .int()
    .positive()
    .describe(
      'The projectsV2 board number — the number at the end of the board’s URL (`.../projects/<org>/1` is board 1). Its Status options are the lanes; aivi never edits them.',
    ),
  repos: z
    .array(z.string().min(3))
    .min(1)
    .describe(
      'Repositories whose issues belong to this project, as `owner/name`. A repository maps to at most one project.',
    ),
  createLane: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Where `aivi_ticket_create` lands a new ticket — a Status option name. Default: the project’s first configured lane; with none matching, the repository’s own default.',
    ),
});
export type GithubProjectEntry = z.infer<typeof githubProjectSchema>;

/** The plugin's section under `projectDefaults`. */
export const githubProjectDefaultsSchema = z.strictObject({
  createLane: z
    .string()
    .min(1)
    .optional()
    .describe('Where `aivi_ticket_create` lands a new ticket in every project unless it names its own.'),
});
export type GithubProjectDefaults = z.infer<typeof githubProjectDefaultsSchema>;

/** The project's GitHub routing as it takes effect: which board speaks for it
 *  and which repositories feed it. Lanes are not here — they are core's
 *  ordered workflow on the `Project` itself, mapped onto the board's Status
 *  options. */
export interface ProjectGithub {
  board: number;
  repos: string[];
  createLane?: string;
}

/** The assistant's agent name: `tracker-github.agent`, else the one assistant
 *  everyone gets. */
export function assistantAgent(github: GithubConfig | undefined): string {
  return github?.agent ?? 'assistant';
}

/** The registry entry: the block holds no paths (the credential is the
 *  environment's, the board is named by number), so `home` finds nothing to
 *  resolve here; the module code loads lazily. The project sections are
 *  contributed here — core passes them through and this plugin reads them
 *  back. */
export const plugin: AiviPlugin<GithubConfig> = {
  id: MODULE_ID,
  configSchema: githubSchema,
  projectSchema: githubProjectSchema,
  projectDefaultsSchema: githubProjectDefaultsSchema,
  // The lazy load is the design: the CLI reads this file's schema without
  // pulling the host's world in, and the module arrives only when the host
  // actually builds. The cycle back into this file (the module imports its
  // own schema) is that design, not a tangle.
  // fallow-ignore-next-line circular-dependency
  createModule: config => import('./module.ts').then(m => m.createGithubModule(config)),
};
