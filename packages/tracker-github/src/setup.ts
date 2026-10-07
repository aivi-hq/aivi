/**
 * The setup `aivi add @aivi/tracker-github` runs: everything the GitHub
 * tracker specifically lives on lives in this file. Like Linear's installer it
 * starts only when a live aivi answers its health endpoint — the test observes
 * what that host's request diary records, so no host, no install.
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
 *  was answered. Then the throwaway-issue test, in the two waits Linear's
 *  installer taught: an opened issue must arrive at the route with a seal that
 *  verifies against the pasted secret, and so must a comment — the conversation
 *  path. A passed wait is nobody's waiting room; the window is what a failure
 *  needs, because silence is a result too. The installer closes the probe issue
 *  when the test ends and says the truth: GitHub has no API for deleting an
 *  issue. Performing a restart never belongs to this flow — the CLI owns that.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { configSchema, errorMessage, getLogger, hostUrl } from '@aivi/core';
import {
  GITHUB_APP_ID_ENV,
  GITHUB_PRIVATE_KEY_ENV,
  GITHUB_WEBHOOK_SECRET_ENV,
  GitHubApp,
  type GitHubCredentials,
  githubCredentials,
  pemForEnvFile,
  verifyWebhookSignature,
} from '@aivi/github';
import {
  type PluginSetup,
  PluginSetupCancelled,
  type PluginSetupContext,
  type PluginSetupResult,
  type Store,
  settled,
} from '@aivi/plugin';
import type { GithubConfig } from './config.ts';
import { MODULE_ID } from './config.ts';
import { GITHUB_WEBHOOK_PATH } from './tracker.ts';

/** How long the diary is watched when a check cannot pass: silence is a
 *  result too, and only a waited-out silence proves it. Tests shorten the
 *  window (AIVI_PROBE_WINDOW_MS, shared with the Linear installer); people
 *  get the honest cap. */
const DEFAULT_WINDOW_MS = 90_000;
const probeWindowMs = () => Number(process.env.AIVI_PROBE_WINDOW_MS ?? DEFAULT_WINDOW_MS);

/** The installer is a second process and file events do not report SQLite's WAL
 *  writes (macOS never mentions them, measured 2026-09-26), so the diary is
 *  re-read on this quiet interval — one query on an indexed column. */
