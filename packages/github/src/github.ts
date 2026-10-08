/** Everything that authenticates to GitHub. The app's private key mints a JWT,
 *  the JWT mints an **installation token**, and every call and every git
 *  transfer below carries that token — the GitHub shape of Linear's app-actor
 *  dance, and octokit owns its whole life: it caches the token, renews it when
 *  it is due, and retries a 401 that lands inside GitHub's token-replication
 *  delay. Nothing here mints per command or caches by hand; nothing here ever
 *  sees a human's credential.
 *
 *  The app's identity is **environment, not config** (ruled 2026-10-07): the
 *  forge and the tracker speak as one app, and a plugin block cannot be the
 *  shared source for two plugins. `GITHUB_APP_ID` stands beside
 *  `GITHUB_APP_PRIVATE_KEY` in `<home>/.env`, which the host loads before any
 *  module starts.
 *
 *  One installation and only one (ruled 2026-09-29): an installation is the
 *  grant from an account to the app for a set of repositories, and aivi has no
 *  vocabulary for more than one grant. Zero or several is a setup error with
 *  the link that fixes it, never a mode.
 *
 *  This is a plain library: no module, no config block, no board words. Lanes
 *  and tickets are the tracker's; remotes and pull requests are the forge's.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { getLogger, type Logger } from '@aivi/core';
import { ConfigurationError } from '@aivi/plugin';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit as OctokitCore } from '@octokit/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { retry } from '@octokit/plugin-retry';

/** The environment name the app's numeric id is read from — the number on the
 *  app settings page, not its name. */
export const GITHUB_APP_ID_ENV = 'GITHUB_APP_ID';
/** The environment name the app's PEM private key is read from. It is a
 *  secret, so it is never in `config.json`, never echoed by a flow, and never
 *  inherited by a task script (`<home>/.env`'s keys are all protected). */
export const GITHUB_PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';

/** octokit as aivi actually needs it: the core, the endpoint methods, and the
 *  retry that sleeps only after a real failure. Built from the parts and not
 *  the umbrella on purpose — the umbrella bolts on its throttling plugin,
 *  whose Bottleneck enforces a fixed one-second gap in front of *every* write
 *  whether GitHub complained or not: a person's `aivi pr` would pace one write
 *  per second, and every test pays seconds for a rate limit nobody hit. aivi
 *  is one caller making a handful of writes; GitHub's rate limits get answered
 *  when they arrive (`retry` re-sends what failed), never pre-scheduled. */
const Octokit = OctokitCore.plugin(restEndpointMethods, retry);
export type Octokit = InstanceType<typeof Octokit>;

const run = promisify(execFile);

/** The username GitHub's HTTPS transport takes with an installation token: the
 *  token is the password, and the name says what kind of caller it is. */
export const GIT_USER = 'x-access-token';

/** The app's credential: what it is, and the key that proves it. */
export interface GitHubCredentials {
  appId: number;
  privateKey: string;
}

/**
 * The app's private key, from the environment. A PEM pasted into a `.env` file
 * usually arrives as one line with literal `\n` two-character sequences — the
 * file format has no way to hold a newline otherwise — so they are turned back
 * into newlines here, and a key that is not a private key at all is said in
 * words aivi can name rather than as octokit's complaint about key formats.
 */
export function githubPrivateKey(env: NodeJS.ProcessEnv = process.env): string {
  const written = env[GITHUB_PRIVATE_KEY_ENV];
  if (!written)
    throw new ConfigurationError(
      `github: ${GITHUB_PRIVATE_KEY_ENV} is not set. Put the app's PEM private key in <home>/.env — the same key you pasted on the app settings page, not the public one.`,
    );
  const privateKey = written.includes('\\n') ? written.replaceAll('\\n', '\n') : written;
  if (!privateKey.includes('PRIVATE KEY-----'))
    throw new ConfigurationError(
      `github: ${GITHUB_PRIVATE_KEY_ENV} is not a PEM private key (no "-----BEGIN … PRIVATE KEY-----" line). Copy the whole key, including both lines that begin with dashes.`,
    );
  return privateKey;
}

/**
 * The app's credential, both halves from the environment (ruled 2026-10-07):
 * the id joined the key in `<home>/.env` so that every plugin speaking GitHub
 * authenticates as the same app from one place.
 */
