import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginSetupCancelled } from '@aivi/plugin';
import { cancelSetup } from '../../plugin/test/setup-fixture.ts';
import { linearPrimarySecretNames } from '../src/config.ts';
import setup from '../src/setup.ts';
import { issue, setupWizard as wizard } from './setup-fixture.ts';

const appId = 'linear-app';
const publicUrl = 'https://aivi.example';
const answers = [appId, publicUrl, 'client-id', 'client-secret', 'signing-secret', 'team-1'];

test('Linear setup asks scripted questions, verifies both checks and cleans up before recording config', async t => {
  const h = wizard(t);
  const result = await setup(h.ctx);
  assert.equal(result.module, 'tracker-linear');
  assert.match(result.summary, /both checks passed.*Restart aivi/);
  assert.deepEqual(
    h.secretWrites.mock.calls.map(call => call.arguments),
    [
      [linearPrimarySecretNames.clientId, 'client-id'],
      [linearPrimarySecretNames.clientSecret, 'client-secret'],
      [linearPrimarySecretNames.webhookSecret, 'signing-secret'],
    ],
  );
  assert.deepEqual(
    h.configWrites.mock.calls.map(call => call.arguments),
    [
      [['host', 'public'], publicUrl],
      [['plugins', 'tracker-linear'], { apps: { [appId]: {} } }],
    ],
  );
  assert.deepEqual(h.delegate.mock.calls[0]!.arguments, [issue.id, 'bot-user']);
  assert.deepEqual(h.archive.mock.calls[0]!.arguments, [issue.id]);
  assert.equal(h.spinners.length, 2);
  for (const spinner of h.spinners) {
    assert.equal(spinner.stop.mock.callCount(), 1);
    assert.equal(spinner.cancel.mock.callCount(), 0);
  }
  assert.equal(h.listener.server.close.mock.callCount(), 1);
  assert.equal(h.listener.server.closeAllConnections.mock.callCount(), 1);
  assert.deepEqual(h.listener.server.listen.mock.calls[0]!.arguments.slice(0, 2), [0, '127.0.0.1']);
  const exchange = h.fetch.mock.calls.find(call => call.arguments[0] === 'https://api.linear.app/oauth/token')!;
  assert.equal(exchange.arguments[1]!.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.arguments[1]!.body as URLSearchParams)), {
    code: 'install-code',
    redirect_uri: 'http://127.0.0.1:4321/callback',
    client_id: 'client-id',
    client_secret: 'client-secret',
    grant_type: 'authorization_code',
  });
});

test('Linear setup preserves a single existing app and public URL without asking for either', async t => {
  const h = wizard(t, ['client-id', 'client-secret', 'signing-secret', 'team-1']);
  h.ctx.config = {
    version: 1,
    host: { public: publicUrl },
    plugins: { 'tracker-linear': { apps: { [appId]: {} }, agent: 'assistant' } },
  };
  await setup(h.ctx);
  assert.equal(h.questions.length, 4);
  assert.deepEqual(
    h.configWrites.mock.calls.map(call => call.arguments),
    [[['plugins', 'tracker-linear'], { apps: { [appId]: {} }, agent: 'assistant' }]],
  );
});

test('Linear setup refuses multiple configured apps before making a call or opening a listener', async t => {
  const h = wizard(t, []);
  h.ctx.config.plugins = { 'tracker-linear': { apps: { one: {}, two: {} } } };
  await assert.rejects(setup(h.ctx), /already has 2 Linear apps/);
  assert.equal(h.fetch.mock.callCount(), 0);
  assert.equal(h.listener.create.mock.callCount(), 0);
  assert.equal(h.configWrites.mock.callCount(), 0);
});

test('Linear setup stops before prompting when host health fails or the request rejects', async t => {
  for (const mode of ['unhealthy', 'unreachable'])
    await t.test(mode, async t => {
      const h = wizard(t, []);
      h.fetch.mock.mockImplementation(async () => {
        if (mode === 'unreachable') throw new Error('host down');
        return new Response(null, { status: 503 });
      });
      await assert.rejects(setup(h.ctx), /aivi must be running/);
      assert.equal(h.ask.mock.callCount(), 0);
      assert.equal(h.listener.create.mock.callCount(), 0);
      assert.equal(h.configWrites.mock.callCount(), 0);
    });
});

