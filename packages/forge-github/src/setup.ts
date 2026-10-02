/** The setup `aivi add @aivi/forge-github` runs: everything GitHub-specific
 *  lives in this file. It guides the whole of what a person has to do on
 *  GitHub — create the app, paste its public key, grant it the repositories —
 *  and then proves each fact at GitHub before writing a byte: that the id and
 *  the key belong to one app, that exactly one installation exists, and that
 *  the installation really reads a repository, by reading that repository's
 *  pull requests through it.
 *
 *  The installation is a human's act and aivi cannot do it: no throwaway
 *  ticket, no write, is asked of a person to prove the grant — one read is
 *  enough. Writes are proven once, at the live gate.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getLogger } from '@aivi/core';
import { type PluginSetup, PluginSetupCancelled, type PluginSetupContext, type PluginSetupResult } from '@aivi/plugin';
import { type ForgeGithubConfig, GITHUB_PRIVATE_KEY_ENV } from './config.ts';
import { GitHubApp } from './github.ts';

/** The app's numeric id, which is what aivi authenticates with. Its *name* is
 *  for the links a person opens; the number is for everything else. */
const APP_ID = /^\d{1,20}$/;

/**
 * A PEM as one line of a dotenv file: double-quoted, its newlines written as
 * `\n`. A private key is many lines and the file is line-based — quoting is
 * what Node's own loader understands, and the reader in `github.ts` unwraps
 * the same shape again in case anything reads it more plainly.
 */
export function pemForEnvFile(privateKey: string): string {
  const escaped = privateKey
    .trim()
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '');
  return `"${escaped}"`;
}

/** `~` is the operator's home, the path they mean when they type it; anything
 *  else is relative to where they are standing. */
function expandPath(path: string): string {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
}

/** A prompt the person cancelled is not an answer. */
async function settled<T>(ctx: PluginSetupContext, answer: Promise<T | symbol>): Promise<T> {
  const value = await answer;
  if (ctx.prompts.isCancel(value)) throw new PluginSetupCancelled('a prompt was cancelled');
  return value as T;
}

const setup: PluginSetup = async (ctx: PluginSetupContext): Promise<PluginSetupResult> => {
  const log = getLogger(['aivi', 'forge-github']);
  const already = (ctx.config.plugins as Record<string, unknown> | undefined)?.['forge-github'] as
    | { app?: number }
    | undefined;

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

  const appId =
    already?.app ??
    Number(
      String(
        await settled(
          ctx,
          ctx.prompts.text({
            message: 'The App ID — the number on the app settings page',
            placeholder: 'e.g. 12345',
            validate: value =>
              value !== undefined && APP_ID.test(value.trim()) ? undefined : 'the numeric App ID, as on the app page',
          }),
        ),
      ).trim(),
    );

  // The key is asked for as a file because it is many lines: a paste prompt
  // takes one. GitHub hands this file out when the app is created.
  const keyPath = await settled(
    ctx,
    ctx.prompts.text({
      message: 'Where is the app’s private key?',
      placeholder: '~/.config/aivi/aivi-agent.pem',
      validate: value => (value?.trim() ? undefined : 'the path to the .pem GitHub gave you'),
    }),
  );
  let privateKey: string;
  try {
    privateKey = await readFile(expandPath(String(keyPath).trim()), 'utf8');
  } catch (error) {
    throw new Error(`the private key could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!privateKey.includes('PRIVATE KEY-----'))
    throw new Error(
      'that file is not a PEM private key (no "-----BEGIN … PRIVATE KEY-----" line) — GitHub gives it to you as a .pem when the app is created',
    );
  await ctx.writeSecret(GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));
  // The proof below runs in this process, which read `.env` before the key was
  // in it: hand the credential to the environment the reader looks in, so what
  // is tested here is the bytes that were just written.
  process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;

  // One call for three facts: that the key signs a JWT this app accepts, that
  // the app is installed, and that exactly one installation grants it — each
  // failure names what to fix on GitHub or in `.env`.
  const app = await GitHubApp.connect({ app: appId } satisfies ForgeGithubConfig, { log });
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

  await ctx.writeConfigBlock(['plugins', 'forge-github'], { app: appId });
  return {
    module: 'forge-github',
    summary: `The GitHub forge is set up: app ${app.appSlug} works as installation #${app.installationId} on ${app.accountLogin}, and read ${first.full_name} through it.`,
  };
};

export default setup;
