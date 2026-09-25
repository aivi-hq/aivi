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

/** The two segments that matter: the contract (major) and the features (minor). */
function majorMinor(version: string): [major: number, minor: number] | null {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const ours = majorMinor(hostVersion) ?? [Number.NaN, Number.NaN];

/**
 * Client/server negotiation in place of a version in the path. The major is
 * the contract: a server may gain minors (features) the client never
 * touches, so an older client is served; a client whose major.minor is ahead
 * expects answers this server cannot give, so it is refused rather than
 * allowed to misread them. A different major is always a refusal — breaking
 * changes happened somewhere between the two. The 403 body names the side
 * that must move: `client_version_unsupported` with `aivi upgrade` for the
 * stale client, `server_version_too_low` with the version to reach for the
 * stale server. The paths exempt from the gate (`/health`, `/version`,
 * module webhooks) are exempt by registration order, not here.
 */
export const versionGate: AppMiddleware = async (c, next) => {
  const theirs = c.req.header(CLIENT_HEADER);
  const [major, minor] = theirs === undefined ? [null, null] : (majorMinor(theirs) ?? [null, null]);
  if (major === null || minor === null)
    return respond(
      {
        code: 'client_version_unsupported',
        minVersion: hostVersion,
        error: `The aivi client ${theirs ?? 'does not name its version'} is older than this host (${hostVersion}). Run: aivi upgrade.`,
      },
      403,
    );
  if (major < ours[0])
    return respond(
      {
        code: 'client_version_unsupported',
        minVersion: hostVersion,
        error: `The aivi client ${theirs} speaks an older contract than this host (${hostVersion}). Run: aivi upgrade.`,
      },
      403,
    );
  if (major > ours[0] || minor > ours[1])
    return respond(
      {
        code: 'server_version_too_low',
        minVersion: theirs,
        error: `The aivi client ${theirs} is newer than this host (${hostVersion}); features it expects may not answer here. Ask an operator to update aivi, or downgrade the client.`,
      },
      403,
    );
  await next();
};
