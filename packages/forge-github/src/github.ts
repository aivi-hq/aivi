/** Everything that authenticates to GitHub. The app's private key mints a JWT,
 *  the JWT mints an **installation token**, and every call and every git
 *  transfer below carries that token — the GitHub shape of Linear's app-actor
 *  dance, and octokit owns its whole life: it caches the token, renews it when
 *  it is due, and retries a 401 that lands inside GitHub's token-replication
 *  delay. Nothing here mints per command or caches by hand; nothing here ever
 *  sees a human's credential.
 *
 *  One installation and only one (ruled 2026-09-29): an installation is the
 *  grant from an account to the app for a set of repositories, and aivi has no
 *  vocabulary for more than one grant. Zero or several is a setup error with
 *  the link that fixes it, never a mode.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger, type Logger } from '@aivi/core';
import { ConfigurationError } from '@aivi/host';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit as OctokitCore } from '@octokit/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { retry } from '@octokit/plugin-retry';
import type { ForgeGithubConfig } from './config.ts';
import { GITHUB_PRIVATE_KEY_ENV } from './config.ts';

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
export function githubCredentials(config: ForgeGithubConfig, env: NodeJS.ProcessEnv = process.env): GitHubCredentials {
  const written = env[GITHUB_PRIVATE_KEY_ENV];
  if (!written)
    throw new ConfigurationError(
      `forge-github: ${GITHUB_PRIVATE_KEY_ENV} is not set. Put the app's PEM private key in <home>/.env — the same key you pasted on the app settings page, not the public one.`,
    );
  const privateKey = written.includes('\\n') ? written.replaceAll('\\n', '\n') : written;
  if (!privateKey.includes('PRIVATE KEY-----'))
    throw new ConfigurationError(
      `forge-github: ${GITHUB_PRIVATE_KEY_ENV} is not a PEM private key (no "-----BEGIN … PRIVATE KEY-----" line). Copy the whole key, including both lines that begin with dashes.`,
    );
  return { appId: config.app, privateKey };
}

/** How aivi reaches GitHub: octokit's host, or the fetch a test scripts. */
export interface GitHubOptions {
  fetch?: typeof globalThis.fetch;
  log?: Logger;
}

/** The app authenticated as **itself**: it can name itself and list its
 *  installations, and no repository at all — the installation is what grants
 *  those. Used to find the one grant and to prove the key matches the id. */
function appClient(creds: GitHubCredentials, fetch?: typeof globalThis.fetch): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.appId, privateKey: creds.privateKey },
    ...(fetch ? { request: { fetch } } : {}),
  });
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

  private readonly log: Logger;

  private constructor(octokit: Octokit, installationId: number, accountLogin: string, appSlug: string, log: Logger) {
    this.octokit = octokit;
    this.installationId = installationId;
    this.accountLogin = accountLogin;
    this.appSlug = appSlug;
    this.log = log;
  }

  /**
   * Prove the config, find the one installation, and hand back a client that
   * speaks through it. Every failure is a `ConfigurationError` — a thing the
   * operator fixes on GitHub's site or in `.env`, not a thing to retry: the id
   * and key that do not match, the app nobody installed, the app installed
   * twice.
   */
  static async connect(config: ForgeGithubConfig, options: GitHubOptions = {}): Promise<GitHubApp> {
    const log = options.log ?? getLogger(['aivi', 'forge-github']);
    const creds = githubCredentials(config, process.env);
    const app = appClient(creds, options.fetch);
    let slug: string;
    try {
      const { data: itself } = await app.rest.apps.getAuthenticated();
      if (!itself?.slug) throw new Error('GitHub answered with no app');
      slug = itself.slug;
    } catch (error) {
      throw new ConfigurationError(
        `forge-github: GitHub refused the credential for app ${config.app} — the id and ${GITHUB_PRIVATE_KEY_ENV} must belong to the same app (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // What GitHub lists is what is granted: a revoked installation is gone from
    // this answer, and a suspended one is not aivi's problem to guess at.
    const { data: granted } = await app.rest.apps.listInstallations({ per_page: 10 });
    if (granted.length === 0)
      throw new ConfigurationError(
        `forge-github: the app ${slug} is installed on no account. Open https://github.com/apps/${slug}/installations/new, grant it the repositories aivi works, and run this again.`,
      );
    if (granted.length > 1)
      throw new ConfigurationError(
        `forge-github: the app ${slug} is installed ${granted.length} times (${granted
          .map(i => `${i.account?.login ?? i.account?.id ?? '?'} #${i.id}`)
          .join(', ')}). aivi speaks through one installation: revoke the ones aivi does not need.`,
      );
    const installation = granted[0]!;
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: creds.appId, privateKey: creds.privateKey, installationId: installation.id },
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    });
    const account = installation.account?.login ?? String(installation.id);
    log.info('github.ready', { app: slug, installation: installation.id, account });
    return new GitHubApp(octokit, installation.id, account, slug, log);
  }

  /** The installation token itself, for the git transport — the same token
   *  octokit is using for API calls, minted or renewed by it. */
  async gitToken(): Promise<string> {
    const auth = await this.octokit.auth({ type: 'installation' });
    const token = (auth as { token?: string }).token;
    if (!token)
      throw new Error(`forge-github: octokit answered with no installation token for #${this.installationId}`);
    return token;
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
}

/** A shell git, run for the forge. `env` is what the transport puts in — the
 *  credential rides in the environment, never in argv, where anyone listing
 *  processes could read it. */
/** One git execution: the forge's only crossing to disk. Tests answer this
 *  instead of spawning git — whether git really moves the bytes is git's own
 *  unit, and the live gate's subject; what the unit tests pin is the forge's
 *  decisions: the refspecs it names, the credential it carries, the failures
 *  it classifies and says in a person's words. */
export type GitRunner = typeof runGit;

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
