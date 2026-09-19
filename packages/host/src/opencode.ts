import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, Logger } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import { OpenCode } from '@opencode/client';
import type { DiscoverOptions, EnsureOptions } from '@opencode/client/service';
import { Service } from '@opencode/client/service';

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export type OpenCodeEnv = Record<string, string | undefined>;
/** A background service aivi found and considers alive, whatever its version. */
export interface DiscoveredEndpoint {
  url: string;
  auth?: { type: 'basic'; username: string; password: string };
  /** The server's own version, when it reports one. */
  version?: string;
}

export interface ConnectHooks {
  /** aivi is about to start the OpenCode service because none was running (or it is being replaced). */
  onStart?: (reason: 'missing' | 'version-mismatch' | 'restart') => void;
  /** Injection points for tests; default to aivi's own tolerant discovery and the SDK. */
  discover?: (options?: DiscoverOptions) => Promise<DiscoveredEndpoint | undefined>;
  ensure?: (options?: EnsureOptions) => Promise<DiscoveredEndpoint>;
  stop?: typeof Service.stop;
}

/** The environment aivi hands a service it starts: the plugin inside needs the same token as every other caller. */
const serviceEnv = (env: OpenCodeEnv) => (env.AIVI_TOKEN ? { env: { AIVI_TOKEN: env.AIVI_TOKEN } } : {});

const serviceFile = () =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode', 'service.json');

/**
 * Tolerant discovery: the server is alive when it answers HTTP on its
 * registered endpoint — any status, any version. The SDK's own discovery
 * treats an unknown probe path as an incompatible service and its ensure then
 * kills healthy servers, so a patch release that moves an endpoint turned
 * every aivi connection into a server kill (2026-09-19). aivi owns the
 * life-or-death decision instead: version skew is reported (see
 * `acceptVersion`), never fatal. A stale registration that points at some
 * other process fails later with a clear per-call error, never with a kill.
 */
export async function discoverTolerant(options: { file?: string } = {}): Promise<DiscoveredEndpoint | undefined> {
  let info: { url?: string; password?: string; version?: string };
  try {
    info = JSON.parse(await readFile(options.file ?? serviceFile(), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof info.url !== 'string') return undefined;
  const auth =
    typeof info.password === 'string'
      ? ({ type: 'basic', username: 'opencode', password: info.password } as const)
      : undefined;
  const headers = auth
    ? { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` }
    : undefined;
  // Old and new generations report version and liveness on different paths;
  // a fetch that resolves at all means something is listening there.
  for (const path of ['/api/info', '/api/status']) {
    try {
      const response = await fetch(`${info.url}${path}`, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(1500),
      });
      const body = response.ok ? ((await response.json()) as { version?: unknown }) : undefined;
      const version = typeof body?.version === 'string' ? body.version : info.version;
      return { url: info.url, ...(auth ? { auth } : {}), ...(version ? { version } : {}) };
    } catch {
      // Not reachable on this path; try the next, else let ensure start one.
    }
  }
  return undefined;
}

let versionAnnounced = false;

/** Once per process: say which server aivi found. Skew is information, never fatal. */
async function announceVersion(endpoint: DiscoveredEndpoint, log: Logger): Promise<void> {
  if (versionAnnounced) return;
  try {
    const response = await fetch(`${endpoint.url}/api/info`, {
      ...(endpoint.auth
        ? {
            authorization: `Basic ${Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`).toString('base64')}`,
          }
        : {}),
      signal: AbortSignal.timeout(1500),
    });
    const server = response.ok ? ((await response.json()) as { version?: string }) : undefined;
    if (!server?.version) return;
    versionAnnounced = true;
    log.info('opencode.version', { server: server.version });
  } catch {
    // Best effort: a server that says nothing about itself still gets used.
  }
}

let lastLoggedVersion: string | undefined;

/** The SDK hands the server's version to this predicate during discover and ensure: log it, accept every version. */
const acceptVersion = (log: Logger) => (server: string) => {
  if (server !== lastLoggedVersion) {
    lastLoggedVersion = server;
    log.info('opencode.version', { server });
  }
  return true;
};

/** Version changes seen through aivi's own discovery are logged the same way. */
const logVersion = (endpoint: DiscoveredEndpoint, log: Logger): void => {
  if (!endpoint.version || endpoint.version === lastLoggedVersion) return;
  lastLoggedVersion = endpoint.version;
  log.info('opencode.version', { server: endpoint.version });
};

/**
 * Resolve a client for the OpenCode v2 server.
 *
 * Without `opencode.url` aivi discovers the background service itself —
 * tolerantly (see `discoverTolerant`) — and uses the SDK's `Service.ensure`
 * only to start a server when none is reachable, never to replace one that
 * is. The `version` predicate accepts every server version, so the SDK's
 * replace-on-mismatch machinery stays out of aivi's operation. With
 * `lifecycle` `ensure` or `own`, a missing service is started through the
 * SDK, inheriting our environment plus `AIVI_TOKEN`.
 */
export async function connectOpenCode(
  config: Config['opencode'],
  env: OpenCodeEnv = process.env,
  hooks: ConnectHooks = {},
  log: Logger = silentLogger,
): Promise<OpenCodeClient> {
  if (config.url) {
    const headers = env.OPENCODE_PASSWORD
      ? Service.headers({
          url: config.url,
          auth: { type: 'basic', username: env.OPENCODE_USERNAME ?? 'opencode', password: env.OPENCODE_PASSWORD },
        })
      : undefined;
    return OpenCode.make({ baseUrl: config.url, ...(headers ? { headers } : {}) });
  }
  const version = acceptVersion(log);
  const discover = hooks.discover ?? discoverTolerant;
  const ensure = hooks.ensure ?? Service.ensure;
  let endpoint: DiscoveredEndpoint | undefined = await discover({ version });
  if (!endpoint && config.lifecycle !== 'discover') {
    endpoint = await ensure({ ...serviceEnv(env), version, onStart: reason => hooks.onStart?.(reason) });
  }
  if (!endpoint) {
    throw new Error(
      'No running OpenCode v2 service found. Start it with `opencode service start`, set opencode.lifecycle to "ensure", or set opencode.url in aivi.json.',
    );
  }
  logVersion(endpoint, log);
  const headers = endpoint.auth ? Service.headers({ url: endpoint.url, auth: endpoint.auth }) : undefined;
  return OpenCode.make({ baseUrl: endpoint.url, ...(headers ? { headers } : {}) });
}

/**
 * `lifecycle: "own"` at `aivi serve` startup: replace a running local service
 * with a fresh one that carries aivi's environment and the current plugin
 * build. Persistent terminals are handed off (SDK `pty: "handoff"`); OpenCode
 * sessions are durable, so only a turn in flight at that instant is cut short.
 * Called before anything dispatches, when aivi itself has no running work.
 * Returns false when nothing was running (ensure alone handles that case).
 */
export async function restartOpenCode(
  config: Config['opencode'],
  env: OpenCodeEnv = process.env,
  hooks: ConnectHooks = {},
): Promise<boolean> {
  if (config.url || config.lifecycle !== 'own') return false;
  const discover = hooks.discover ?? discoverTolerant;
  const stop = hooks.stop ?? Service.stop;
  const ensure = hooks.ensure ?? Service.ensure;
  if (!(await discover())) return false;
  hooks.onStart?.('restart');
  await stop({ pty: 'handoff' });
  await ensure({ ...serviceEnv(env), onStart: () => {} });
  return true;
}
