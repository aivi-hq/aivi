import { generateKeyPairSync } from 'node:crypto';
import { GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV } from '@aivi/github';
import { type Answer, type Seen, scripted } from '../../github/test/scripted.ts';

export { type Answer, type Seen, scripted };

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
