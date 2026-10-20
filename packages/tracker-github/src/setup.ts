/**
 *  The setup `aivi add @aivi/tracker-github` runs: what the GitHub tracker
 *  specifically lives on lives in this file.
 *
 *  The app's identity is the home's (D3), and the guide and its two questions
 *  are `@aivi/github`'s (`appIdentity`), shared with the forge's installer:
 *  when `<home>/.env` already holds the id and key — the forge was installed
 *  first, or this installer wrote them — nothing is asked, because the forge
 *  and the tracker are **one app**.
 *
 *  Before anything is written, the truth is read at GitHub with the app's own
 *  JWT: that the grant allows Issues and Projects (the desk and the board),
 *  that the webhook points at this machine and subscribes to `issue_comment`,
 *  `issues` and `projects_v2_item`, and what the last delivery was answered.
 *  Then the webhook secret — the home's when it holds one, else pasted — is
 *  proved by one wait: a delivery must land at this aivi's route and verify
 *  against it. The trigger is a replay of the history's newest `installation`
 *  delivery — GitHub posts that event when a person installs or approves the
 *  app. When the history holds none — the app was installed before this
 *  webhook pointed here — or GitHub refuses the replay, **no wait runs**: a
 *  trigger that cannot come is never sat out (ruled 2026-10-20). The person
 *  reinstalls the app and retries, or skips the wait, and UNVERIFIED is said.
 *
 *  The health gate is a choice, not a stop: no live aivi, the person picks
 *  "I started the server. Retry" or "Continue anyway". Continuing writes
 *  everything with UNVERIFIED said in the summary — the unverified fact is
 *  precisely "GitHub can reach this machine". This installer **writes nothing
 *  at GitHub**; the board probe belongs to `aivi projects add`, where the board
 *  id is in hand. Performing a restart never belongs to this flow — the CLI
 *  owns that, and reports it as it happens.
 */
import { configSchema, errorMessage, getLogger } from '@aivi/core';
import { appIdentity, GITHUB_WEBHOOK_SECRET_ENV, GitHubApp } from '@aivi/github';
import { type PluginSetup, type PluginSetupContext, type PluginSetupResult, settled } from '@aivi/plugin';
import type { GithubConfig } from './config.ts';
import { MODULE_ID } from './config.ts';
import { gateHost, hostIsUp, INSTALLATION_EVENTS, latestId, probeWindowMs, waitDiary } from './probe.ts';
import { GITHUB_WEBHOOK_PATH } from './tracker.ts';

/** What the app's webhook must subscribe to, each with what the tracker would
 *  never hear again without it. */
const REQUIRED_EVENTS: Record<string, string> = {
  issue_comment: 'so a person’s comment can reach aivi',
  issues: 'so aivi can hear about ticket changes',
  projects_v2_item: 'so aivi can hear about board moves',
};

/** How far back the replay hunt looks for an installation delivery: one cheap
 *  request, and the grace an app installed a while ago deserves — the newest
 *  10 were often all traffic since the install, and the install itself had
 *  scrolled out (ruled 2026-10-20). */
const WEBHOOK_HISTORY = 25;

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

  // 3. The app's identity — the home's, shared with the forge (D3). The guide
  //    and its two questions are @aivi/github's, so one app is asked for once
  //    however the two plugins were installed; when the home already holds the
  //    identity, nothing is asked.
  ctx.prompts.note(
    [
      'aivi works on GitHub as its own app, never as you: it comments,',
      'moves board items, and labels as the bot, so the work in front of',
      'a reviewer is aivi’s and the credit is yours.',
    ].join('\n'),
    'The GitHub app aivi works as',
  );
  const credentials = await appIdentity(ctx, {
    webhook: { url: webhookUrl, events: 'Issue comment, Issues, and Projects v2 item' },
  });

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
    lacking.push(`Issues: ${grant.permissions.issues ?? 'no access'} (aivi needs Read and write)`);
  if (grant.permissions.organization_projects !== 'write')
    lacking.push(`Projects: ${grant.permissions.organization_projects ?? 'no access'} (aivi needs Read and write)`);
  if (lacking.length)
    throw new Error(
      `installation #${app.installationId} cannot run the tracker: ${lacking.join('; ')}. ` +
        'GitHub sends an email asking you to approve new permissions; you can also open the organization’s Settings, choose "GitHub Apps" under "Third-party Access", press Configure, and approve there. Saving new permissions on the app page alone keeps the old grant.',
    );
  const unheard = Object.keys(REQUIRED_EVENTS).filter(
    event => !grant.events.includes(event) && !grant.events.includes('*'),
  );
  if (unheard.length)
    throw new Error(
      `the app’s webhook does not subscribe ${unheard.map(event => `${event} (${REQUIRED_EVENTS[event]})`).join('; ')}. ` +
        'Tick them under "Subscribe to events" on the app’s settings page.',
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
  const history = await app.webhookDeliveries(WEBHOOK_HISTORY);
  const last = history[0];
  if (!last) await ctx.prompts.log.message('The webhook has delivered nothing yet — the wait below is its first.');
  else if (last.statusCode >= 200 && last.statusCode < 300)
    await ctx.prompts.log.message(`The last delivery (${last.event}) was answered ${last.statusCode}.`);
  else
    await ctx.prompts.log.message(
      `The last delivery (${last.event}) was answered ${last.statusCode} — before a restart the route is not listening yet, so this is expected; after one it is the thing to chase.`,
    );

  // 6. The secret — the home's when it holds one (D3's rule again: the module
  //    reads this variable from the environment anyway, so asking again would
  //    only invite a paste that disagrees with the bytes the server verifies
  //    with). The wait below proves it either way, pasted or held.
  const heldSecret = process.env[GITHUB_WEBHOOK_SECRET_ENV];
  let webhookSecret: string;
  if (heldSecret) {
    webhookSecret = heldSecret;
    await ctx.prompts.log.message(
      'The home already holds the webhook’s secret — nothing is asked, and the wait below proves it.',
    );
  } else {
    webhookSecret = settled(
      ctx,
      await ctx.prompts.password({
        message: 'The webhook’s Secret, from the app’s settings page',
        validate: value => (value ? undefined : 'Paste the Secret from the webhook section'),
      }),
    );
  }

  let probe: { name: string; pass: boolean; detail: string } | undefined;
  if (verify) probe = await probeInstallation(ctx, app, webhookUrl, webhookSecret, history);

  // 7. Only now is anything written: `host.public` if the installer asked for
  //    it, the webhook secret when the home did not hold one, and the
  //    `tracker-github` block — empty by design, its fields all have defaults;
  //    the byte only marks the tracker as configured. Nothing was written at
  //    GitHub: the board probe lives in `aivi projects add`, where the board
  //    id is in hand.
  if (!config.host.public) await ctx.writeConfigBlock(['host', 'public'], base);
  if (!heldSecret) await ctx.writeSecret(GITHUB_WEBHOOK_SECRET_ENV, webhookSecret);
  await ctx.writeConfigBlock(['plugins', MODULE_ID], { ...existingBlock });

  const outcome = probe
    ? probe.pass
      ? `${probe.detail}. Restart aivi to load the tracker`
      : `FAILED — ${probe.detail}. Fix that and run the install again`
    : `UNVERIFIED — ${verify ? 'the webhook wait was skipped' : 'no live aivi watched'}, so “GitHub can reach this machine” was not proved. Restart aivi to load the tracker`;
  return {
    module: MODULE_ID,
    summary: `The GitHub tracker is configured: ${outcome}.`,
  };
};

