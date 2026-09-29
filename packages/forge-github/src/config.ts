/** The GitHub forge's registry declaration, at its `./config` subpath: the
 *  module id and the block's own schema. The CLI imports this for every
 *  command, so nothing here pulls octokit — `createModule` reaches the module
 *  code lazily, and the credential is read where the network is reached.
 *
 *  The block is minimal to the point of empty on purpose (ruled 2026-09-29):
 *  the app id is the only fact aivi cannot learn for itself, the repositories
 *  come from each project's own `origin`, and the private key is a secret and
 *  so lives in `<home>/.env`. **There is no per-project forge config**: a
 *  forge is asked about a checkout it did not create and reads the answer off
 *  the checkout.
 */
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

/** The environment name the app's PEM private key is read from. It is a
 *  secret, so it is never in `config.json`, never echoed by a flow, and never
 *  inherited by a task script (`<home>/.env`'s keys are all protected). */
export const GITHUB_PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';

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
export const forgeGithubSchema = z.strictObject({
  app: z
    .number()
    .int()
    .positive()
    .describe(
      'The GitHub App id — the number on the app settings page (`App ID`), not its name. The private key is `GITHUB_APP_PRIVATE_KEY` in <home>/.env; the app must be installed on the account holding the repositories, exactly one installation.',
    ),
});
export type ForgeGithubConfig = z.infer<typeof forgeGithubSchema>;

/** The registry entry: the block holds no paths, so `home` finds nothing to
 *  resolve here. No project section is contributed: which repository a project
 *  works is a fact about its checkout, not about its configuration. */
export const plugin: AiviPlugin<ForgeGithubConfig> = {
  id: 'forge-github',
  configSchema: forgeGithubSchema,
  createModule: config => import('./module.ts').then(m => m.createForgeGithubModule(config)),
};
