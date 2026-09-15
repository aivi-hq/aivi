import type { Config } from '@aivi/core';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export type OpenCodeEnv = Record<string, string | undefined>;

/**
 * Resolve a client for the OpenCode v2 server.
 *
 * Verified against OpenCode 2.0.3: the background service registers itself in
 * `~/.local/state/opencode/service.json` on a random port and requires HTTP
 * basic auth. Bearer tokens are rejected (401). Without `opencode.url` we use
 * the SDK's discovery so the port can change freely between restarts. aivi
 * never starts or stops that service; `opencode service start` does.
 */
export async function connectOpenCode(
  config: Config['opencode'],
  env: OpenCodeEnv = process.env,
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
  const endpoint = await Service.discover();
  if (!endpoint) {
    throw new Error(
      'No running OpenCode v2 service found. Start it with `opencode service start` or set opencode.url in aivi.json.',
    );
  }
  const headers = endpoint.auth ? Service.headers({ url: endpoint.url, auth: endpoint.auth }) : undefined;
  return OpenCode.make({ baseUrl: endpoint.url, ...(headers ? { headers } : {}) });
}
