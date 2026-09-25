import { hostVersion } from '../version.ts';
import type { AppMiddleware } from './env.ts';
import { respond } from './http.ts';

/**
 * The header a client identifies itself with. Every first-party client sends
 * it — the host's own `createHostClient`, and `@aivi/cli`, whose version is
 * kept equal to the host's by the changesets `fixed` group. A silent caller
 * is never a pass: only our clients speak this API, and one of them forgot
 * to update.
 */
export const CLIENT_HEADER = 'x-aivi-client';

export type Negotiation =
  | { ok: true }
  | {
      ok: false;
      code: 'client_version_unsupported' | 'server_version_too_low';
      minVersion: string;
      error: string;
    };

/** The two segments that matter: the contract (major) and the features (minor). */
function majorMinor(version: string): [major: number, minor: number] | null {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * The whole rule of client/server negotiation, in place of a version in the
 * path, over two version strings. The major is the contract: a server may
 * gain minors (features) the client never touches, so a client at or behind
 * the host is served; a client whose major.minor is ahead expects answers
 * this server cannot give, so it is refused rather than allowed to misread
 * them. A different major is always a refusal — breaking changes happened
 * somewhere between the two — and so is silence: every first-party client
 * names its version. The refusal names the side that must move:
 * `client_version_unsupported` with `aivi upgrade` for the stale client,
 * `server_version_too_low` with the version to reach for the stale server.
 * `server` is a package's own `package.json` version: trusted input.
 */
export function negotiate(client: string | undefined, server: string): Negotiation {
  const theirs = client === undefined ? null : majorMinor(client);
  // The host's version comes from its own package.json; only a malformed
  // release can make this null, and then serving is the least it can do.
  const ours = majorMinor(server);
  if (!ours || !theirs)
    return {
      ok: false,
      code: 'client_version_unsupported',
      minVersion: server,
      error: `The aivi client ${client ?? 'does not name its version'} is older than this host (${server}). Run: aivi upgrade.`,
    };
  if (theirs[0] < ours[0])
    return {
      ok: false,
      code: 'client_version_unsupported',
      minVersion: server,
      error: `The aivi client ${client} speaks an older contract than this host (${server}). Run: aivi upgrade.`,
    };
  if (theirs[0] > ours[0] || theirs[1] > ours[1])
    return {
      ok: false,
      code: 'server_version_too_low',
      minVersion: client!,
      error: `The aivi client ${client} is newer than this host (${server}); features it expects may not answer here. Ask an operator to update aivi, or downgrade the client.`,
    };
  return { ok: true };
}

/**
 * The gate as middleware: the rule above against this host's own version.
 * The paths exempt from the gate (`/health`, `/version`, module webhooks)
 * are exempt by registration order, not here.
 */
export const versionGate: AppMiddleware = async (c, next) => {
  const outcome = negotiate(c.req.header(CLIENT_HEADER), hostVersion);
  if (!outcome.ok) return respond({ code: outcome.code, minVersion: outcome.minVersion, error: outcome.error }, 403);
  await next();
};
