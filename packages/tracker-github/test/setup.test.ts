import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { RequestLogEntry } from '@aivi/core';
import {
  GITHUB_APP_ID_ENV,
  GITHUB_PRIVATE_KEY_ENV,
  GITHUB_WEBHOOK_SECRET_ENV,
  GitHubApp,
  webhookSignature,
} from '@aivi/github';
import { PluginSetupCancelled } from '@aivi/plugin';
import { cancelSetup, setupDiary, setupFixture } from '../../plugin/test/setup-fixture.ts';
import setup from '../src/setup.ts';
import { GITHUB_WEBHOOK_PATH } from '../src/tracker.ts';

const now = Date.parse('2026-11-13T10:00:00Z');
const publicUrl = 'https://aivi.example';
const privateKey = '-----BEGIN PRIVATE KEY-----\nunit-test-key\n-----END PRIVATE KEY-----';
const installation = { id: 'delivery-1', event: 'installation', statusCode: 200 };

function wizard(t: TestContext, answers: unknown[] = []) {
  t.mock.property(process, 'env', {
    ...process.env,
    [GITHUB_APP_ID_ENV]: '7',
    [GITHUB_PRIVATE_KEY_ENV]: privateKey,
    [GITHUB_WEBHOOK_SECRET_ENV]: 'secret',
    AIVI_PROBE_WINDOW_MS: '9000',
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const h = setupFixture(t, answers);
  const diary = setupDiary(t);
  h.ctx.config = { version: 1, host: { public: publicUrl } };
  h.fetch.mock.mockImplementation(async url => {
    assert.equal(url, 'http://127.0.0.1:4100/health');
    return Response.json({ ok: true });
  });
  h.withStore.mock.mockImplementation(async fn => fn(diary.store));
  const append = (event: string, payload: unknown, extra: Partial<RequestLogEntry> = {}) => {
    const body = JSON.stringify(payload);
    const row: RequestLogEntry = {
      id: Math.max(0, ...diary.rows.map(row => row.id)) + 1,
      at: now,
      method: 'POST',
      path: GITHUB_WEBHOOK_PATH,
      status: 404,
      body,
      truncated: false,
      headers: { 'x-github-event': event, 'x-hub-signature-256': webhookSignature('secret', Buffer.from(body)) },
      ...extra,
    };
    diary.rows.push(row);
    return row;
  };
  const app = {
    appSlug: 'aivi-app',
    accountLogin: 'acme',
    installationId: 42,
    grantFacts: t.mock.fn(async () => ({
      permissions: { issues: 'write', organization_projects: 'write' } as Record<string, string>,
      events: ['issue_comment', 'issues', 'projects_v2_item'],
    })),
    webhookConfig: t.mock.fn(async () => ({ url: `${publicUrl}${GITHUB_WEBHOOK_PATH}`, insecureSsl: false })),
    webhookDeliveries: t.mock.fn(async (_limit: number) => [installation]),
    redeliverWebhook: t.mock.fn(async (_id: string) => {
      assert.equal(h.configWrites.mock.callCount(), 0, 'verification precedes config writes');
      assert.equal(h.secretWrites.mock.callCount(), 0, 'verification precedes secret writes');
      append('installation', { action: 'created' });
    }),
  };
  const connect = t.mock.method(GitHubApp, 'connect', async () => app as unknown as GitHubApp);
  return { ...h, diary, append, app, connect };
}

test('tracker setup verifies a new delivery after the diary cursor and preserves its existing config', async t => {
  const h = wizard(t);
  h.append('installation', { action: 'old' });
  h.ctx.config.plugins = { 'tracker-github': { agent: 'assistant', progress: 'silent' } };
  const result = await setup(h.ctx);
  assert.equal(result.module, 'tracker-github');
  assert.match(result.summary, /installation delivery arrived and verified.*Restart aivi/);
  assert.deepEqual(h.connect.mock.calls[0]!.arguments[0]!.credentials, { appId: 7, privateKey });
  assert.deepEqual(h.app.webhookDeliveries.mock.calls[0]!.arguments, [25]);
  assert.deepEqual(h.app.redeliverWebhook.mock.calls[0]!.arguments, ['delivery-1']);
  assert.deepEqual(
    h.configWrites.mock.calls.map(call => call.arguments),
    [[['plugins', 'tracker-github'], { agent: 'assistant', progress: 'silent' }]],
  );
  assert.equal(h.secretWrites.mock.callCount(), 0);
  assert.equal(h.ask.mock.callCount(), 0);
  assert.equal(h.spinners[0]!.stop.mock.callCount(), 1);
  assert.equal(h.spinners[0]!.cancel.mock.callCount(), 0);
});

test('tracker setup asks only for missing URL and secret and validates their input', async t => {
  const h = wizard(t, [publicUrl, 'secret']);
  h.ctx.config = { version: 1 };
  delete process.env[GITHUB_WEBHOOK_SECRET_ENV];
  await setup(h.ctx);
  assert.deepEqual(
    h.configWrites.mock.calls.map(call => call.arguments),
    [
      [['host', 'public'], publicUrl],
      [['plugins', 'tracker-github'], {}],
    ],
  );
  assert.deepEqual(
    h.secretWrites.mock.calls.map(call => call.arguments),
    [[GITHUB_WEBHOOK_SECRET_ENV, 'secret']],
  );
  const url = h.questions[0]!.validate!;
  assert.equal(url(publicUrl), undefined);
  assert.equal(url(`${publicUrl}/`), 'no trailing /');
  for (const value of [undefined, '', 'not a URL'])
    assert.equal(url(value), 'an http(s) URL, like https://my-machine.ts.net');
  const secret = h.questions[1]!.validate!;
  assert.equal(secret('secret'), undefined);
  assert.equal(secret(''), 'Paste the Secret from the webhook section');
});

test('tracker setup refuses missing or read-only Issues and Projects permissions before writing', async t => {
  for (const permissions of [{}, { issues: 'read', organization_projects: 'read' }])
    await t.test(JSON.stringify(permissions), async t => {
      const h = wizard(t);
      h.app.grantFacts.mock.mockImplementation(async () => ({ permissions, events: [] }));
      await assert.rejects(setup(h.ctx), /installation #42 cannot run the tracker: Issues:.*Projects:/);
      assert.equal(h.app.webhookConfig.mock.callCount(), 0);
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});

test('tracker setup requires each webhook category, while a wildcard subscription is sufficient', async t => {
  await t.test('missing categories', async t => {
    const h = wizard(t);
    h.app.grantFacts.mock.mockImplementation(async () => ({
      permissions: { issues: 'write', organization_projects: 'write' },
      events: ['issues'],
    }));
    await assert.rejects(setup(h.ctx), /does not subscribe issue_comment.*projects_v2_item/);
    assert.equal(h.configWrites.mock.callCount(), 0);
  });
  await t.test('wildcard', async t => {
    const h = wizard(t);
    h.app.grantFacts.mock.mockImplementation(async () => ({
      permissions: { issues: 'write', organization_projects: 'write' },
      events: ['*'],
    }));
    assert.match((await setup(h.ctx)).summary, /arrived and verified/);
  });
});

test('tracker setup refuses a missing or misdirected webhook URL without waiting or writing', async t => {
  for (const url of ['', 'https://elsewhere.example/webhook'])
    await t.test(url || 'missing URL', async t => {
      const h = wizard(t);
      h.app.webhookConfig.mock.mockImplementation(async () => ({ url, insecureSsl: false }));
      await assert.rejects(setup(h.ctx), url ? /not https:\/\/aivi.example/ : /app posts nowhere/);
      assert.equal(h.withStore.mock.callCount(), 0);
      assert.equal(h.configWrites.mock.callCount(), 0);
    });
});

test('tracker setup accepts a trailing webhook slash and reports insecure TLS and a failed last delivery', async t => {
  const h = wizard(t);
  h.app.webhookConfig.mock.mockImplementation(async () => ({
    url: `${publicUrl}${GITHUB_WEBHOOK_PATH}/`,
    insecureSsl: true,
  }));
  h.app.webhookDeliveries.mock.mockImplementation(async () => [{ ...installation, statusCode: 404 }]);
  await setup(h.ctx);
  const said = h.log.mock.calls.map(call => call.arguments[0]).join('\n');
  assert.match(said, /skip full TLS verification/);
  assert.match(said, /last delivery \(installation\) was answered 404/);
});

test('an operator can skip verification when no host answers, without opening a store', async t => {
  const h = wizard(t, ['skip']);
  h.fetch.mock.mockImplementation(async () => {
    throw new Error('host down');
  });
  const result = await setup(h.ctx);
  assert.match(result.summary, /UNVERIFIED — no live aivi watched/);
  assert.equal(h.withStore.mock.callCount(), 0);
  assert.equal(h.app.redeliverWebhook.mock.callCount(), 0);
  assert.equal(h.configWrites.mock.callCount(), 1);
});

test('a health retry rechecks immediately, while cancellation stops before connecting', async t => {
  await t.test('retry', async t => {
    const h = wizard(t, ['retry']);
    h.fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    assert.match((await setup(h.ctx)).summary, /arrived and verified/);
    assert.equal(h.fetch.mock.callCount(), 2);
  });
  await t.test('cancel', async t => {
    const h = wizard(t, [cancelSetup]);
    h.fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }));
    await assert.rejects(setup(h.ctx), /cancelled at the health gate/);
    assert.equal(h.connect.mock.callCount(), 0);
    assert.equal(h.configWrites.mock.callCount(), 0);
  });
});

test('a missing installation delivery offers skip or retry without starting an impossible wait', async t => {
  await t.test('skip', async t => {
    const h = wizard(t, ['skip']);
    h.app.webhookDeliveries.mock.mockImplementation(async () => []);
    assert.match((await setup(h.ctx)).summary, /UNVERIFIED — the webhook wait was skipped/);
    assert.equal(h.withStore.mock.callCount(), 0);
    assert.equal(h.app.redeliverWebhook.mock.callCount(), 0);
  });
  await t.test('retry', async t => {
    const h = wizard(t, ['retry']);
    h.app.webhookDeliveries.mock.mockImplementationOnce(async () => []);
    assert.match((await setup(h.ctx)).summary, /arrived and verified/);
    assert.equal(h.app.webhookDeliveries.mock.callCount(), 2);
  });
  await t.test('cancel', async t => {
    const h = wizard(t, [cancelSetup]);
    h.app.webhookDeliveries.mock.mockImplementation(async () => []);
    await assert.rejects(setup(h.ctx), /cancelled at the webhook fork/);
    assert.equal(h.configWrites.mock.callCount(), 0);
  });
});

test('a refused replay offers skip or retry without treating the refusal as webhook silence', async t => {
  for (const choice of ['skip', 'retry'])
    await t.test(choice, async t => {
      const h = wizard(t, [choice]);
      h.app.redeliverWebhook.mock.mockImplementationOnce(async () => {
        throw new Error('replay refused');
      });
      const result = await setup(h.ctx);
      assert.match(result.summary, choice === 'skip' ? /UNVERIFIED/ : /arrived and verified/);
      assert.match(h.spinners[0]!.cancel.mock.calls[0]!.arguments[0], /replay was refused \(replay refused\)/);
      assert.equal(h.app.webhookDeliveries.mock.callCount(), choice === 'skip' ? 1 : 2);
      assert.equal(h.app.redeliverWebhook.mock.callCount(), choice === 'skip' ? 1 : 2);
    });
});

test('webhook silence is a failed check after a virtual deadline, not a real wait', async t => {
  const h = wizard(t);
  const watching = Promise.withResolvers<void>();
  h.app.redeliverWebhook.mock.mockImplementation(async () => {});
  h.diary.requests.mock.mockImplementation(filter => {
    if (filter?.method === 'POST') watching.resolve();
    return [];
  });
  const pending = setup(h.ctx);
  await watching.promise;
  t.mock.timers.tick(9000);
  const result = await pending;
  assert.match(result.summary, /FAILED — nothing arrived in 9 s/);
  assert.equal(h.configWrites.mock.callCount(), 1, 'a completed failed check still records configuration');
  assert.equal(h.spinners[0]!.cancel.mock.callCount(), 1);
});

test('a truncated or incorrectly signed delivery stops tracker setup before any write', async t => {
  for (const extra of [{ truncated: true }, { headers: {} }])
    await t.test(JSON.stringify(extra), async t => {
      const h = wizard(t);
      h.app.redeliverWebhook.mock.mockImplementation(async () => {
        h.append('installation', { action: 'created' }, extra);
      });
      await assert.rejects(setup(h.ctx), extra.truncated ? /diary cut it off/ : /bad signature/);
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});

test('cancelling URL or signing-secret input leaves tracker configuration untouched', async t => {
  for (const field of ['url', 'secret'])
    await t.test(field, async t => {
      const h = wizard(t, [cancelSetup]);
      if (field === 'url') h.ctx.config = { version: 1 };
      else delete process.env[GITHUB_WEBHOOK_SECRET_ENV];
      await assert.rejects(setup(h.ctx), PluginSetupCancelled);
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});