export function githubCredentials(env: NodeJS.ProcessEnv = process.env): GitHubCredentials {
  const written = env[GITHUB_APP_ID_ENV];
  if (!written || !written.trim())
    throw new ConfigurationError(
      `github: ${GITHUB_APP_ID_ENV} is not set. Put the app's numeric id — the number on the app settings page, next to "App ID" — in <home>/.env.`,
    );
  const appId = Number(written.trim());
  if (!Number.isInteger(appId) || appId <= 0)
    throw new ConfigurationError(
      `github: ${GITHUB_APP_ID_ENV} is "${written.trim()}", not a number. Put the app's numeric id, as on the app settings page, in <home>/.env.`,
    );
  return { appId, privateKey: githubPrivateKey(env) };
}

/** The directory the person ran the command from. `npm run` moves the
 *  process into the package root and leaves the real directory in
 *  `INIT_CWD`; a relative path the person typed means their directory,
 *  not npm's — resolving it against the package root fails a typed
 *  `./.config/…pem` with ENOENT. */
export const shellCwd = (): string => process.env.INIT_CWD ?? process.cwd();

/** A path as the person typed it: `~` is their home, and a relative path
 *  starts at the directory they ran the command from. */
export function resolveKeyPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~' || trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(shellCwd(), trimmed);
}

/**
 * A PEM as one line of a dotenv file: double-quoted, its newlines written as
 * `\n`. A private key is many lines and the file is line-based — quoting is
 * what Node's own loader understands, and the reader above unwraps the same
 * shape again in case anything reads it more plainly.
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

/** How aivi reaches GitHub: octokit's host, or the fetch a test scripts. */
export interface GitHubOptions {
  fetch?: typeof globalThis.fetch;
  log?: Logger;
  /** Credentials from somewhere other than the environment: setup, which has
   *  just read the bytes it is proving and must not wait on a reload. Nothing
   *  else passes this; the environment is the source (ruled 2026-10-07). */
  credentials?: GitHubCredentials;
  /** Whether octokit silently retries failed requests with backoff — on by
   *  default. A test that scripts its own failures turns it off: a scripted
   *  5xx must stand as the answer, not invite a minute of hidden re-asks.
   *  aivi's own retries are its own (closings, wakes); this one is the
   *  transport's. */
  retry?: { enabled?: boolean };
}

/** The app authenticated as **itself**: it can name itself and list its
 *  installations, and no repository at all — the installation is what grants
 *  those. Used to find the one grant and to prove the key matches the id. */
function appClient(
  creds: GitHubCredentials,
  fetch?: typeof globalThis.fetch,
  retry?: { enabled?: boolean },
  log?: Logger,
): Octokit {
  const request = requestOptions(fetch, log);
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.appId, privateKey: creds.privateKey },
    ...(request ? { request } : {}),
    ...(retry ? { retry } : {}),
  });
}

/** Octokit's transport warns of GitHub's deprecation headers straight to
 *  `console.warn` — which writes over a wizard's TUI mid-spinner. The
 *  warning is true and the endpoint works until its sunset date; the fact
 *  belongs in aivi's log, where startup decides once whether it is heard
 *  (silent in a plain CLI run, a line in the host's log). The transport
 *  reads it at `request.log` and nowhere else. */
const requestOptions = (fetch?: typeof globalThis.fetch, log?: Logger) => {
  const options = {
    ...(fetch ? { fetch } : {}),
    ...(log ? { log: octokitLog(log) } : {}),
  };
  return Object.keys(options).length ? options : undefined;
};

const octokitLog = (log: Logger) => ({
  debug: (message: string, ...args: unknown[]) => log.debug(message, args.length ? { args } : undefined),
  info: (message: string, ...args: unknown[]) => log.info(message, args.length ? { args } : undefined),
  warn: (message: string, ...args: unknown[]) => log.warn(message, args.length ? { args } : undefined),
  error: (message: string, ...args: unknown[]) => log.error(message, args.length ? { args } : undefined),
});

/** What the grant itself says it allows, read with the app's JWT. */
export interface GitHubGrant {
  /** What the app's webhook subscribes to (`*` when it subscribes to all). */
  events: string[];
  /** What the grant lets the app touch, e.g. `{ issues: 'write' }`. */
  permissions: Record<string, string>;
}

/** The webhook on the app's own settings page: where GitHub posts. */
export interface GitHubWebhookConfig {
  url: string;
  insecureSsl: boolean;
}

/** One delivery to that webhook and the answer the host gave — the trail a
 *  setup flow reads before it believes its own URL. */
export interface GitHubWebhookDelivery {
  id: string;
  event: string;
  action: string | null;
  status: string;
  statusCode: number;
}

/**
 * The app as aivi uses it: installed on one account, holding one installation
 * token, ready to speak about the repositories under that grant.
 */
