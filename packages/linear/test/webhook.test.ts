import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentSessionEvent, isIssueEvent, signWebhook, verifyWebhook } from '../src/webhook.ts';

const secret = 'whsec_test';
const now = 1_760_000_000_000;

test('a signed, fresh delivery is accepted and classified; anything else is refused with a reason', () => {
  const created = {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId: 'org',
    webhookTimestamp: now - 2_000,
    agentSession: { id: 'as1', issue: { id: 'i1', identifier: 'ENG-1' } },
    promptContext: '<issue identifier="ENG-1">…</issue>',
  };
  const body = Buffer.from(JSON.stringify(created));
  const ok = verifyWebhook({ body, signature: signWebhook(body, secret), secret, now });
  assert.ok(ok.ok);
  assert.ok(isAgentSessionEvent(ok.payload));
  assert.equal(isIssueEvent(ok.payload), false);

  const tampered = Buffer.from(JSON.stringify({ ...created, agentSession: { id: 'as2' } }));
  assert.deepEqual(verifyWebhook({ body: tampered, signature: signWebhook(body, secret), secret, now }), {
    ok: false,
    status: 401,
    reason: 'signature mismatch',
  });
  assert.deepEqual(verifyWebhook({ body, signature: undefined, secret, now }), {
    ok: false,
    status: 401,
    reason: 'missing Linear-Signature',
  });
  assert.deepEqual(verifyWebhook({ body, signature: 'zz', secret, now }), {
    ok: false,
    status: 401,
    reason: 'signature mismatch',
  });
  assert.equal(
    verifyWebhook({ body, signature: signWebhook(body, secret), secret, now: now + 120_000 }).ok,
    false,
    'two minutes later it is a replay',
  );
  const junk = Buffer.from('not json');
  const notJson = verifyWebhook({ body: junk, signature: signWebhook(junk, secret), secret, now });
  assert.ok(!notJson.ok && notJson.status === 400);
  const bare = Buffer.from(JSON.stringify({ type: 'Issue', action: 'update' }));
  const noStamp = verifyWebhook({ body: bare, signature: signWebhook(bare, secret), secret, now });
  assert.ok(!noStamp.ok && /webhookTimestamp/.test(noStamp.reason));
});
