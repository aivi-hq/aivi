/**
 * The setup `aivi install linear` runs: everything Linear-specific lives in
 * this file. It starts only when a live aivi answers its health endpoint —
 * the test observes what that host's request diary records, so no host, no
 * install. It asks for the app's credentials and proves them at Linear,
 * installs the app through a browser round, then — before writing anything —
 * tests the two systems the module lives on in two waits that run one
 * after the other: that Linear posts deliveries to this URL, and that
 * delegating a throwaway ticket creates an agent session whose created
 * event arrives the same way. The flow draws its own lines with the clack
 * the runner's prompts render with — one live line per wait, settled by
 * clack's own verdict marks: a hollow green diamond for passed, a red
 * square for failed. It ends with its own last line. The ticket is created
 * and archived by the installer; a passed test is nobody's waiting room.
 * Nobody opens an agent session by hand; we only watch what Linear does.
 * Only after the checks have a verdict is anything written. Performing a
 * restart never belongs to this flow — the CLI owns that, and reports it
 * as it happens.
 */
import { createServer } from 'node:http';
import { configSchema, errorMessage, hostUrl, linearPrimarySecretNames, PROJECT_ID } from '@aivi/core';
import {
  type PluginSetup,
  PluginSetupCancelled,
  type PluginSetupContext,
  type PluginSetupResult,
  type Store,
} from '@aivi/plugin';
import { LinearClient, type LinearTeam } from './client.ts';
import { appWebhookPath } from './routes.ts';
import { isAgentSessionEvent, isIssueEvent, type LinearWebhook, verifyWebhook } from './webhook.ts';

/** How long the diary is watched when a check cannot pass: silence is a
 *  result too, and only a waited-out silence proves it. A test where both
 *  systems show themselves ends at once and waits for nothing. Tests
 *  shorten the window; people get the honest cap. */
const DEFAULT_WINDOW_MS = 90_000;
const probeWindowMs = () => Number(process.env.AIVI_PROBE_WINDOW_MS ?? DEFAULT_WINDOW_MS);

/** Clack answers Ctrl+C with its cancel symbol and an empty Enter with
 *  nothing — neither is an answer. The flow stops with
 *  `PluginSetupCancelled` and the runner says the one cancel line; prompts
 *  that must not be empty say so in their `validate`, so clack re-asks
 *  before this ever sees the gap. Named by what it decides: did the
 *  prompt settle? */
function settled<T>(ctx: PluginSetupContext, answer: T): Exclude<NonNullable<T>, symbol> {
  if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('a prompt was cancelled');
  if (answer === undefined) throw new PluginSetupCancelled('a prompt was submitted empty');
  return answer as Exclude<NonNullable<T>, symbol>;
}

/** What the install asks Linear to let the app do; `app:assignable` is
 *  what lets it be a delegate. See `authorizeUrl` for the link itself. */
const INSTALL_SCOPES = 'read,write,app:assignable,app:mentionable';

interface InstallListener {
  /** Resolves with the code the browser brought back. */
  code: Promise<string>;
  /** Resolves with the callback URL to point the install at, once bound. */
  ready: Promise<string>;
  close(): void;
}

/**
 * The one-shot loopback listener: bind, print, wait, close. Anything that
 * is not our callback — the browser's favicon.ico probe among them — is a
 * 404 that never touches the code. It binds an ephemeral port (0) before
 * the instructions print, so the human registers exactly this callback on
 * the app and the install link is accepted first try.
 */
const catchInstall = (): InstallListener => {
  let ok: (code: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let bindFailed: (error: Error) => void = () => {};
  const code = new Promise<string>((resolvePromise, rejectPromise) => {
    ok = resolvePromise;
    fail = rejectPromise;
  });
  // A rejection the installer answers with its own message must not crash the
  // process on its way past.
  code.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const got = url.pathname === '/callback' ? url.searchParams.get('code') : null;
    if (!got) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<!doctype html><title>aivi</title><h1>Linear is installed</h1><p>You can close this window and go back to the CLI.</p>',
      );
    ok(got);
  });
  const ready = new Promise<string>((resolvePromise, rejectPromise) => {
    bindFailed = rejectPromise;
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address !== 'string') resolvePromise(`http://127.0.0.1:${address.port}/callback`);
      else rejectPromise(new Error('the install listener could not report its port'));
    });
  });
  ready.catch(() => {});
  server.on('error', error => {
    const failure = new Error(`the install listener could not listen: ${errorMessage(error)}`);
    fail(failure);
    bindFailed(failure);
  });
  return {
    code,
    ready,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
};

