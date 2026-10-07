/**
 * The setup `aivi add @aivi/tracker-github` runs: everything the GitHub
 * tracker specifically lives on lives in this file.
 *
 *  The app's identity is the home's (D3): when `<home>/.env` already holds it —
 *  the forge was installed first, or this installer wrote it — nothing is asked,
 *  because the forge and the tracker are **one app**. When it does not, the
 *  creation guide prints here in full and the id and .pem land in `.env` beside
 *  the webhook secret.
 *
 *  Before anything is written, the truth is read at GitHub with the app's own
 *  JWT: that the grant allows Issues and Organization projects (the desk and
 *  the board), that the webhook points at this machine and subscribes to
 *  `issue_comment`, `issues` and `projects_v2_item`, and what the last delivery
 *  was answered. Then the secret is pasted and one wait proves it: a delivery
 *  must land at this aivi's route and verify against the pasted secret. The
 *  trigger is the installation itself — the person is installing or approving
 *  the app right now, and GitHub posts `installation` for that act; when the
 *  delivery history already holds one, the installer re-asks GitHub for it and
 *  watches the replay land.
 *
 *  The health gate is a choice, not a stop: no live aivi, the person picks
 *  "I started the server. Retry" or "Continue anyway". Continuing writes
 *  everything with UNVERIFIED said in the summary — the unverified fact is
 *  precisely "GitHub can reach this machine". This installer **writes nothing
 *  at GitHub**; the board probe belongs to `aivi projects add`, where the board
 *  id is in hand. Performing a restart never belongs to this flow — the CLI
 *  owns that, and reports it as it happens.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { configSchema, errorMessage, getLogger } from '@aivi/core';
import {
  GITHUB_APP_ID_ENV,
  GITHUB_PRIVATE_KEY_ENV,
  GITHUB_WEBHOOK_SECRET_ENV,
  GitHubApp,
  type GitHubCredentials,
  githubCredentials,
  pemForEnvFile,
} from '@aivi/github';
import { type PluginSetup, type PluginSetupContext, type PluginSetupResult, settled } from '@aivi/plugin';
import type { GithubConfig } from './config.ts';
import { MODULE_ID } from './config.ts';
import { gateHost, hostIsUp, INSTALLATION_EVENTS, latestId, probeWindowMs, waitDiary } from './probe.ts';
import { GITHUB_WEBHOOK_PATH } from './tracker.ts';

/** The app's numeric id, which is what aivi authenticates with. Its *name* is
 *  for the links a person opens; the number is for everything else. */
const APP_ID = /^\d{1,20}$/;

/** What the app's webhook must subscribe to, each with what the tracker would
 *  never hear again without it. */
const REQUIRED_EVENTS: Record<string, string> = {
  issue_comment: 'the conversation — a person’s comment answers a run',
  issues: 'the walk and the desk — the ticket’s own state',
  projects_v2_item: 'the board — lane moves and the Agent delegation',
};

/** `~` is the operator's home, the path they mean when they type it; anything
 *  else is relative to where they are standing. */
function expandPath(path: string): string {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
}

/** Two webhook URLs compared as what they point at: GitHub stores the string
 *  a person typed, and a trailing slash is nobody's intent. */
const trimSlash = (url: string): string => url.replace(/\/+$/, '');

