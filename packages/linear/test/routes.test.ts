import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicRoutes } from '@aivi/host';
import { registerWebhookRoutes, webhookPath } from '../src/routes.ts';
import { signWebhook } from '../src/webhook.ts';

test('each app gets its own route; a verified delivery is acknowledged before it is dispatched', async () => {
  const routes = new PublicRoutes();
  const dispatched: [string, string][] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const off = registerWebhookRoutes(
    routes,
    [
      { id: 'dev', webhookSecret: 's-dev' },
      { id: 'review', webhookSecret: 's-review' },
    ],
    async (app, payload) => {
      dispatched.push([app, payload.action]);
      await gate;
    },
  );
  const body = Buffer.from(
    JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'created',
      webhookTimestamp: Date.now(),
      agentSession: { id: 'a' },
    }),
  );
  const call = (app: string, secret: string, method = 'POST') =>
    routes.get(webhookPath(app))!({
      method,
      headers: { 'linear-signature': signWebhook(body, secret), 'linear-delivery': 'd1' },
      body,
    });
  assert.deepEqual(
    await call('dev', 's-dev'),
    { status: 200, body: { ok: true } },
    'answered while dispatch still runs',
  );
  assert.deepEqual(dispatched, [['dev', 'created']]);
  assert.equal((await call('dev', 's-review')).status, 401, "the other app's secret does not open this route");
  assert.equal((await call('review', 's-review')).status, 200);
  assert.equal((await call('dev', 's-dev', 'GET')).status, 405);
  assert.equal(routes.get(webhookPath('other')), undefined);
  release();
  off();
  assert.equal(routes.get(webhookPath('dev')), undefined);
});
