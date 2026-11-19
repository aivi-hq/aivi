import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV } from '../src/github.ts';
import { type Answer, scripted } from './scripted.ts';

export { scripted };

/** A throwaway key, generated here and secret to nothing: what the tests prove
 *  is which bytes octokit signs with and where they are sent, not that a key is
 *  hard to guess. Every test in this package that connects needs one, so it
 *  goes where the code looks for it, exactly as `<home>/.env` does. */
export const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;
process.env[GITHUB_APP_ID_ENV] ??= '7';

/** A fresh installation token, as GitHub hands one out: what it is, and when it
 *  stops being good. */
export function installationToken(sequence = 1): Answer {
  return {
    status: 201,
    body: {
      token: `ghs_token_${sequence}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      permissions: { contents: 'write', pull_requests: 'write' },
      repository_selection: 'all',
    },
  };
}

/** The app's own JWT, with the claim that names it read back — the place a
 *  wrong app id shows up. */
export function jwtClaims(authorization: string | undefined): { iss: string } {
  assert.match(authorization ?? '', /^bearer ey/, 'the app authenticates its own JWT as a bearer token');
  const [, payload] = (authorization ?? '').slice('bearer '.length).split('.');
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { iss: string | number };
  return { iss: String(claims.iss) };
}
