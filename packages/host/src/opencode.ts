import type { Config } from '@aivi/core';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export type OpenCodeEnv = Record<string, string | undefined>;
export interface ConnectHooks {
  /** aivi is about to start the OpenCode service because none was running (or it is being replaced). */
  onStart?: (reason: 'missing' | 'version-mismatch' | 'restart') => void;
  /** Injection points for tests; default to the SDK. */
  discover?: typeof Service.discover;
  ensure?: typeof Service.ensure;
  stop?: typeof Service.stop;
}

/** The environment aivi hands a service it starts: the plugin inside needs the same token as every other caller. */
const serviceEnv = (env: OpenCodeEnv) => (env.AIVI_TOKEN ? { env: { AIVI_TOKEN: env.AIVI_TOKEN } } : {});

/**
 * Resolve a client for the OpenCode v2 server.
 *
 * Verified against OpenCode 2.0.3: the background service registers itself in
 * `~/.local/state/opencode/service.json` on a random port and requires HTTP
 * basic auth. Bearer tokens are rejected (401). Without `opencode.url` we use
 * the SDK's discovery so the port can change freely between restarts. With
 * `lifecycle` `ensure` or `own`, a missing service is started through the
 * SDK's `Service.ensure`, inheriting our environment plus `AIVI_TOKEN`.
 */
export async function connectOpenCode(
  config: Config['opencode'],
  env: OpenCodeEnv = process.env,
  hooks: ConnectHooks = {},
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
  const discover = hooks.discover ?? Service.discover;
  const ensure = hooks.ensure ?? Service.ensure;
  let endpoint: Awaited<ReturnType<typeof discover>> | Awaited<ReturnType<typeof ensure>> = await discover();
  if (!endpoint && config.lifecycle !== 'discover') {
    endpoint = await ensure({ ...serviceEnv(env), onStart: reason => hooks.onStart?.(reason) });
  }
  if (!endpoint) {
    throw new Error(
      'No running OpenCode v2 service found. Start it with `opencode service start`, set opencode.lifecycle to "ensure", or set opencode.url in aivi.json.',
    );
  }
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
  const discover = hooks.discover ?? Service.discover;
  const stop = hooks.stop ?? Service.stop;
  const ensure = hooks.ensure ?? Service.ensure;
  if (!(await discover())) return false;
  hooks.onStart?.('restart');
  await stop({ pty: 'handoff' });
  await ensure({ ...serviceEnv(env), onStart: () => {} });
  return true;
}