const setup: PluginSetup = async (ctx: PluginSetupContext): Promise<PluginSetupResult> => {
  const log = getLogger(['aivi', MODULE_ID]);
  const config = configSchema.parse(ctx.config);
  const existingBlock = (ctx.config.plugins as Record<string, unknown> | undefined)?.[MODULE_ID] as
    | GithubConfig
    | undefined;

  // 1. The live aivi, asked as a choice. The waits below watch what a running
  //    aivi records; with none running the person retries or continues
  //    unverified — the installer's own configuration still gets written.
  const verify = await gateHost(ctx.prompts, () => hostIsUp(ctx.fetch, config.host));

  // 2. The URL GitHub can reach this aivi at, asked once and saved.
  let base = config.host.public;
  if (!base) {
    ctx.prompts.note(
      [
        'GitHub posts webhooks to this aivi, so it needs a URL GitHub can reach.',
        'A tunnel is the usual answer — a Tailscale Funnel or similar pointed at aivi.',
        'aivi cannot discover this URL itself, so the setup asks once and saves it;',
        'later runs will not ask.',
      ].join('\n'),
      'GitHub reaches aivi',
    );
    base = settled(
      ctx,
      await ctx.prompts.text({
        message: 'The public URL GitHub can reach this aivi at',
        placeholder: 'e.g. https://my-machine.ts.net',
        validate: value =>
          value !== undefined && /^https?:\/\//.test(value)
            ? value.endsWith('/')
              ? 'no trailing /'
              : undefined
            : 'an http(s) URL, like https://my-machine.ts.net',
      }),
    );
  }
  const webhookUrl = `${base}${GITHUB_WEBHOOK_PATH}`;

  // 3. The app's identity — the home's, shared with the forge (D3). When the
  //    env already holds it, nothing is asked: one app, one credential.
  let credentials: GitHubCredentials;
  try {
    credentials = githubCredentials();
    await ctx.prompts.log.message(
      'The home already holds a GitHub app identity — the tracker works as the same app as the forge.',
    );
  } catch {
    ctx.prompts.note(
      [
        'aivi works on GitHub as its own app, never as you: it comments,',
        'moves board items, and labels as the bot, so the work in front of',
        'a reviewer is aivi’s and the credit is yours.',
        '',
        '1. Open https://github.com/settings/apps/new',
        '2. GitHub App name is the bot’s name; homepage and contact do not',
        '   matter.',
        `3. Webhook URL: ${webhookUrl}`,
        '   Under "Choose which events must notify the webhook", tick',
        '   Issue comments, Issues, and Project card.',
        '4. Under "Repository permissions", set Issues: Read & write —',
        '   comments, labels, and the whole desk work there. Under',
        '   "Organization permissions", set Organization projects:',
        '   Read & write — lanes are Status options on the board and the',
        '   delegation is its Agent field.',
        '   (Contents and Pull requests belong to the forge; grant them',
        '   there: `aivi add @aivi/forge-github`.)',
        '5. Press Create. The App ID is the number at the top of the app’s',
        '   settings page, next to "App ID".',
        '6. On that page, under "Private keys", press "Generate a private',
        '   key". GitHub downloads a .pem file (into your Downloads folder).',
        '7. Press "Install App", pick the account that holds the',
        '   repositories, choose "Only select repositories", and add the',
        '   repositories aivi works. Without this the app reads nothing.',
        '',
        'If the app already exists and is installed, saving new permissions',
        'is not enough: open the installation (Integrations → Configure) and',
        'approve the pending access, or aivi keeps the old grant.',
      ].join('\n'),
      'Creating the GitHub app',
    );
    const appId = Number(
      String(
        settled(
          ctx,
          await ctx.prompts.text({
            message: 'The App ID — the number on the app page (step 5)',
            placeholder: 'e.g. 12345',
            validate: value =>
              value !== undefined && APP_ID.test(value.trim()) ? undefined : 'the numeric App ID, as on the app page',
          }),
        ),
      ).trim(),
    );
    // The key is asked for as a file because it is many lines: a paste prompt
    // takes one. The path itself is read once — the key is what stays, in .env.
    const keyPath = settled(
      ctx,
      await ctx.prompts.text({
        message: 'The path to the .pem from step 6 — aivi reads it once and saves the key in the home’s .env',
        placeholder: '~/.config/aivi/aivi-agent.pem',
        validate: value => (value?.trim() ? undefined : 'the path to the .pem GitHub gave you'),
      }),
    );
    let privateKey: string;
    try {
      privateKey = await readFile(expandPath(String(keyPath).trim()), 'utf8');
    } catch (error) {
      throw new Error(`the private key could not be read: ${errorMessage(error)}`);
    }
    if (!privateKey.includes('PRIVATE KEY-----'))
      throw new Error(
        'that file is not a PEM private key (no "-----BEGIN … PRIVATE KEY-----" line) — GitHub gives it to you as a .pem when the app is created',
      );
    await ctx.writeSecret(GITHUB_APP_ID_ENV, String(appId));
    await ctx.writeSecret(GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));
    credentials = { appId, privateKey };
  }

  // The proof below runs in this process, which read `.env` before any key was
  // in it: hand the credential to the connection directly, so what is tested
  // here is the bytes that were just written.
  const app = await GitHubApp.connect({ log, credentials });
  await ctx.prompts.log.message(
    `The key is app ${app.appSlug}’s, installed on ${app.accountLogin} as installation #${app.installationId}.`,
  );

  // 4. What the grant says it allows, read with the app's own JWT. A tracker
  //    that went on past a missing permission would fail at the first lane
  //    move with someone else's error message.
  const grant = await app.grantFacts();
  const lacking: string[] = [];
  if (grant.permissions.issues !== 'write')
    lacking.push(
      `Issues: ${grant.permissions.issues ?? 'no access'} — comments, labels, and the whole desk work there`,
    );
  if (grant.permissions.organization_projects !== 'write')
    lacking.push(
      `Organization projects: ${grant.permissions.organization_projects ?? 'no access'} — lanes are Status options on the board, and the delegation is its Agent field`,
    );
  if (lacking.length)
    throw new Error(
      `installation #${app.installationId} cannot work the tracker: ${lacking.join('; ')}. ` +
        'Tick them on the installation page (Integrations → Configure) and approve the pending access — saving new permissions on the app page alone keeps the old grant.',
    );
  const unheard = Object.keys(REQUIRED_EVENTS).filter(
    event => !grant.events.includes(event) && !grant.events.includes('*'),
  );
  if (unheard.length)
    throw new Error(
      `the app’s webhook does not subscribe ${unheard.map(event => `${event} (${REQUIRED_EVENTS[event]})`).join('; ')}. ` +
        'Tick them under "Choose which events must notify the webhook" on the app’s settings page.',
    );

  // 5. Where the hook points — also the app's own JWT. A URL that points at
  //    another machine is said now, not waited out there.
  const hook = await app.webhookConfig();
  if (!hook.url)
    throw new Error(
      `the app posts nowhere: put ${webhookUrl} in the "Webhook URL" on the app’s settings page, with the events above, and run this again.`,
    );
  if (trimSlash(hook.url) !== trimSlash(webhookUrl))
    throw new Error(
      `the app posts to ${hook.url}, not ${webhookUrl}. Deliveries to a different address are not aivi’s to read: point the Webhook URL here and run this again.`,
    );
  if (hook.insecureSsl)
    await ctx.prompts.log.message(
      'GitHub downgraded the webhook to SSL — deliveries skip full TLS verification. Check the certificate on the public URL.',
    );
  const history = await app.webhookDeliveries(10);
  const last = history[0];
  if (!last) await ctx.prompts.log.message('The webhook has delivered nothing yet — the wait below is its first.');
  else if (last.statusCode >= 200 && last.statusCode < 300)
    await ctx.prompts.log.message(`The last delivery (${last.event}) was answered ${last.statusCode}.`);
  else
    await ctx.prompts.log.message(
      `The last delivery (${last.event}) was answered ${last.statusCode} — before a restart the route is not listening yet, so this is expected; after one it is the thing to chase.`,
    );

  // 6. The secret, then the one wait that proves it against a live delivery.
  const webhookSecret = settled(
    ctx,
    await ctx.prompts.password({
      message: 'The webhook’s Secret, from the app’s settings page',
      validate: value => (value ? undefined : 'Paste the Secret from the webhook section'),
    }),
  );

  let probe: { name: string; pass: boolean; detail: string } | undefined;
  if (verify) probe = await probeInstallation(ctx, app, webhookUrl, webhookSecret, history);

  // 7. Only now is anything written: `host.public` if the installer asked for
  //    it, the webhook secret, and the `tracker-github` block — empty by
  //    design, its fields all have defaults; the byte only marks the tracker
  //    as configured. Nothing was written at GitHub: the board probe lives in
  //    `aivi projects add`, where the board id is in hand.
  if (!config.host.public) await ctx.writeConfigBlock(['host', 'public'], base);
  await ctx.writeSecret(GITHUB_WEBHOOK_SECRET_ENV, webhookSecret);
  await ctx.writeConfigBlock(['plugins', MODULE_ID], { ...existingBlock });

  const outcome = !probe
    ? 'UNVERIFIED — no live aivi watched, so “GitHub can reach this machine” was not proved. Restart aivi to load the tracker'
    : probe.pass
      ? `${probe.detail}. Restart aivi to load the tracker`
      : `FAILED — ${probe.detail}. Fix that and run the install again`;
  return {
    module: MODULE_ID,
    summary: `The GitHub tracker is configured: ${outcome}.`,
  };
};