test('Linear setup validates names, public URLs and all three credential prompts', async t => {
  const h = wizard(t);
  await setup(h.ctx);
  const [name, url, clientId, clientSecret, signingSecret] = h.questions.map(question => question.validate!);
  assert.equal(name!(appId), undefined);
  for (const value of [undefined, '', 'Upper Case', '1app'])
    assert.equal(name!(value), 'lowercase letters, digits, dashes and underscores');
  assert.equal(url!(publicUrl), undefined);
  assert.equal(url!(`${publicUrl}/`), 'no trailing /');
  for (const value of [undefined, '', 'not a URL'])
    assert.equal(url!(value), 'an http(s) URL, like https://my-machine.ts.net');
  for (const [validate, message] of [
    [clientId!, 'Paste the Client ID from the app page'],
    [clientSecret!, 'Paste the Client Secret from the app page'],
    [signingSecret!, 'Paste the Signing Secret from the webhook section'],
  ] as const) {
    assert.equal(validate('value'), undefined);
    assert.equal(validate(''), message);
  }
});

test('cancelling any Linear setup question writes nothing and closes any opened listener', async t => {
  for (let at = 0; at < answers.length; at++)
    await t.test(`question ${at + 1}`, async t => {
      const scripted: unknown[] = [...answers];
      scripted[at] = cancelSetup;
      const h = wizard(t, scripted);
      await assert.rejects(setup(h.ctx), PluginSetupCancelled);
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
      assert.equal(h.listener.server.close.mock.callCount(), at < 2 ? 0 : 1);
      assert.equal(h.listener.server.closeAllConnections.mock.callCount(), at < 2 ? 0 : 1);
    });
});