/** The fork when no trigger can come: the person reinstalls the app (the
 *  install posts `installation`; lighter, toggling a repository on the
 *  installation page posts `installation_repositories`) and retries, or skips
 *  the wait — the configuration is still written, with UNVERIFIED said in the
 *  summary. Cancelled is no answer: the flow stops, as at the health gate. */
async function forkWebhook(ctx: PluginSetupContext, message: string): Promise<'retry' | 'skip'> {
  const choice = await ctx.prompts.select({
    message,
    options: [
      { value: 'retry', label: 'I reinstalled the app. Try again.' },
      { value: 'skip', label: 'Skip webhook verification' },
    ],
  });
  if (ctx.prompts.isCancel(choice)) throw new Error('the setup was cancelled at the webhook fork');
  return choice === 'skip' ? 'skip' : 'retry';
}

/** The one wait: a delivery must land at this aivi's route and verify against
 *  the secret aivi holds. The trigger is a replay of the history's newest
 *  installation delivery (the replay carries the app's current secret, so a
 *  replay that verifies proves the held secret). When the history holds none,
 *  or GitHub refuses the replay, **no wait starts**: an app installed before
 *  this webhook pointed here would sit the window on a delivery that can
 *  never land (ruled 2026-10-20) — the person forks instead. A delivery that
 *  arrives about anything else while the wait runs still proves the URL and
 *  the secret, and is said as the verdict too — silence is the only failure
 *  that is waited out. `undefined` is the skip: no verdict, because nothing
 *  was watched. */
async function probeInstallation(
  ctx: PluginSetupContext,
  app: GitHubApp,
  webhookUrl: string,
  webhookSecret: string,
  history: { id: string; event: string }[],
): Promise<{ name: string; pass: boolean; detail: string } | undefined> {
  const windowMs = probeWindowMs();
  let deliveries = history;
  for (;;) {
    const replay = deliveries.find(delivery => INSTALLATION_EVENTS.has(delivery.event));
    if (!replay) {
      const choice = await forkWebhook(ctx, 'The GitHub app was not installed recently.');
      if (choice === 'skip') return undefined;
      // The reinstall posted its own delivery — the hunt re-pulls the history.
      deliveries = await app.webhookDeliveries(WEBHOOK_HISTORY);
      continue;
    }
    const spinner = ctx.prompts.spinner();
    spinner.start('webhooks: waiting for a delivery to land…');
    // `undefined`: GitHub refused the replay, so no wait started — the fork
    // below decides, because waiting out the window on a refused replay only
    // re-asks a question GitHub already answered.
    let refused: string | undefined;
    const posted = await ctx.withStore(async store => {
      // The cursor is taken **before** the trigger: a replay that lands in the
      // seconds before the store opens must still be ahead of the mark, and
      // whatever the diary already held is nobody's business.
      const cursor = latestId(store);
      try {
        await app.redeliverWebhook(replay.id);
        spinner.message('Re-asked GitHub for its own installation delivery — waiting for the replay to land…');
      } catch (error) {
        refused = errorMessage(error);
        return undefined;
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
    if (posted === undefined) {
      spinner.cancel(`webhooks — the replay was refused (${refused})`);
      const choice = await forkWebhook(ctx, `GitHub refused to replay its installation delivery (${refused}).`);
      if (choice === 'skip') return undefined;
      deliveries = await app.webhookDeliveries(WEBHOOK_HISTORY);
      continue;
    }
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
}

export default setup;
