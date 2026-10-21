/** The webhook seal at its own seam: GitHub's own computation proven against
 *  a known secret and body, and every way a delivery can fail the seal —
 *  wrong secret, tampered bytes, missing header, wrong prefix — answering the
 *  same refusal. The route that uses it is the tracker's test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyWebhookSignature, webhookSignature } from '../src/webhook.ts';

const SECRET = 'webhook-secret';
const PAYLOAD = JSON.stringify({ action: 'labeled', issue: { number: 47 } });

test('a seal GitHub computed is accepted, byte for byte', () => {
  const signature = webhookSignature(SECRET, PAYLOAD);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.ok(verifyWebhookSignature(SECRET, PAYLOAD, signature));
});

test('any deviation fails the seal', () => {
  const signature = webhookSignature(SECRET, PAYLOAD);
  assert.equal(verifyWebhookSignature('another-secret', PAYLOAD, signature), false, 'wrong secret');
  assert.equal(
    verifyWebhookSignature(SECRET, PAYLOAD.replace('47', '48'), signature),
    false,
    'bytes changed after the seal',
  );
  const flipped = signature.startsWith('sha256=a') ? `sha256=b${signature.slice(8)}` : `sha256=a${signature.slice(8)}`;
  assert.equal(verifyWebhookSignature(SECRET, PAYLOAD, flipped), false, 'seal altered');
  assert.equal(verifyWebhookSignature(SECRET, PAYLOAD, 'sha1=deadbeef'), false, 'not the SHA-256 seal');
  assert.equal(verifyWebhookSignature(SECRET, PAYLOAD, 'not-a-seal-at-all'), false, 'not a seal');
  assert.equal(verifyWebhookSignature(SECRET, PAYLOAD, ''), false, 'no header value');
});

test('raw bytes and their string agree: the seal is over what arrived, not what was re-serialised', () => {
  const signature = webhookSignature(SECRET, Buffer.from(PAYLOAD, 'utf8'));
  assert.ok(verifyWebhookSignature(SECRET, PAYLOAD, signature), 'the route hashes the string, GitHub hashed the bytes');
});