test('credential or team-read failures close the listener and never write configuration', async t => {
  for (const method of ['viewer', 'teams'] as const)
    await t.test(method, async t => {
      const h = wizard(t);
      const failure = new Error(`${method} refused`);
      h[method].mock.mockImplementation(async () => {
        throw failure;
      });
      await assert.rejects(setup(h.ctx), failure);
      assert.equal(h.listener.server.close.mock.callCount(), 1);
      assert.equal(h.listener.server.closeAllConnections.mock.callCount(), 1);
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});

test('a refused install-code exchange closes the listener without writing secrets', async t => {
  const h = wizard(t);
  h.fetch.mock.mockImplementation(async url =>
    url.endsWith('/health') ? Response.json({ ok: true }) : new Response('bad code', { status: 400 }),
  );
  await assert.rejects(setup(h.ctx), /Linear refused the install code \(HTTP 400\): bad code/);
  assert.equal(h.listener.server.close.mock.callCount(), 1);
  assert.equal(h.secretWrites.mock.callCount(), 0);
  assert.equal(h.configWrites.mock.callCount(), 0);
});

test('no visible teams produces an explicit untested result without opening a store', async t => {
  const h = wizard(t, answers.slice(0, 5));
  h.teams.mock.mockImplementation(async () => []);
  const result = await setup(h.ctx);
  assert.match(result.summary, /nothing was tested — the app sees no teams/);
  assert.equal(h.withStore.mock.callCount(), 0);
  assert.equal(h.createIssue.mock.callCount(), 0);
  assert.equal(h.delegate.mock.callCount(), 0);
  assert.equal(h.secretWrites.mock.callCount(), 3);
});

test('a failed archive is said explicitly rather than hiding the leftover test ticket', async t => {
  const h = wizard(t);
  h.archive.mock.mockImplementation(async () => {
    throw new Error('archive denied');
  });
  assert.match((await setup(h.ctx)).summary, /both checks passed/);
  const lines = h.log.mock.calls.map(call => call.arguments[0]);
  assert.ok(lines.includes('Could not archive ENG-1 — delete it by hand (archive denied).'));
});

test('OAuth callback handling ignores unrelated requests and trades only a real code', async t => {
  const h = wizard(t);
  const printed = Promise.withResolvers<void>();
  h.print.mock.mockImplementation(value => {
    const url = new URL(String(value).split('\n\n')[1]!);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4321/callback');
    assert.equal(url.searchParams.get('client_id'), 'client-id');
    assert.equal(url.searchParams.get('scope'), 'read,write,app:assignable,app:mentionable');
    assert.equal(url.searchParams.get('actor'), 'app');
    printed.resolve();
  });
  const pending = setup(h.ctx);
  await printed.promise;
  for (const path of [undefined, '/favicon.ico', '/callback', '/elsewhere?code=ignored']) {
    const response = h.listener.request(path);
    assert.equal(response.writeHead.mock.calls[0]!.arguments[0], 404);
  }
  assert.equal(h.fetch.mock.callCount(), 1, 'no install exchange happens without a callback code');
  const response = h.listener.request('/callback?code=install-code');
  assert.deepEqual(response.writeHead.mock.calls[0]!.arguments, [200, { 'content-type': 'text/html' }]);
  assert.match(response.end.mock.calls[0]!.arguments[0] as string, /Linear is installed/);
  await pending;
});

test('listener errors before binding or while awaiting the callback stop setup and close its resources', async t => {
  for (const phase of ['bind', 'callback'])
    await t.test(phase, async t => {
      const h = wizard(t);
      const printed = Promise.withResolvers<void>();
      h.print.mock.mockImplementation(() => {
        printed.resolve();
      });
      if (phase === 'bind') h.listener.server.listen.mock.mockImplementation(() => {});
      const pending = setup(h.ctx);
      if (phase === 'bind') await h.listener.created;
      else await printed.promise;
      h.listener.server.emit('error', new Error('listener failed'));
      await assert.rejects(pending, /install listener could not listen: listener failed/);
      assert.equal(h.listener.server.close.mock.callCount(), 1);
      assert.equal(h.listener.server.closeAllConnections.mock.callCount(), 1);
      assert.equal(h.secretWrites.mock.callCount(), 0);
      assert.equal(h.configWrites.mock.callCount(), 0);
    });
});

test('a listener without a TCP address cannot proceed to credentials or leave its resources open', async t => {
  for (const address of [null, '/unexpected-socket'])
    await t.test(String(address), async t => {
      const h = wizard(t);
      h.listener.server.address.mock.mockImplementation(() => address);
      await assert.rejects(setup(h.ctx), /install listener could not report its port/);
      assert.equal(h.viewer.mock.callCount(), 0);
      assert.equal(h.listener.server.close.mock.callCount(), 1);
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});

test('a silent webhook check ends at a virtual deadline and does not repeat the same wait for agent events', async t => {
  const h = wizard(t);
  h.createIssue.mock.mockImplementation(async () => issue);
  const pending = setup(h.ctx);
  await h.watching[0].promise;
  t.mock.timers.tick(9000);
  const result = await pending;
  assert.match(result.summary, /FAILED — webhooks: nothing arrived in 9 s/);
  assert.match(result.summary, /agent events: not tested — no webhook arrived/);
  assert.equal(h.delegate.mock.callCount(), 0);
  assert.equal(h.archive.mock.callCount(), 1);
  assert.equal(h.spinners.length, 1);
  assert.equal(h.spinners[0]!.cancel.mock.callCount(), 1);
});

test('deliveries about other tickets fail only the issue check; the agent-event check still runs', async t => {
  const h = wizard(t);
  h.createIssue.mock.mockImplementation(async () => {
    h.append({ type: 'Issue', action: 'create', data: { id: 'other-issue', identifier: 'OTHER-1' } });
    return issue;
  });
  const pending = setup(h.ctx);
  await h.watching[0].promise;
  t.mock.timers.tick(9000);
  const result = await pending;
  assert.match(result.summary, /deliveries arrived, but none about ENG-1/);
  assert.equal(h.delegate.mock.callCount(), 1);
  assert.equal(h.spinners[1]!.stop.mock.callCount(), 1);
  assert.equal(h.archive.mock.callCount(), 1);
});

test('multiple issue deliveries are counted without leaving a poll running after success', async t => {
  const h = wizard(t);
  delete process.env.AIVI_PROBE_WINDOW_MS;
  h.createIssue.mock.mockImplementation(async () => {
    h.append({ type: 'Issue', action: 'create', data: { id: issue.id, identifier: issue.identifier } });
    h.append({ type: 'Issue', action: 'update', data: { id: issue.id }, updatedFrom: { stateId: 'old' } });
    return issue;
  });
  await setup(h.ctx);
  assert.match(h.spinners[0]!.stop.mock.calls[0]!.arguments[0], /2 issue deliveries arrived and verified/);
  const reads = h.diary.requests.mock.callCount();
  t.mock.timers.tick(90_000);
  assert.equal(h.diary.requests.mock.callCount(), reads, 'a completed wait owns no remaining timer');
});

test('the live progress line describes every verified delivery without confusing other events with proof', async t => {
  const h = wizard(t);
  h.createIssue.mock.mockImplementation(async () => {
    h.append({ type: 'Other', action: 'changed' });
    h.append({ type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'unnamed', status: 'pending' } });
    h.append({ type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'other', issue: { id: 'other' } } });
    h.append({ type: 'Issue', action: 'update', data: { id: 'other' }, updatedFrom: { stateId: 'old' } });
    h.append({ type: 'Issue', action: 'update', data: { id: 'other' } });
    h.append({ type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'early', issue } });
    h.append({ type: 'Issue', action: 'create', data: issue });
    return issue;
  });
  assert.match((await setup(h.ctx)).summary, /both checks passed/);
  const lines = h.spinners[0]!.message.mock.calls.map(call => call.arguments[0]);
  assert.ok(lines.includes('Heard: Other changed'));
  assert.ok(lines.includes('Heard: agent-session event: created, status pending on an issue the payload did not name'));
  assert.ok(lines.includes('Heard: agent-session event: created on an issue the payload did not name'));
  assert.ok(lines.includes('Heard: issue update on an issue the payload did not name, changed stateId'));
  assert.ok(lines.includes('Heard: issue update on an issue the payload did not name'));
});

test('a created session event proves the agent check even when the delegate response named no session', async t => {
  const h = wizard(t);
  h.delegate.mock.mockImplementation(async () => {
    h.append({ type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'session-1', issue } });
    return { success: true };
  });
  assert.match((await setup(h.ctx)).summary, /both checks passed/);
  assert.match(
    h.spinners[1]!.stop.mock.calls[0]!.arguments[0],
    /created session event arrived though the delegate answer named no session/,
  );
});

