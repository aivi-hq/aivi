/** The app identity, asked in one place. The forge and the tracker are **one
 *  GitHub app** (ruled 2026-10-07), so the guide, the two questions and the
 *  two secrets live here — not twice in two installers, where one fix would
 *  leave the other wrong.
 *
 *  The identity is a home fact: it stands in `<home>/.env` as `GITHUB_APP_ID`
 *  beside `GITHUB_APP_PRIVATE_KEY`. When it is already there, nothing is
 *  asked: a person who installs the second plugin hears one line and answers
 *  no question. When it is not, the guide prints in the words of GitHub's own
 *  app page, and the App ID and the .pem path are asked once each. The .pem
 *  is read once and its key is stored in `.env`; the file itself is then
 *  nobody's business.
 */
import { readFile } from 'node:fs/promises';
import { errorMessage } from '@aivi/core';
import { PluginSetupCancelled, type PluginSetupContext } from '@aivi/plugin';
import {
  GITHUB_APP_ID_ENV,
  GITHUB_PRIVATE_KEY_ENV,
  type GitHubCredentials,
  githubCredentials,
  pemForEnvFile,
  resolveKeyPath,
} from './github.ts';

/** The app's numeric id, which is what aivi authenticates with. Its *name* is
 *  for the links a person opens; the number is for everything else. */
const APP_ID = /^\d{1,20}$/;

type Prompts = PluginSetupContext['prompts'];

/** A cancelled prompt is not an answer. */
async function answered<T>(prompts: Prompts, ask: Parameters<Prompts['text']>[0]): Promise<T> {
  const answer = await prompts.text(ask);
  if (prompts.isCancel(answer)) throw new PluginSetupCancelled('the setup was cancelled at the app identity');
  return answer as T;
}

/** What the guide must tell the person about the webhook. The tracker names
 *  its URL and the events GitHub must post; the forge needs no webhook, so it
 *  passes none and the guide says nothing about one. */
export interface GitHubIdentityGuide {
  webhook?: { url: string; events: string };
}

/** The identity from `<home>/.env` when it stands there; otherwise the guide,
 *  two questions, and both secrets written. The answer is the bytes to
 *  connect with: the caller's process read `.env` before anything was in it. */
export async function appIdentity(
  ctx: Pick<PluginSetupContext, 'prompts' | 'writeSecret'>,
  guide: GitHubIdentityGuide = {},
): Promise<GitHubCredentials> {
  try {
    const held = githubCredentials();
    await ctx.prompts.log.message(
      'The home already holds a GitHub app identity — the forge and the tracker are one app.',
    );
    return held;
  } catch {
    // Nothing is held: the guide and the two questions follow.
  }

  // The steps are numbered so the questions can name them; the webhook line
  // moves the numbers, so they are counted, not written twice.
  const permissionsAt = guide.webhook ? 4 : 3;
  const createAt = permissionsAt + 1;
  const keyAt = createAt + 1;
  const installAt = keyAt + 1;
  const lines = [
    'aivi uses one GitHub app for the forge and the tracker. Create it once;',
    'the other plugin uses the same app and asks you nothing.',
    '',
    '1. Open https://github.com/settings/apps/new',
    '2. GitHub App name is the bot’s name. Homepage and contact details do',
    '   not matter.',
  ];
  if (guide.webhook) {
    lines.push(
      `3. Webhook URL: ${guide.webhook.url}`,
      `   Under "Subscribe to events", tick: ${guide.webhook.events}.`,
    );
  }
  lines.push(
    `${permissionsAt}. Under "Repository permissions", set:`,
    '   - Contents: Read and write',
    '   - Issues: Read and write',
    '   - Pull requests: Read and write',
    '   Under "Organization permissions", set:',
    '   - Projects: Read and write',
    `${createAt}. Press Create. The App ID is the number at the top of the`,
    '   app’s settings page, next to "App ID".',
    `${keyAt}. On that page, under "Private keys", press "Generate a private`,
    '   key". GitHub downloads a .pem file (into your Downloads folder).',
    `${installAt}. Press "Install App", pick the account that holds the`,
    '   repositories, choose "Only select repositories", and select the',
    '   repositories you want to use aivi in. Without this the app reads',
    '   nothing.',
    '',
    'If the app already exists and is installed, saving new permissions is',
    'not enough. GitHub sends an email asking you to approve them. You can',
    'also approve on GitHub: open the organization’s Settings, choose',
    '"GitHub Apps" under "Third-party Access", and press Configure.',
  );
  ctx.prompts.note(lines.join('\n'), 'Creating the GitHub app');

  const appId = Number(
    (
      await answered<string>(ctx.prompts, {
        message: `The App ID — the number on the app page (step ${createAt})`,
        placeholder: 'e.g. 12345',
        validate: value =>
          value !== undefined && APP_ID.test(value.trim()) ? undefined : 'the numeric App ID, as on the app page',
      })
    ).trim(),
  );

  // The key is asked for as a file because it is many lines: a paste prompt
  // takes one. The path is read once — the key is what stays, in .env — and
  // the person is told that, because a path a tool never remembers is not a
  // path to keep.
  const keyPath = await answered<string>(ctx.prompts, {
    message: `The path to the .pem from step ${keyAt} — aivi reads it once and saves the key in the home’s .env`,
    placeholder: '~/.config/aivi/aivi-agent.pem',
    validate: value => (value?.trim() ? undefined : 'the path to the .pem GitHub gave you'),
  });
  let privateKey: string;
  try {
    privateKey = await readFile(resolveKeyPath(keyPath), 'utf8');
  } catch (error) {
    throw new Error(`the private key could not be read: ${errorMessage(error)}`);
  }
  if (!privateKey.includes('PRIVATE KEY-----'))
    throw new Error(
      'that file is not a PEM private key (no "-----BEGIN … PRIVATE KEY-----" line) — GitHub gives it to you as a .pem when the app is created',
    );
  await ctx.writeSecret(GITHUB_APP_ID_ENV, String(appId));
  await ctx.writeSecret(GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));
  return { appId, privateKey };
}