const POLL_MS = 2_000;

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
  const windowMs = probeWindowMs();
  const config = configSchema.parse(ctx.config);
  const existingBlock = (ctx.config.plugins as Record<string, unknown> | undefined)?.[MODULE_ID] as
    | GithubConfig
    | undefined;

  // The test observes what the running host records in its request diary:
  // with no live aivi there is nothing to observe, and finding that out at
  // the end wastes a whole install round. The installer does not own restarts,
  // so a no is final.
  const hostIsUp = await ctx
    .fetch(`${hostUrl(config.host)}/health`, { signal: AbortSignal.timeout(2_000) })
    .then(response => response.ok)
    .catch(() => false);
  if (!hostIsUp)
    throw new Error(
      'aivi must be running while the installer tests the webhook: start it (`aivi serve`, or `aivi service restart`) and run `aivi add @aivi/tracker-github` again.',
    );

  // 1. The URL GitHub can reach this aivi at, asked once and saved.
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

  // 2. The app's identity — the home's, shared with the forge (D3). When the
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

  // 3. What the grant says it allows, read with the app's own JWT. A tracker
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

  // 4. Where the hook points — also the app's own JWT. A URL that points at
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
  const last = (await app.webhookDeliveries(1))[0];
  if (!last) await ctx.prompts.log.message('The webhook has delivered nothing yet — the test below will be its first.');
  else if (last.statusCode >= 200 && last.statusCode < 300)
    await ctx.prompts.log.message(`The last delivery (${last.event}) was answered ${last.statusCode}.`);
  else
    await ctx.prompts.log.message(
      `The last delivery (${last.event}) was answered ${last.statusCode} — before a restart the route is not listening yet, so this is expected; after one it is the thing to chase.`,
    );

  // 5. The secret, then the waits that prove it against live deliveries before
  //    it is trusted into `.env`.
  const webhookSecret = settled(
    ctx,
    await ctx.prompts.password({
      message: 'The webhook’s Secret, from the app’s settings page',
      validate: value => (value ? undefined : 'Paste the Secret from the webhook section'),
    }),
  );

  const granted = await app.repositories();
  if (!granted.length)
    throw new Error(
      `installation #${app.installationId} reaches no repository: on the installation page, choose "Only select repositories" and add the ones aivi works`,
    );

  // 6. The test, before any write: one throwaway issue, proven in two waits
  //    that run one after the other — that GitHub posts deliveries to this
  //    URL, and that a comment arrives too, because the comment path is the
  //    conversation. With the module not yet loaded, every delivery is
  //    recorded untouched: pure observation of GitHub's behavior.
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  ctx.prompts.note(
    [
      'The installer will now test the webhook. It does this by creating a',
      'temporary issue, posting a comment on it, and watching the deliveries',
      'GitHub posts back. It closes the issue when the test ends. When',
      'GitHub can reach this aivi, the test takes seconds.',
    ].join('\n'),
    'Testing the configuration',
  );
  const repoId = await pickRepository(ctx, granted);
  await ctx.withStore(async store => {
    // Whatever the diary holds before the test issue exists is nobody's
    // business; the cursor starts at its newest row.
    const cursor = latestId(store);
    const [owner = '', name = ''] = repoId.split('/');
    const { data: probe } = await app.octokit.rest.issues.create({
      owner,
      repo: name,
      title: 'aivi add test — safe to delete',
      body: `Created by \`aivi add @aivi/tracker-github\` to test the webhook at ${webhookUrl}. The installer closes it when the test ends.`,
    });
    await ctx.prompts.log.message(`Created ${repoId}#${probe.number}.`);
    const watch = { ctx, windowMs, webhookSecret, checks, repoId, number: probe.number };
    const posted = await checkIssueDeliveries(watch, store, cursor);
    await checkCommentDelivery(watch, store, app, posted);
    // The installer made the issue, so the installer tidies it — GitHub has no
    // API for deleting an issue, and the line says so rather than promising a
    // delete. A close that fails is said, not swallowed, so an issue is never
    // left without the operator knowing.
    try {
      await app.octokit.rest.issues.update({
        owner,
        repo: name,
        issue_number: probe.number,
        state: 'closed',
        state_reason: 'not_planned',
      });
      await ctx.prompts.log.message(
        `${repoId}#${probe.number} closed. GitHub has no API for deleting an issue — it is safe to delete by hand.`,
      );
    } catch (error) {
      await ctx.prompts.log.message(
        `Could not close ${repoId}#${probe.number} — close it by hand (${errorMessage(error)}).`,
      );
    }
  });

  // 7. Only now is anything written: `host.public` if the installer asked for
  //    it, the webhook secret, and the `tracker-github` block — empty by
  //   design, its fields all have defaults; the byte only marks the tracker
  //   as configured.
  if (!config.host.public) await ctx.writeConfigBlock(['host', 'public'], base);
  await ctx.writeSecret(GITHUB_WEBHOOK_SECRET_ENV, webhookSecret);
  await ctx.writeConfigBlock(['plugins', MODULE_ID], { ...existingBlock });

  const failed = checks.filter(c => !c.pass);
  const outcome = failed.length
    ? `FAILED — ${failed.map(c => `${c.name}: ${c.detail}`).join('; ')}. Fix that and run the install again`
    : 'deliveries arrived and verified';
  // The installer started only because a live aivi answered its health
  // endpoint, so what loads the module is its own line to say; when a service
  // is installed the CLI restarts it anyway and reports that as it happens.
  return {
    module: MODULE_ID,
    summary: failed.length
      ? `The GitHub tracker is configured: ${outcome}.`
      : `The GitHub tracker is configured: ${outcome}. Restart aivi to load the tracker.`,
  };
};

/** What the two waits share: the secret to verify with, the issue to name, and
 *  the checks list the verdicts land in. */
interface Probe {
  ctx: PluginSetupContext;
  windowMs: number;
  webhookSecret: string;
  checks: { name: string; pass: boolean; detail: string }[];
  repoId: string;
  number: number;
}

/** One payload as the live line says it, in GitHub's own words, naming the
 *  ticket it is about — during a test several issues can be in play. The
 *  status our side answered with is left out on purpose: with the module not
 *  yet loaded nothing can answer 2xx, and the delivery arriving is the point. */