export class GitHubApp {
  /** The grant every token below is minted from. */
  readonly installationId: number;
  /** Whose account made the grant — an org, or a person's own repositories. */
  readonly accountLogin: string;
  /** The app's URL name, for the links a person is sent to. */
  readonly appSlug: string;
  /** The installation-authenticated client: every API call aivi makes. */
  readonly octokit: Octokit;

  /** The app-JWT client: the app's own settings, which no installation token
   *  reaches. Only the setup-side reads below cross to it. */
  private readonly app: Octokit;

  private readonly log: Logger;

  private constructor(
    octokit: Octokit,
    app: Octokit,
    installationId: number,
    accountLogin: string,
    appSlug: string,
    log: Logger,
  ) {
    this.octokit = octokit;
    this.app = app;
    this.installationId = installationId;
    this.accountLogin = accountLogin;
    this.appSlug = appSlug;
    this.log = log;
  }

  /**
   * Prove the credential, find the one installation, and hand back a client
   * that speaks through it. Every failure is a `ConfigurationError` — a thing
   * the operator fixes on GitHub's site or in `.env`, not a thing to retry:
   * the id and key that do not match, the app nobody installed, the app
   * installed twice.
   */
  static async connect(options: GitHubOptions = {}): Promise<GitHubApp> {
    const log = options.log ?? getLogger(['aivi', 'github']);
    const creds = options.credentials ?? githubCredentials();
    const app = appClient(creds, options.fetch, options.retry, log);
    let slug: string;
    try {
      const { data: itself } = await app.rest.apps.getAuthenticated();
      if (!itself?.slug) throw new Error('GitHub answered with no app');
      slug = itself.slug;
    } catch (error) {
      throw new ConfigurationError(
        `github: GitHub refused the credential for app ${creds.appId} — the id and ${GITHUB_PRIVATE_KEY_ENV} must belong to the same app (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // What GitHub lists is what is granted: a revoked installation is gone from
    // this answer, and a suspended one is not aivi's problem to guess at.
    const { data: granted } = await app.rest.apps.listInstallations({ per_page: 10 });
    if (granted.length === 0)
      throw new ConfigurationError(
        `github: the app ${slug} is installed on no account. Open https://github.com/apps/${slug}/installations/new, select the repositories you want to use aivi in, and run this again.`,
      );
    if (granted.length > 1)
      throw new ConfigurationError(
        `github: the app ${slug} is installed ${granted.length} times (${granted
          .map(i => `${i.account?.login ?? i.account?.id ?? '?'} #${i.id}`)
          .join(', ')}). aivi speaks through one installation: revoke the ones aivi does not need.`,
      );
    const installation = granted[0]!;
    const installationRequest = requestOptions(options.fetch, log);
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: creds.appId, privateKey: creds.privateKey, installationId: installation.id },
      ...(installationRequest ? { request: installationRequest } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
    });
    const account = installation.account?.login ?? String(installation.id);
    log.info('github.ready', { app: slug, installation: installation.id, account });
    return new GitHubApp(octokit, app, installation.id, account, slug, log);
  }

  /** The installation token itself, for the git transport — the same token
   *  octokit is using for API calls, minted or renewed by it. */
  async gitToken(): Promise<string> {
    const auth = await this.octokit.auth({ type: 'installation' });
    const token = (auth as { token?: string }).token;
    if (!token) throw new Error(`github: octokit answered with no installation token for #${this.installationId}`);
    return token;
  }