/** The one wait: a delivery must land at this aivi's route and verify against
 *  the pasted secret. The trigger is the installation act the person is doing
 *  right now — GitHub posts `installation` for it; when the history holds one
 *  already, the installer re-asks GitHub for it (the replay carries the app's
 *  current secret, so a replay that verifies proves the paste). A delivery
 *  that arrives about anything else still proves the URL and the secret, and
 *  is said as the verdict too — silence is the only failure. */
async function probeInstallation(
  ctx: PluginSetupContext,
  app: GitHubApp,
  webhookUrl: string,
  webhookSecret: string,
  history: { id: string; event: string }[],
): Promise<{ name: string; pass: boolean; detail: string }> {
  const windowMs = probeWindowMs();
  const replay = history.find(delivery => INSTALLATION_EVENTS.has(delivery.event));
  const spinner = ctx.prompts.spinner();
  spinner.start('webhooks: waiting for a delivery to land…');
  const posted = await ctx.withStore(async store => {
    // The cursor is taken **before** the trigger: a replay that lands in the
    // seconds before the store opens must still be ahead of the mark, and
    // whatever the diary already held is nobody's business.
    const cursor = latestId(store);
    if (replay) {
      try {
        await app.redeliverWebhook(replay.id);
        spinner.message('Re-asked GitHub for its own installation delivery — waiting for the replay to land…');
      } catch (error) {
        spinner.message(
          `The replay was refused (${errorMessage(error)}) — install or re-approve the app; it posts as we wait.`,
        );
      }
    } else {
      spinner.message(
        'No installation delivery to replay — install the app (or approve its grant) now; it posts as we wait.',
      );
    }
    return waitDiary(
      store,
      {
        path: GITHUB_WEBHOOK_PATH,
        secret: webhookSecret,
        windowMs,
        accepts: (event, payload) => INSTALLATION_EVENTS.has(event) && payload?.action !== 'deleted',
        about: () => true, // every delivery about this URL proves reach and secret; names are for the live line
      },
      cursor,
      line => spinner.message(line),
    );
  });
  if (posted.mine) {
    const detail = 'the installation delivery arrived and verified';
    spinner.stop(`webhooks — ${detail}`);
    return { name: 'webhooks', pass: true, detail };
  }
  if (posted.others) {
    const detail =
      'deliveries arrived and verified — the URL and the secret are proved, though no installation event among them';
    spinner.stop(`webhooks — ${detail}`);
    return { name: 'webhooks', pass: true, detail };
  }
  const detail = `nothing arrived in ${windowMs / 1000} s — the Webhook URL on the app is not ${webhookUrl}, the events are off, or GitHub cannot reach this machine`;
  spinner.cancel(`webhooks — ${detail}`);
  return { name: 'webhooks', pass: false, detail };
}

export default setup;