const describeDelivery = (event: string, payload: any): string => {
  const number = payload?.issue?.number ?? payload?.number;
  const at =
    payload?.repository?.full_name && number
      ? `${payload.repository.full_name}#${number}`
      : 'something the payload did not name';
  const action = typeof payload?.action === 'string' ? ` ${payload.action}` : '';
  return `${event}${action} on ${at}`;
};

/** Whether a delivery is about the probe issue. */
const aboutProbe = (payload: any, probe: Probe): boolean =>
  payload?.repository?.full_name === probe.repoId && payload?.issue?.number === probe.number;

/** The repository the test issue is created in: the one grant is taken as it
 *  stands and said; several get the pick-list of the real grant. */
async function pickRepository(ctx: PluginSetupContext, granted: { id: string }[]): Promise<string> {
  if (granted.length === 1) {
    await ctx.prompts.log.message(`The one repository the app holds, ${granted[0]!.id}, gets the test issue.`);
    return granted[0]!.id;
  }
  const answer = await ctx.prompts.autocomplete({
    message: 'Which repository gets the test issue?',
    options: granted.map(repo => ({ value: repo.id, label: repo.id })),
    maxItems: 12,
  });
  if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('no repository chosen');
  return String(answer);
}

/** The first wait: GitHub must post the issue's creation to this URL with a
 *  seal the module's own check accepts. A verdict is said on the live line and
 *  recorded for the summary, together, in every branch. */
async function checkIssueDeliveries(probe: Probe, store: Store, cursor: number): Promise<Diaried> {
  const { ctx, windowMs, checks, repoId, number } = probe;
  const webhooks = ctx.prompts.spinner();
  webhooks.start(`webhooks: waiting for GitHub to post about ${repoId}#${number}…`);
  let posted: Diaried;
  try {
    posted = await waitDiary(
      store,
      probe,
      cursor,
      windowMs,
      (event, payload) => event === 'issues' && payload?.action === 'opened',
      line => webhooks.message(line),
    );
  } catch (error) {
    webhooks.cancel('webhooks — a delivery arrived that did not verify');
    throw error;
  }
  if (posted.mine) {
    const detail = 'issue delivery arrived and verified';
    webhooks.stop(`webhooks — ${detail}`);
    checks.push({ name: 'webhooks', pass: true, detail });
  } else if (posted.others) {
    const detail = `deliveries arrived, but none about ${repoId}#${number} — the events ticked on the webhook decide what GitHub posts`;
    webhooks.cancel(`webhooks — ${detail}`);
    checks.push({ name: 'webhooks', pass: false, detail });
  } else {
    const detail = `nothing arrived in ${windowMs / 1000} s — the Webhook URL on the app is not this one, the events are off, or GitHub cannot reach this machine`;
    webhooks.cancel(`webhooks — ${detail}`);
    checks.push({ name: 'webhooks', pass: false, detail });
  }
  return posted;
}

/** The second wait needs a comment of its own: the comment path is the
 *  conversation — a person's reply answers a run through exactly this event —
 *  so its arrival is proved the same way. It is skipped only when the webhooks
 *  wait proved nothing arrives at all: the same silence waited out twice
 *  proves nothing new. */
async function checkCommentDelivery(probe: Probe, store: Store, app: GitHubApp, posted: Diaried) {
  const { ctx, windowMs, checks, repoId, number } = probe;
  if (!posted.mine && !posted.others) {
    await ctx.prompts.log.message(
      'comments: skipped — it waits on the same webhook; with nothing arriving it could prove nothing.',
    );
    checks.push({
      name: 'comments',
      pass: false,
      detail: 'not tested — no webhook arrived for the webhooks check either',
    });
    return;
  }
  const events = ctx.prompts.spinner();
  events.start(`comments: posting a comment on ${repoId}#${number}…`);
  const [owner = '', name = ''] = repoId.split('/');
  try {
    await app.octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: number,
      body: 'aivi add test comment.',
    });
    events.message('Posted — waiting for the comment delivery…');
    const arrived = await waitDiary(
      store,
      probe,
      posted.last,
      windowMs,
      (event, payload) =>
        event === 'issue_comment' && payload?.action === 'created' && payload?.issue?.number === number,
      line => events.message(line),
    );
    if (arrived.mine) {
      const detail = 'comment delivery arrived and verified — the conversation path is open';
      events.stop(`comments — ${detail}`);
      checks.push({ name: 'comments', pass: true, detail });
    } else {
      const detail = `the comment delivery did not arrive in ${windowMs / 1000} s — tick Issue comments under "Choose which events must notify the webhook" on the app`;
      events.cancel(`comments — ${detail}`);
      checks.push({ name: 'comments', pass: false, detail });
    }
  } catch (error) {
    events.cancel('comments — stopped before the comment delivery could be seen');
    throw error;
  }
}