  /** The repositories this installation was granted, as GitHub itself says:
   *  the same truth `repository` proves one at a time, read from the other
   *  side. Pages until exhausted, capped so a huge grant cannot hang a
   *  wizard waiting on a keystroke. */
  async repositories(cap = 500): Promise<{ id: string; defaultBranch: string }[]> {
    const repos: { id: string; defaultBranch: string }[] = [];
    for (let page = 1; repos.length < cap; page += 1) {
      const { data } = await this.octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100, page });
      const found = data.repositories ?? [];
      repos.push(...found.map(repo => ({ id: repo.full_name, defaultBranch: repo.default_branch })));
      if (found.length < 100) break;
    }
    return repos.slice(0, cap);
  }

  /** One of the app's repositories, through the installation: the read that
   *  proves a repository is really under the grant. Undefined when the app
   *  cannot see it — which GitHub answers 404 for, on purpose, so that a repo
   *  that does not exist and one it was not given look the same. */
  async repository(
    owner: string,
    repo: string,
  ): Promise<{ defaultBranch: string; cloneUrl: string; private: boolean } | undefined> {
    try {
      const { data: found } = await this.octokit.rest.repos.get({ owner, repo });
      return { defaultBranch: found.default_branch, cloneUrl: found.clone_url, private: found.private };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 403) return undefined;
      throw error;
    }
  }

  /** The grant's own record, read with the app's JWT: the events GitHub posts
   *  to this app and the permissions it was given. No installation token reads
   *  its own grant, so this is the setup-side vantage — prove what the tracker
   *  lives on before a byte is written. */
  async grantFacts(): Promise<GitHubGrant> {
    const { data: installation } = await this.app.rest.apps.getInstallation({ installation_id: this.installationId });
    const permissions: Record<string, string> = {};
    for (const [name, level] of Object.entries(installation.permissions ?? {}))
      if (typeof level === 'string') permissions[name] = level;
    return { events: (installation.events ?? []).map(String), permissions };
  }

  /** Where the app's webhook posts, from the app's own settings page. */
  async webhookConfig(): Promise<GitHubWebhookConfig> {
    const { data: hook } = await this.app.rest.apps.getWebhookConfigForApp();
    // GitHub answers `insecure_ssl` as 0/1 (sometimes as a string), not a
    // boolean — anything but the zero is the downgrade.
    const insecure = hook.insecure_ssl;
    return { url: hook.url ?? '', insecureSsl: insecure === undefined ? false : Number(insecure) !== 0 };
  }

  /** Recent deliveries to that webhook, newest first, each with the answer the
   *  host gave. Delivery ids exceed 2^53 (live, 2026-10-07) — strings here,
   *  never numbers. */
  async webhookDeliveries(cap = 5): Promise<GitHubWebhookDelivery[]> {
    const { data: deliveries } = await this.app.rest.apps.listWebhookDeliveries({ per_page: cap });
    return deliveries.slice(0, cap).map(delivery => ({
      id: String(delivery.id),
      event: String(delivery.event),
      action: delivery.action ? String(delivery.action) : null,
      status: String(delivery.status),
      statusCode: Number(delivery.status_code),
    }));
  }

  /** Ask GitHub to post a past delivery again — the installer's way to make a
   *  delivery land while it watches, rather than waiting on an event that may
   *  have fired before anyone was listening. The replay carries the app's
   *  current secret; a replay that fails the installer's own seal check says
   *  the secret pasted is not the one GitHub sends. `deliveryId` stays a
   *  **string** into the path: a >2^53 id coerced to a number loses digits and
   *  the attempt 404s (live, 2026-10-07). */
  async redeliverWebhook(deliveryId: string): Promise<void> {
    await this.app.rest.apps.redeliverWebhookDelivery({ delivery_id: deliveryId as unknown as number });
  }
}

/** The connected app, **once per process** (ruled 2026-10-07): the forge and
 *  the tracker are one app, so whoever connects first is whose client everyone
 *  speaks through — the JWT and the installation read are paid once. A failure
 *  is not cached: the next caller tries again after fixing what the error
 *  named. Tests connect directly and never touch this. */
let shared: Promise<GitHubApp> | undefined;
export function githubApp(options: GitHubOptions = {}): Promise<GitHubApp> {
  shared ??= GitHubApp.connect(options).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

/** One git execution: the GitHub plugins' only crossing to disk. Tests answer
 *  this instead of spawning git — whether git really moves the bytes is git's
 *  own unit, and the live gate's subject; what the unit tests pin is the
 *  caller's decisions: the refspecs it names, the credential it carries, the
 *  failures it classifies and says in a person's words. */
export type GitRunner = typeof runGit;

/** A shell git, run for the app's callers. `env` is what the transport puts
 *  in — the credential rides in the environment, never in argv, where anyone
 *  listing processes could read it. */
export async function runGit(
  directory: string,
  args: string[],
  options: { signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    return { ok: false, message: (failure.stderr || failure.message || String(error)).trim() };
  }
}

/** The environment that makes one git command speak as the app: the
 *  installation token as a Basic header, which is written to no file, and
 *  `credential.helper=` switched off, so the person's stored credential is
 *  never offered and a transfer never quietly attributes to them. Both go in
 *  through `GIT_CONFIG_*`, which git reads as per-invocation config: a token in
 *  argv would be readable to anyone listing processes, and the repository's
 *  own `.git/config` keeps the shape its owner left it. */
export function gitCredential(token: string): Record<string, string> {
  const basic = Buffer.from(`${GIT_USER}:${token}`).toString('base64');
  const settings: [string, string][] = [
    ['http.extraHeader', `Authorization: Basic ${basic}`],
    ['credential.helper', ''],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(settings.length) };
  for (const [i, [key, value]] of settings.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return env;
}
