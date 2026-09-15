import type { Config } from '@aivi/core';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export type OpenCodeEnv = Record<string, string | undefined>;
export interface ConnectHooks {
  /** aivi is about to start the OpenCode service because none was running. */
  onStart?: (reason: 'missing' | 'version-mismatch') => void;
  /** Injection points for tests; default to the SDK. */
  discover?: typeof Service.discover;
  ensure?: typeof Service.ensure;
}

/**
 * Resolve a client for the OpenCode v2 server.
 *
 * Verified against OpenCode 2.0.3: the background service registers itself in
 * `~/.local/state/opencode/service.json` on a random port and requires HTTP
 * basic auth. Bearer tokens are rejected (401). Without `opencode.url` we use
 * the SDK's discovery so the port can change freely between restarts. With
 * `opencode.ensure` (default) a missing service is started through the SDK's
 * `Service.ensure`, inheriting our environment plus `AIVI_TOKEN`, so the aivi
 * plugin inside it can authenticate. aivi never stops the service.
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
  if (!endpoint && config.ensure) {
    endpoint = await ensure({
      ...(env.AIVI_TOKEN ? { env: { AIVI_TOKEN: env.AIVI_TOKEN } } : {}),
      onStart: reason => hooks.onStart?.(reason),
    });
  }
  if (!endpoint) {
    throw new Error(
      'No running OpenCode v2 service found. Start it with `opencode service start`, set opencode.ensure, or set opencode.url in aivi.json.',
    );
  }
  const headers = endpoint.auth ? Service.headers({ url: endpoint.url, auth: endpoint.auth }) : undefined;
  return OpenCode.make({ baseUrl: endpoint.url, ...(headers ? { headers } : {}) });
}