/** The newest diary row id right now. Whatever exists before a test starts is
 *  nobody's business; anything the test draws lands with a larger id. */
const latestId = (store: Store): number => {
  let last = 0;
  let rows = store.requests({ sinceId: last });
  while (rows.length) {
    last = rows[rows.length - 1]!.id;
    rows = store.requests({ sinceId: last });
  }
  return last;
};

/** What one wait saw in the diary. */
interface Diaried {
  /** Verified deliveries this wait accepts and that name our issue — its proof. */
  mine: number;
  /** Verified deliveries about other issues: the URL works; the events ticked
   *  on the webhook decide what arrives. */
  others: number;
  /** The diary cursor to hand to the next wait. */
  last: number;
}

/**
 * Watch the diary from `cursor` until one verified delivery that `accepts`
 * names our issue, or `ms` has passed. Every delivery is verified with the
 * module's own seal check first — GitHub signs the raw bytes, so the diary's
 * stored body is what stands in for them (the host logs what arrived). A
 * delivery that fails verification ends the installer at once: the secret
 * would be wrong for every delivery, so waiting cannot help.
 */
async function waitDiary(
  store: Store,
  probe: Probe,
  cursor: number,
  ms: number,
  accepts: (event: string, payload: any) => boolean,
  say: (line: string) => void,
): Promise<Diaried> {
  const { webhookSecret } = probe;
  const webhookPath = GITHUB_WEBHOOK_PATH;
  let mine = 0;
  let others = 0;
  let last = cursor;
  await new Promise<void>((settledPromise, failed) => {
    let done = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      // `aivi host clear-logs` can empty the diary and restart its ids below
      // our cursor; when that happens, follow the fresh diary, not the mark.
      if (latestId(store) < last) last = 0;
      for (const row of store.requests({ method: 'POST', path: webhookPath, sinceId: last })) {
        last = row.id;
        if (row.truncated)
          throw new Error(
            `a delivery arrived but the diary cut its body at 8 KiB (row ${row.id}) — verification needs the whole body.`,
          );
        const body = Buffer.from(row.body ?? '', 'utf8');
        if (!verifyWebhookSignature(webhookSecret, body, row.headers['x-hub-signature-256'] ?? ''))
          throw new Error(
            `a delivery arrived but failed the module's own check: bad signature (HTTP ${row.status}).` +
              ' The secret pasted here is not the one GitHub sends.',
          );
        const event = row.headers['x-github-event'] ?? '';
        const payload = JSON.parse(row.body ?? '{}');
        say(`Heard: ${describeDelivery(event, payload)}`); // every delivery, the moment it lands
        if (!aboutProbe(payload, probe)) {
          others++;
          continue;
        }
        // The proof is in: a passed wait is nobody's waiting room, and the
        // stop's own read finishes nothing this loop has left to say.
        if (accepts(event, payload)) {
          mine++;
          stop();
          return;
        }
      }
    };
    const stop = (error?: Error): void => {
      if (done) return;
      done = true;
      if (poll !== undefined) clearTimeout(poll);
      if (expiry !== undefined) clearTimeout(expiry);
      if (error === undefined) {
        try {
          read(); // the deadline read: complete even if a tick was late
        } catch (cause) {
          failed(cause as Error);
          return;
        }
        settledPromise();
      } else failed(error);
    };
    const tick = (): void => {
      try {
        read();
      } catch (cause) {
        stop(cause as Error);
        return;
      }
      // Self-rescheduling: one pending timer, always, and a slow read
      // cannot pile up behind itself. And a read that ended the wait is
      // never re-armed: no timer outlives the verdict.
      if (done) return;
      poll = setTimeout(tick, POLL_MS);
    };
    poll = setTimeout(tick, POLL_MS); // the reliable arrival signal across processes: a re-read
    expiry = setTimeout(() => stop(), ms); // the window's end: a known instant
    try {
      read(); // whatever already arrived before the watching began
    } catch (cause) {
      stop(cause as Error);
    }
  });
  return { mine, others, last };
}

export default setup;
