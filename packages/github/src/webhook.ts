/** GitHub's webhook seal, checked before a payload is parsed.
 *
 *  GitHub signs each delivery with the webhook secret: an HMAC SHA-256 over
 *  the **raw request bytes**, sent as `X-Hub-Signature-256: sha256=<hex>`.
 *  The check is over the bytes as they arrived, never over a re-serialised
 *  body — parsing first and hashing after would hash different bytes than
 *  GitHub signed. The comparison is constant-time: a signature that fails
 *  halfway must not take measurably longer than one that fails at the start.
 *
 *  The secret is a secret, so it stands in `<home>/.env` beside the key, not
 *  in `config.json`. The route that takes the delivery answers 401 for a bad
 *  seal; nothing past the seal runs without GitHub's own bytes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The environment name the webhook's HMAC secret is read from. */
export const GITHUB_WEBHOOK_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';

/** The header GitHub carries the seal in. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Whether one delivery's seal holds: `signature` is the header value as it
 *  arrived (`sha256=<hex>`), `payload` the raw bytes of the request body. Any
 *  shape that is not GitHub's seal — missing, truncated, wrong prefix — fails
 *  the same way a wrong one does. */
export function verifyWebhookSignature(secret: string, payload: string | Buffer, signature: string): boolean {
  const claimed = signature.trim();
  if (!claimed.startsWith('sha256=')) return false;
  const claimedBytes = Buffer.from(claimed.slice('sha256='.length), 'hex');
  if (claimedBytes.length !== 32) return false;
  const actual = createHmac('sha256', secret).update(payload).digest();
  return timingSafeEqual(actual, claimedBytes);
}

/** The seal for one payload, as GitHub computes it — for a setup flow proving
 *  its secret against a live delivery, and for tests speaking GitHub's part. */
export function webhookSignature(secret: string, payload: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
