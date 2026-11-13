import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLogger } from '@aivi/core';
import { PublicRoutes } from '@aivi/host';
import { appWebhookPath, registerWebhookRoutes } from '../src/routes.ts';
import { signWebhook } from '../src/webhook.ts';

test('every app gets its own route; a verified delivery is acknowledged before it is dispatched', async () => {
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
    routes.get(appWebhookPath(app))!({
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
  assert.equal(routes.get(appWebhookPath('other')), undefined);
  assert.equal(routes.get('/linear/webhooks/dev'), undefined, 'the old flat path is gone');
  release();
  off();
  assert.equal(routes.get(appWebhookPath('dev')), undefined);
});

test('a dispatch failure is logged with its delivery id but the verified webhook remains acknowledged', async t => {
  const routes = new PublicRoutes();
  const log = getLogger(['aivi', 'test', 'linear-webhook']);
  const logged = Promise.withResolvers<unknown[]>();
  t.mock.method(log, 'warn', (...args: unknown[]) => logged.resolve(args));
  const error = new Error('dispatch failed');
  const off = registerWebhookRoutes(
    routes,
    [{ id: 'dev', webhookSecret: 'secret' }],
    async () => {
      throw error;
    },
    log,
  );
  t.after(off);
  const body = Buffer.from(
    JSON.stringify({ type: 'AgentSessionEvent', action: 'created', webhookTimestamp: Date.now() }),
  );
  const response = await routes.get(appWebhookPath('dev'))!({
    method: 'POST',
    headers: { 'linear-signature': signWebhook(body, 'secret'), 'linear-delivery': 'delivery-1' },
    body,
  });
  assert.deepEqual(response, { status: 200, body: { ok: true } });
  assert.deepEqual(await logged.promise, ['linear.webhook.failed', { app: 'dev', delivery: 'delivery-1', error }]);
});
