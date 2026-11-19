/** How the tracker and its setup wizard reach GitHub: through the home's one
 *  app. `githubApp` is a module mock, registered before the units are
 *  imported: the real one keeps a single connection for the whole process and
 *  would call GitHub. */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { getLogger } from '@aivi/core';
import * as github from '@aivi/github';
import { ConfigurationError, type ProjectSetupContext } from '@aivi/plugin';

const graphql = mock.fn(async (_query: string, _variables: unknown) => ({
  organization: { id: 'O_1', projectV2: null },
}));
const app = { appSlug: 'aivi-agent', accountLogin: 'aivi-hq', octokit: { graphql } };
const githubApp = mock.fn(async (_options?: github.GitHubOptions) => app as unknown as github.GitHubApp);
mock.module('@aivi/github', { exports: { ...github, githubApp } });

const { githubClient } = await import('../src/client.ts');
const { contributor } = await import('../src/setup-project.ts');

test('the tracker’s client speaks through the home’s one app, with the log it was given', async t => {
  t.mock.property(process, 'env', { ...process.env, [github.GITHUB_WEBHOOK_SECRET_ENV]: 'whsec' });
  githubApp.mock.resetCalls();
  const log = getLogger(['aivi', 'test']);
  const { client, webhookSecret } = await githubClient(log);
  assert.equal(webhookSecret, 'whsec');
  assert.deepEqual([client.org, client.botLogin, client.delegateName], ['aivi-hq', 'aivi-agent[bot]', 'aivi-agent']);
  assert.equal(githubApp.mock.callCount(), 1);
  assert.equal(githubApp.mock.calls[0]!.arguments[0]?.log, log);
});

test('a client asked for with no log connects with none', async t => {
  t.mock.property(process, 'env', { ...process.env, [github.GITHUB_WEBHOOK_SECRET_ENV]: 'whsec' });
  githubApp.mock.resetCalls();
  await githubClient();
  assert.deepEqual(
    githubApp.mock.calls.map(call => call.arguments),
    [[{}]],
  );
});

test('no webhook secret in the home refuses the client, naming where to put it', async t => {
  t.mock.property(process, 'env', { ...process.env, [github.GITHUB_WEBHOOK_SECRET_ENV]: undefined });
  await assert.rejects(githubClient(), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, /GITHUB_WEBHOOK_SECRET is not set.*<home>\/\.env/);
    return true;
  });
});

test('the wizard’s own client reads the board through the home’s app, with the wizard’s log', async t => {
  githubApp.mock.resetCalls();
  graphql.mock.resetCalls();
  const spinner = { start: t.mock.fn(), stop: t.mock.fn(), error: t.mock.fn() };
  const ctx = {
    config: {},
    configPath: join(tmpdir(), 'aivi-no-home', 'config.json'),
    fetch: async () => new Response(),
    prompts: {
      select: async () => 'skip', // no live aivi answers: continue unverified
      text: async () => '1', // the board number
      isCancel: () => false,
      spinner: () => spinner,
      log: { message: async () => {} },
    },
  } as unknown as ProjectSetupContext;

  await assert.rejects(contributor.setup(ctx), /board 1 is not visible to the app in aivi-hq/);

  assert.equal(githubApp.mock.calls[0]!.arguments[0]?.log, getLogger(['aivi', 'projects']));
  assert.deepEqual(
    graphql.mock.calls.map(call => call.arguments[1]),
    [{ owner: 'aivi-hq', number: 1 }],
    'the board is read in the account the app was granted',
  );
  assert.match(String(spinner.error.mock.calls[0]!.arguments[0]), /board 1 is not visible to the app in aivi-hq/);
});