test('the agent deadline distinguishes a created session with no event from a delegation that made no session', async t => {
  for (const made of [true, false])
    await t.test(made ? 'session made' : 'no session', async t => {
      const h = wizard(t);
      h.delegate.mock.mockImplementation(async () => ({
        success: true,
        issue: {
          identifier: issue.identifier,
          agentSessions: {
            nodes: made
              ? [{ id: 'session-1', status: 'pending', startedAt: null, url: null }]
              : [{ id: 'session-1', status: 'completed', startedAt: null, url: null }],
          },
        },
      }));
      const pending = setup(h.ctx);
      await h.watching[1].promise;
      t.mock.timers.tick(9000);
      const result = await pending;
      assert.match(
        result.summary,
        made ? /session was created but its event did not arrive in 9 s/ : /no session at all/,
      );
      assert.equal(h.spinners[1]!.cancel.mock.callCount(), 1);
      assert.equal(h.archive.mock.callCount(), 1);
    });
});

test('polls consume later deliveries under a controlled clock, including a diary whose ids were reset', async t => {
  const h = wizard(t);
  h.append({ type: 'Other', action: 'old' }, { id: 100 });
  h.createIssue.mock.mockImplementation(async () => {
    h.diary.rows.length = 0;
    return issue;
  });
  h.delegate.mock.mockImplementation(async () => ({ success: true }));
  const pending = setup(h.ctx);
  await h.watching[0].promise;
  h.append({ type: 'Issue', action: 'create', data: issue });
  t.mock.timers.tick(2000);
  await h.watching[1].promise;
  h.append({ type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'session-1', issue } });
  t.mock.timers.tick(2000);
  assert.match((await pending).summary, /both checks passed/);
});
