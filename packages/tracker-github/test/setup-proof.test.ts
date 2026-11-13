import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { RequestLogEntry } from '@aivi/core';
import { GitHubApp, webhookSignature } from '@aivi/github';
import type { PluginSetupContext, Store } from '@aivi/plugin';
import setup from '../src/setup.ts';
import { GITHUB_WEBHOOK_PATH } from '../src/tracker.ts';

function proofContext(t: TestContext, event = 'installation', action = 'created') {
  t.mock.property(process, 'env', {
    ...process.env,
    GITHUB_APP_ID: '7',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nunit-test\n-----END PRIVATE KEY-----',
    GITHUB_WEBHOOK_SECRET: 'secret',
  });
  // The clock is never advanced: a valid delivery must finish the check now.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const progress = { start: t.mock.fn(), message: t.mock.fn(), stop: t.mock.fn(), cancel: t.mock.fn() };
  const write = t.mock.fn(async () => {});
  const rows: RequestLogEntry[] = [];
  const store = {
    requests: ({ sinceId = 0 }: { sinceId?: number } = {}) => rows.filter(row => row.id > sinceId),
  } as unknown as Store;
  const app = {
    appSlug: 'aivi-app',
    accountLogin: 'acme',
    installationId: 42,
    grantFacts: async () => ({ permissions: { issues: 'write', organization_projects: 'write' }, events: ['*'] }),
    webhookConfig: async () => ({ url: `https://aivi.example${GITHUB_WEBHOOK_PATH}` }),
    webhookDeliveries: async () => [{ id: 'replay-1', event: 'installation', statusCode: 200 }],
    redeliverWebhook: async () => {
      const body = JSON.stringify({ action });
      rows.push({
        id: 1,
        at: 0,
        method: 'POST',
        path: GITHUB_WEBHOOK_PATH,
        status: 404,
        body,
        truncated: false,
        headers: { 'x-github-event': event, 'x-hub-signature-256': webhookSignature('secret', Buffer.from(body)) },
      });
    },
  };
  t.mock.method(GitHubApp, 'connect', async () => app as unknown as GitHubApp);
  const ctx = {
    config: { version: 1, host: { public: 'https://aivi.example' } },
    prompts: { note: t.mock.fn(), log: { message: async () => {} }, spinner: () => progress },
    fetch: async () => Response.json({ ok: true }),
    withStore: async (fn: (store: Store) => unknown) => fn(store),
    writeConfigBlock: write,
  } as unknown as PluginSetupContext;
  return { ctx, progress, write, rows, app };
}

test('GitHub setup accepts signed webhook proof immediately, without waiting for the installation replay', async t => {
  for (const [event, action, expected] of [
    ['installation', 'created', /installation delivery arrived and verified/],
    ['installation_repositories', 'added', /installation delivery arrived and verified/],
    ['issues', 'opened', /deliveries arrived and verified.*no installation event/],
    ['issue_comment', 'created', /deliveries arrived and verified.*no installation event/],
    ['installation', 'deleted', /deliveries arrived and verified.*no installation event/],
  ] as const) {
    await t.test(`${event}/${action}`, async t => {
      const { ctx, progress, write } = proofContext(t, event, action);
      const result = await setup(ctx);
      assert.match(result.summary, expected);
      assert.equal(progress.stop.mock.callCount(), 1);
      assert.equal(progress.cancel.mock.callCount(), 0);
      assert.deepEqual(write.mock.calls[0]!.arguments, [['plugins', 'tracker-github'], {}]);
    });
  }
});

test('a failed GitHub setup check cancels its progress line without writing configuration', async t => {
  for (const phase of ['signature', 'store'])
    await t.test(phase, async t => {
      const h = proofContext(t);
      if (phase === 'signature')
        h.app.redeliverWebhook = async () => {
          h.rows.push({
            id: 1,
            at: 0,
            method: 'POST',
            path: GITHUB_WEBHOOK_PATH,
            status: 404,
            body: '{}',
            truncated: false,
            headers: {},
          });
        };
      else
        h.ctx.withStore = async () => {
          throw new Error('store unavailable');
        };
      await assert.rejects(setup(h.ctx), phase === 'signature' ? /bad signature/ : /store unavailable/);
      assert.equal(h.progress.cancel.mock.callCount(), 1);
      assert.equal(h.progress.stop.mock.callCount(), 0);
      assert.equal(h.write.mock.callCount(), 0);
    });
});
