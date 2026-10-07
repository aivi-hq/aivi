/** The GitHub forge's registry declaration, at its `./config` subpath: the
 *  module id and the block's own schema. The CLI imports this for every
 *  command, so nothing here pulls octokit — `createModule` reaches the module
 *  code lazily.
 *
 *  **The block holds nothing** (ruled 2026-10-07): the app's identity moved to
 *  the environment — `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in
 *  `<home>/.env` — because the forge and the tracker are one app and a plugin
 *  block cannot be the shared source for two plugins (`@aivi/github` reads
 *  both). The repositories come from each project's own `origin`; there is no
 *  per-project forge config. The empty block still marks the forge as
 *  configured: core offers the forge role to a project only when its block
 *  stands in `config.json`.
 */
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

/**
 * The `forge-github` module: the repository host a project's `origin` names,
 * the pull requests over its branches, and the review conversation on them.
 * It speaks as **its own app** — an installation token, minted and renewed by
 * octokit — never as a human's credentials, exactly as the Linear app does.
 * One installation and only one: the app grants aivi access to a repository
 * set through it, and aivi has no vocabulary for more than one.
 *
 * The block lives at `plugins.forge-github` in config.json; the `aivi-plugins`
 * list in `app/package.json` says whether the module runs.
 */
export const forgeGithubSchema = z.strictObject({});
export type ForgeGithubConfig = z.infer<typeof forgeGithubSchema>;

/** The registry entry: the block holds no paths, so `home` finds nothing to
 *  resolve here. No project section is contributed: which repository a project
 *  works is a fact about its checkout, not about its configuration. The block
 *  itself is unused by the module — the credential is read from the
 *  environment where it is written. */
export const plugin: AiviPlugin<ForgeGithubConfig> = {
  id: 'forge-github',
  configSchema: forgeGithubSchema,
  // The lazy load is the design: the CLI reads this file's schema without
  // pulling the host's world in, and the module arrives only when the host
  // actually builds. The cycle back into this file (the module imports its
  // own schema) is that design, not a tangle.
  // fallow-ignore-next-line circular-dependency
  createModule: () => import('./module.ts').then(m => m.createForgeGithubModule()),
};
