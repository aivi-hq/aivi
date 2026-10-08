/** The setup `aivi add @aivi/forge-github` runs. It guides what a person has
 *  to do on GitHub — create the app, give aivi its key, select the
 *  repositories — and then proves each fact at GitHub before writing a byte:
 *  that the id and the key belong to one app, that exactly one installation
 *  exists, and that the installation really reads a repository, by reading
 *  that repository's pull requests through it.
 *
 *  The app's identity lands in `<home>/.env` — `GITHUB_APP_ID` beside
 *  `GITHUB_APP_PRIVATE_KEY` (ruled 2026-10-07): the forge and the tracker are
 *  one app, so the credential is a home fact, not a plugin block's. The
 *  guide and its two questions are therefore `@aivi/github`'s (`appIdentity`),
 *  shared with the tracker's installer; when the home already holds the
 *  identity, nothing is asked. The block written to `config.json` is empty:
 *  it only marks the forge as configured, which is what makes core offer the
 *  forge role to a new project.
 *
 *  The installation is a human's act and aivi cannot do it: no throwaway
 *  ticket, no write, is asked of a person to prove the grant — one read is
 *  enough. Writes are proven once, at the live gate.
 */

import { getLogger } from '@aivi/core';
import { appIdentity, GitHubApp } from '@aivi/github';
import type { PluginSetup, PluginSetupContext, PluginSetupResult } from '@aivi/plugin';

const setup: PluginSetup = async (ctx: PluginSetupContext): Promise<PluginSetupResult> => {
  const log = getLogger(['aivi', 'forge-github']);

  ctx.prompts.note(
    [
      'aivi works on GitHub as its own app, never as you:',
      'it opens its pull requests and answers review comments as the bot,',
      'so the work in front of a reviewer is aivi’s and the credit is yours.',
      '',
      'You create the app on GitHub and install it on the account that',
      'holds the repositories. aivi speaks through that one installation.',
      'It cannot do this part, and it will not write anything until it',
      'has read a real pull request through the grant.',
    ].join('\n'),
    'The GitHub app aivi works as',
  );

  // The guide, the App ID and the .pem are the library's (one app, one set of
  // questions): when the home already holds the identity, nothing is asked.
  const { appId, privateKey } = await appIdentity(ctx);

  // The proof below runs in this process, which read `.env` before the key was
  // in it: hand the credential to the connection directly, so what is tested
  // here is the bytes that were just written.
  const app = await GitHubApp.connect({ log, credentials: { appId, privateKey } });
  await ctx.prompts.log.message(
    `The key is app ${app.appSlug}’s, installed on ${app.accountLogin} as installation #${app.installationId}.`,
  );

  // The proof that matters is a read the grant really allows. A repository the
  // app was not given answers 404, so this is also the answer to "is it in the
  // installation’s set" — and an installation that reaches no repository is a
  // grant that has not been aimed at anything.
  const { data: grant } = await app.octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
  if (!grant.repositories.length)
    throw new Error(
      `installation #${app.installationId} reaches no repository: on the installation page, choose "Only select repositories" and select the repositories you want to use aivi in`,
    );
  const first = grant.repositories.find(r => !r.archived) ?? grant.repositories[0]!;
  const [owner = '', name = ''] = first.full_name.split('/');
  const { data: pulls } = await app.octokit.rest.pulls.list({ owner, repo: name, state: 'all', per_page: 3 });
  await ctx.prompts.log.message(
    `It reaches ${grant.total_count >= 100 ? 'more than 100' : grant.total_count} repositories; ${first.full_name} answered with ${pulls.length} pull ${pulls.length === 1 ? 'request' : 'requests'}.`,
  );

  // The block is empty and says so in the summary: the identity lives in
  // .env, and this byte in config.json only marks the forge as configured.
  await ctx.writeConfigBlock(['plugins', 'forge-github'], {});
  return {
    module: 'forge-github',
    summary: `The GitHub forge is set up: app ${app.appSlug} works as installation #${app.installationId} on ${app.accountLogin} (identity in .env), and read ${first.full_name} through it.`,
  };
};

export default setup;
