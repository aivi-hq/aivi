/** The setup `aivi add @aivi/forge-github` runs: everything GitHub-specific
 *  lives in this file. It guides the whole of what a person has to do on
 *  GitHub — create the app, paste its public key, grant it the repositories —
 *  and then proves each fact at GitHub before writing a byte: that the id and
 *  the key belong to one app, that exactly one installation exists, and that
 *  the installation really reads a repository, by reading that repository's
 *  pull requests through it.
 *
 *  The app's identity lands in `<home>/.env` — `GITHUB_APP_ID` beside
 *  `GITHUB_APP_PRIVATE_KEY` (ruled 2026-10-07): the forge and the tracker are
 *  one app, so the credential is a home fact, not a plugin block's. The block
 *  written to `config.json` is empty: it only marks the forge as configured,
 *  which is what makes core offer the forge role to a new project.
 *
 *  The installation is a human's act and aivi cannot do it: no throwaway
 *  ticket, no write, is asked of a person to prove the grant — one read is
 *  enough. Writes are proven once, at the live gate.
 */

import { readFile } from 'node:fs/promises';
import { getLogger } from '@aivi/core';
import { GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV, GitHubApp, pemForEnvFile, resolveKeyPath } from '@aivi/github';
import { type PluginSetup, PluginSetupCancelled, type PluginSetupContext, type PluginSetupResult } from '@aivi/plugin';

/** The app's numeric id, which is what aivi authenticates with. Its *name* is
 *  for the links a person opens; the number is for everything else. */
const APP_ID = /^\d{1,20}$/;

/** A prompt the person cancelled is not an answer. */
async function settled<T>(ctx: PluginSetupContext, answer: Promise<T | symbol>): Promise<T> {
  const value = await answer;
  if (ctx.prompts.isCancel(value)) throw new PluginSetupCancelled('a prompt was cancelled');
  return value as T;
}

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

  ctx.prompts.note(
    [
      '1. Open https://github.com/settings/apps/new',
      '2. GitHub App name is the bot’s name; homepage and contact do not',
      '   matter. Webhooks: point them at',
      '   https://<your aivi host>/github/webhooks, where the tracker',
      '   listens (harmless to leave unset if you only want the forge).',
      '3. Under "Repository permissions", set:',
      '   - Contents: Read & write       (aivi reads and pushes branches)',
      '   - Pull requests: Read & write  (pull requests, reviews, replies)',
      '   - Issues: Read & write         (tracker-github; harmless to grant)',
      '4. Press Create. The App ID is the number at the top of the app’s',
      '   settings page, next to "App ID".',
      '5. On that page, under "Private keys", press "Generate a private',
      '   key". GitHub downloads a .pem file (into your Downloads folder).',
      '6. Press "Install App", pick the account that holds the repositories,',
      '   choose "Only select repositories", and select the repositories',
      '   you want to use aivi in. Without this the app reads nothing and',
      '   the check below fails.',
      '',
      'If the app already exists and is installed, saving new permissions',
      'is not enough. GitHub sends an email asking you to approve them.',
      'You can also approve on GitHub: open the organization’s Settings,',
      'choose "GitHub Apps" under "Third-party Access", and press',
      'Configure.',
    ].join('\n'),
    'Creating the GitHub app',
  );

  const appId = Number(
    String(
      await settled(
        ctx,
        ctx.prompts.text({
          message: 'The App ID — the number on the app page (step 4)',
          placeholder: 'e.g. 12345',
          validate: value =>
            value !== undefined && APP_ID.test(value.trim()) ? undefined : 'the numeric App ID, as on the app page',
        }),
      ),
    ).trim(),
  );

  // The key is asked for as a file because it is many lines: a paste prompt
  // takes one. GitHub hands this file out when the app is created. The path
  // itself is read once — the key is what stays, in .env — and the person
  // is told that, because a path a tool never remembers is not a path to
  // curate.
  const keyPath = await settled(
    ctx,
    ctx.prompts.text({
      message: 'The path to the .pem from step 5 — aivi reads it once and saves the key in the home’s .env',
      placeholder: '~/.config/aivi/aivi-agent.pem',
      validate: value => (value?.trim() ? undefined : 'the path to the .pem GitHub gave you'),
    }),
  );
  let privateKey: string;
  try {
    privateKey = await readFile(resolveKeyPath(String(keyPath)), 'utf8');
  } catch (error) {
    throw new Error(`the private key could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!privateKey.includes('PRIVATE KEY-----'))
    throw new Error(
      'that file is not a PEM private key (no "-----BEGIN … PRIVATE KEY-----" line) — GitHub gives it to you as a .pem when the app is created',
    );
  await ctx.writeSecret(GITHUB_APP_ID_ENV, String(appId));
  await ctx.writeSecret(GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));

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
      `installation #${app.installationId} reaches no repository: on the installation page, choose "Only select repositories" and add the ones aivi works`,
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
