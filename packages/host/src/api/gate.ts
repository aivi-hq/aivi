import { aiviVersion } from '@aivi/core';
import type { AppMiddleware } from './env.ts';
import { respond } from './http.ts';

/**
 * The header a client identifies itself with. Absent means the oldest client
 * alive: it gets the same refusal and the same remedy as an old one.
 */
export const CLIENT_HEADER = 'x-aivi-client';

/** The segment that breaks compatibility: while 0.x it is the minor, after it is the major. */
function breakingSegment(version: string): number | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 ? minor : major;
}

const ours = breakingSegment(aiviVersion) ?? -1;

/**
 * Client/server negotiation in place of a version in the path: both sides are
 * `@aivi/*` packages that read one constant, so a mismatch means a real
 * upgrade was skipped — the client's `aivi upgrade` or the operator's update,
 * never a URL a client can edit. Mismatches answer 403 with the minimum
 * version that would pass; the paths exempt from the gate (`/health`,
 * `/version`, module webhooks) are exempt by registration order, not here.
 */
export const versionGate: AppMiddleware = async (c, next) => {
  const theirs = c.req.header(CLIENT_HEADER);
  const segment = theirs === undefined ? null : breakingSegment(theirs);
  if (segment === null || segment < ours)
    return respond(
      {
        code: 'client_version_unsupported',
        minVersion: aiviVersion,
        error: `The aivi client ${theirs ?? 'does not name its version'} is older than this host (${aiviVersion}). Run: aivi upgrade.`,
      },
      403,
    );
  if (segment > ours)
    return respond(
      {
        code: 'server_version_too_low',
        minVersion: theirs,
        error: `The aivi client ${theirs} needs a host of ${theirs} or newer; this host is ${aiviVersion}. Ask an operator to update aivi, or downgrade the client.`,
      },
      403,
    );
  await next();
};