/**
 * Linear compares `redirect_uri` against the registered string as it is
 * written — percent-encoding it is refused — so the URL goes out exactly
 * as the human registered it. The scopes are what delegation and replies
 * need: `app:assignable` is what lets the app be a delegate.
 */
const authorizeUrl = (clientId: string, redirect: string): string =>
  'https://linear.app/oauth/authorize' +
  `?client_id=${clientId}&redirect_uri=${redirect}&response_type=code&actor=app&scope=${INSTALL_SCOPES}`;

/**
 * The code is traded for an access token the module never uses: the
 * exchange is what makes the install real, and the app's own
 * client-credentials token is all the module needs from then on.
 */
const completeInstall = async (
  ctx: PluginSetupContext,
  clientId: string,
  clientSecret: string,
  code: string,
  redirect: string,
): Promise<void> => {
  const response = await ctx.fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      redirect_uri: redirect,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok)
    throw new Error(`Linear refused the install code (HTTP ${response.status}): ${await response.text()}`);
};

/** The installer is a second process and file events do not report SQLite's WAL
 *  writes (macOS never mentions them, measured 2026-09-26), so the diary is
 *  re-read on this quiet interval — one query on an indexed column. */
const POLL_MS = 2_000;

const setup: PluginSetup = async (ctx: PluginSetupContext): Promise<PluginSetupResult> => {
  const windowMs = probeWindowMs();
  const config = configSchema.parse(ctx.config);
  const configured = Object.keys(config.linear?.apps ?? {});
  if (configured.length > 1)
    throw new Error(
      `this aivi already has ${configured.length} Linear apps; the installer configures the one app — edit config.json and .env by hand (docs/linear.md).`,
    );

  // The test observes what the running host records in its request diary:
  // with no live aivi there is nothing to observe, and finding that out at
  // the end wastes a whole install round. The host is alive when it answers
  // `GET /health` on its endpoint, whatever its version — the same test the
  // CLI uses. The installer does not own restarts, so a no is final.
  const hostIsUp = await ctx
    .fetch(`${hostUrl(config.host)}/health`, { signal: AbortSignal.timeout(2_000) })
    .then(response => response.ok)
    .catch(() => false);
  if (!hostIsUp)
    throw new Error(
      'aivi must be running while the installer tests the webhook: start it (`aivi serve`, or `aivi service restart`) and run `aivi install linear` again.',
    );

  // 1. The name aivi calls this app, and the URL Linear can reach it at.
  const id =
    configured[0] ??
    settled(
      ctx,
      await ctx.prompts.text({
        message: 'What should aivi call this Linear app?',
        placeholder: 'e.g. linear-assistant',
        validate: value =>
          value !== undefined && PROJECT_ID.test(value)
            ? undefined
            : 'lowercase letters, digits, dashes and underscores',
      }),
    );
  const webhookPath = appWebhookPath(id);
  let base = config.host.public;
  if (!base) {
    ctx.prompts.note(
      [
        'Linear posts webhooks to this aivi, so it needs a URL Linear can reach.',
        'A tunnel is the usual answer — a Tailscale Funnel or similar pointed at aivi.',
        'aivi cannot discover this URL itself, so the setup asks once and saves it;',
        'later runs will not ask.',
      ].join('\n'),
      'Linear reaches aivi',
    );
    base = settled(
      ctx,
      await ctx.prompts.text({
        message: 'The public URL Linear can reach this aivi at',
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
  const webhookUrl = `${base}${webhookPath}`;

  // 2. The credentials, proven at Linear before anything is written. The
  //    install listener binds first because the app must have its exact
  //    Redirect URI registered before the install link is accepted — so
  //    the instructions print the URL the installer is really listening on.
  //    Every exit from this section closes the listener: a bound server
  //    keeps the process alive after the last line is said, and a
  //    mistyped secret used to hang the installer on its 401 rather than
  //    let it exit (seen live 2026-09-27).
  const install = catchInstall();
  let clientId: string;
  let clientSecret: string;
  let client: LinearClient;
  let viewer: string;
  let teams: LinearTeam[];
  try {
    const redirect = await install.ready;
    ctx.prompts.note(
      [
        '1. Open https://linear.app/settings/api/applications/new',
        '2. App name is the bot’s name; Developer name is yours.',
        `3. Redirect URIs: ${redirect}`,
        '4. Tick Client credentials and Webhooks.',
        `5. Webhook URL: ${webhookUrl}`,
        '   Tick the checkboxes for Issues under Data change events',
        '   and Agent session events under App events.',
        '6. Press Create, then copy the Client ID and Client Secret below.',
      ].join('\n'),
      'Creating the Linear app',
    );
    clientId = settled(
      ctx,
      await ctx.prompts.text({
        message: 'The app’s Client ID',
        placeholder: 'cli_…',
        validate: value => (value ? undefined : 'Paste the Client ID from the app page'),
      }),
    );
    clientSecret = settled(
      ctx,
      await ctx.prompts.password({
        message: 'The app’s Client Secret',
        validate: value => (value ? undefined : 'Paste the Client Secret from the app page'),
      }),
    );
    client = new LinearClient({ clientId, clientSecret }, { fetch: ctx.fetch });
    viewer = await client.viewerId();
    await ctx.prompts.log.message('Linear took the credentials — the app answers as its own bot user.');
    teams = await client.listTeams();
    await ctx.prompts.log.message(
      `The app can see ${teams.length ? teams.map(t => `${t.key} (${t.name})`).join(', ') : 'no teams'}.`,
    );
    // The install URL goes out on a bare line: the operator copies it, and
    // note boxes and log guides put characters in the way of copying.
    ctx.print(`Install the app — open this once and allow it:\n\n${authorizeUrl(clientId, redirect)}`);
    const installCode = await install.code;
    await completeInstall(ctx, clientId, clientSecret, installCode, redirect);
  } finally {
    install.close();
  }
  await ctx.prompts.log.message('Installed.');
  const webhookSecret = settled(
    ctx,
    await ctx.prompts.password({
      message: 'The webhook’s Signing Secret',
      validate: value => (value ? undefined : 'Paste the Signing Secret from the webhook section'),
    }),
  );

  // 3. The test, before any write: one throwaway ticket, proven in two
  //    waits that run one after the other, named for the systems the module
  //    lives on — first that Linear posts deliveries to this URL, then that
  //    delegating the ticket creates an agent session whose created event
  //    arrives the same way. Clack animates one live line and prints
  //    nothing beside it, so each wait takes the screen in turn: its line
  //    says what just landed, and its verdict closes the line with clack's
  //    own marks — a hollow green diamond for passed, a red square for
  //    failed — and a failure names the likeliest cause. With the module not
  //    yet loaded, every delivery is recorded untouched: pure observation
  //    of Linear's behavior. A wait that passes is not made to sit out a
  //    window; the window is what a failure needs, because silence is a
  //    result too and only a waited-out silence proves it.
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  if (!teams.length) {
    await ctx.prompts.log.message(
      'The app sees no teams, so there is nowhere to put the throwaway ticket — the checks are skipped.',
    );
  } else {
    // What the test does is said before the operator is asked to point it
    // at a team; starting it takes no further confirmation.
    ctx.prompts.note(
      [
        'The installer will now test if the webhook works. It does this by',
        'creating a temporary ticket, delegating it to the app, and watching',
        'the webhooks Linear posts back. It archives the ticket when the',
        'test ends. When Linear can reach this aivi, the test takes seconds.',
      ].join('\n'),
      'Testing the configuration',
    );
    const teamId = settled(
      ctx,
      await ctx.prompts.select({
        message: 'Which team gets the throwaway ticket?',
        options: teams.map(t => ({ value: t.id, label: `${t.key} — ${t.name}` })),
      }),
    );
    // The store door the runner supplies: the home database is open for this
    // block and closed after it, whatever the two waits do.
    await ctx.withStore(async store => {
      // Whatever the diary holds before the test ticket exists is nobody's
      // business; the cursor starts at its newest row.
      const cursor = latestId(store);
      const issue = await client.createIssue({
        teamId,
        title: 'aivi install test — safe to delete',
        description: `Created by \`aivi install linear\` to test the webhook at ${webhookUrl}. The installer archives it when the test ends.`,
      });
      await ctx.prompts.log.message(`Created ${issue.identifier}.`);
      // One live line, opened with what it waits for: clack animates one
      // line at a time, and this flow only ever opens one while the
      // previous has settled. `stop` closes it with clack's settled mark,
      // a hollow green diamond; `cancel` with a red square.
      // The webhooks wait first: Linear must post the ticket's creation
      // to the URL before anything else has proof to stand on.
      const webhooks = ctx.prompts.spinner();
      webhooks.start(`webhooks: waiting for Linear to post about ${issue.identifier}…`);
      let posted: Diaried;
      try {
        posted = await waitDiary(store, webhookPath, webhookSecret, issue.id, cursor, windowMs, isIssueEvent, line =>
          webhooks.message(line),
        );
      } catch (error) {
        webhooks.cancel('webhooks — a delivery arrived that did not verify');
        throw error;
      }
      // A verdict is said on the live line and recorded for the summary,
      // together, in every branch.
      if (posted.mine) {
        const detail = `${posted.mine} issue ${posted.mine === 1 ? 'delivery' : 'deliveries'} arrived and verified`;
        webhooks.stop(`webhooks — ${detail}`);
        checks.push({ name: 'webhooks', pass: true, detail });
      } else if (posted.others) {
        const detail = `deliveries arrived, but none about ${issue.identifier} — the categories ticked on the webhook decide what Linear posts`;
        webhooks.cancel(`webhooks — ${detail}`);
        checks.push({ name: 'webhooks', pass: false, detail });
      } else {
        const detail = `nothing arrived in ${windowMs / 1000} s — the Webhook URL on the app is not this one, the categories are off, or Linear cannot reach this machine`;
        webhooks.cancel(`webhooks — ${detail}`);
        checks.push({ name: 'webhooks', pass: false, detail });
      }
      // The agent-events wait needs a delegation of its own: becoming
      // the delegate is what makes Linear create the session, and the
      // session's own delivery proves the app is subscribed to those
      // too. It is skipped only when the webhooks wait proved nothing
      // arrives at all — the same silence waited out twice proves
      // nothing new.
      if (!posted.mine && !posted.others) {
        await ctx.prompts.log.message(
          'agent events: skipped — it waits on the same webhooks; with nothing arriving it could prove nothing.',
        );
        checks.push({
          name: 'agent events',
          pass: false,
          detail: 'not tested — no webhook arrived for the webhooks check either',
        });
      } else {
        const events = ctx.prompts.spinner();
        events.start(`agent events: delegating ${issue.identifier} to the app…`);
        let delegated: Diaried;
        // Linear's own answer to the delegation names the session it
        // created; its arrival is settled the instant the mutation lands.
        let made = false;
        try {
          const answer = await client.setDelegate(issue.id, viewer);
          made = answer.issue?.agentSessions.nodes.some(s => s.status === 'pending') ?? false;
          events.message('Delegated — waiting for the session event…');
          delegated = await waitDiary(
            store,
            webhookPath,
            webhookSecret,
            issue.id,
            posted.last,
            windowMs,
            isAgentSessionEvent,
            line => events.message(line),
          );
        } catch (error) {
          events.cancel('agent events — stopped before the session event could be seen');
          throw error;
        }
        if (delegated.mine) {
          const detail = made
            ? 'delegation created the session and its created event arrived'
            : 'a created session event arrived though the delegate answer named no session';
          events.stop(`agent events — ${detail}`);
          checks.push({ name: 'agent events', pass: true, detail });
        } else if (made) {
          const detail = `the session was created but its event did not arrive in ${windowMs / 1000} s — tick Agent session events under App events on the app`;
          events.cancel(`agent events — ${detail}`);
          checks.push({ name: 'agent events', pass: false, detail });
        } else {
          const detail = 'no session at all — the app took the delegation but Linear made nothing to work from';
          events.cancel(`agent events — ${detail}`);
          checks.push({ name: 'agent events', pass: false, detail });
        }
      }
      // The installer made the ticket, so the installer tidies it — Linear's
      // delete archives it, off the board. A delete that fails is said, not
      // swallowed, so a ticket is never left without the operator knowing.
      try {
        await client.deleteIssue(issue.id);
        await ctx.prompts.log.message(`${issue.identifier} archived.`);
      } catch (error) {
        await ctx.prompts.log.message(
          `Could not archive ${issue.identifier} — delete it by hand (${errorMessage(error)}).`,
        );
      }
    });
  }

  // 4. Only now is anything written: the secrets under the bare primary
  //    names, `host.public` if the installer asked for it, and the `linear` block
  //    with this app added.
  if (!config.host.public) await ctx.writeConfigBlock(['host', 'public'], base);
  await ctx.writeSecret(linearPrimarySecretNames.clientId, clientId);
  await ctx.writeSecret(linearPrimarySecretNames.clientSecret, clientSecret);
  await ctx.writeSecret(linearPrimarySecretNames.webhookSecret, webhookSecret);
  const existing = (ctx.config.linear ?? {}) as Record<string, unknown>;
  await ctx.writeConfigBlock(['linear'], {
    ...existing,
    apps: { ...((existing.apps ?? {}) as Record<string, unknown>), [id]: {} },
  });

  const failed = checks.filter(c => !c.pass);
  const outcome = !checks.length
    ? 'nothing was tested — the app sees no teams, so there was nowhere to put the throwaway ticket'
    : failed.length
      ? `FAILED — ${failed.map(c => `${c.name}: ${c.detail}`).join('; ')}. Fix that and run the install again`
      : 'both checks passed';
  // The installer started only because a live aivi answered its health
  // endpoint, so what loads the module is its own line to say; when a
  // service is installed the CLI restarts it anyway and reports that as
  // it happens. Performing a restart never belongs to this flow.
  return {
    module: 'linear',
    summary: failed.length
      ? `Linear is configured: ${outcome}.`
      : `Linear is configured: ${outcome}. Restart aivi to load Linear.`,
  };
};

/** What one delivery is about, and whether it names our test ticket. */
const namesIssue = (payload: LinearWebhook, issueId: string): boolean =>
  isIssueEvent(payload)
    ? payload.data.id === issueId
    : isAgentSessionEvent(payload) && payload.agentSession.issue?.id === issueId;

/** One line saying what a verified delivery is, in Linear's own words, naming
 *  the issue it is about — during a test several issues can be in play. The
 *  status our side answered with is left out on purpose: with the module not
 *  yet loaded nothing can answer 2xx, and the delivery arriving is the point. */
const describeDelivery = (payload: LinearWebhook): string => {
  if (isAgentSessionEvent(payload)) {
    const issue = payload.agentSession.issue?.identifier ?? 'an issue the payload did not name';
    return `agent-session event: ${payload.action}${payload.agentSession.status ? `, status ${payload.agentSession.status}` : ''} on ${issue}`;
  }
  if (isIssueEvent(payload)) {
    const changed =
      payload.action === 'update' && payload.updatedFrom ? Object.keys(payload.updatedFrom).join(', ') : '';
    return `issue ${payload.action} on ${payload.data.identifier ?? 'an issue the payload did not name'}${changed ? `, changed ${changed}` : ''}`;
  }
  return `${payload.type} ${payload.action}`;
};

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
  /** Verified deliveries this wait accepts and that name our ticket — its proof. */
  mine: number;
  /** Verified deliveries about other issues: the URL works; the categories
   *  ticked on the webhook decide what arrives. */
  others: number;
  /** The diary cursor to hand to the next wait. */
  last: number;
}

/**
 * Watch the diary from `cursor` until one verified delivery that `accepts`
 * names our ticket, or `ms` has passed. A wait that passes is not made to
 * sit out its window; the window is what a failure needs, because silence
 * is a result too and only a waited-out silence proves it. The installer is
 * another process than the server, and file events do not report SQLite's
 * WAL writes — macOS never mentions them (measured 2026-09-26) — so a quiet
 * re-read of one indexed query is the reliable arrival signal. Every
 * verified delivery is said the moment it lands, whatever issue it names:
 * the line belongs to the wait's spinner. A delivery that fails the
 * module's own `verifyWebhook` ends the installer at once — the signing
 * secret would be wrong for every delivery, so waiting cannot help.
 */
async function waitDiary(
  store: Store,
  path: string,
  webhookSecret: string,
  issueId: string,
  cursor: number,
  ms: number,
  accepts: (payload: LinearWebhook) => boolean,
  say: (line: string) => void,
): Promise<Diaried> {
  let mine = 0;
  let others = 0;
  let last = cursor;
  await new Promise<void>((settled, failed) => {
    let done = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      // `aivi host clear-logs` can empty the diary and restart its ids below
      // our cursor; when that happens, follow the fresh diary, not the mark.
      if (latestId(store) < last) last = 0;
      for (const row of store.requests({ method: 'POST', path, sinceId: last })) {
        last = row.id;
        if (row.truncated)
          throw new Error(
            `a delivery arrived but the diary cut its body at 8 KiB (row ${row.id}) — verification needs the whole body.`,
          );
        const verdict = verifyWebhook({
          body: Buffer.from(row.body ?? '', 'utf8'),
          signature: row.headers['linear-signature'],
          secret: webhookSecret,
          now: row.at,
        });
        if (!verdict.ok)
          throw new Error(
            `a delivery arrived but failed the module's own check: ${verdict.reason} (HTTP ${row.status}).` +
              (verdict.reason.includes('signature')
                ? ' The signing secret pasted here is not the one Linear sends.'
                : ''),
          );
        say(`Heard: ${describeDelivery(verdict.payload)}`); // every delivery, the moment it lands
        if (!namesIssue(verdict.payload, issueId)) {
          others++;
          continue;
        }
        // The proof is in: a passed wait is nobody's waiting room, and the
        // stop's own read finishes nothing this loop has left to say.
        if (accepts(verdict.payload)) {
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
        settled();
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
