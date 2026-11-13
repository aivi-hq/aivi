import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV, GitHubApp } from '@aivi/github';
import { cancelSetup, setupFixture } from '../../plugin/test/setup-fixture.ts';
import setup from '../src/setup.ts';

const privateKey = '-----BEGIN PRIVATE KEY-----\nunit-test-key\n-----END PRIVATE KEY-----';

function wizard(t: TestContext) {
  t.mock.property(process, 'env', {
    ...process.env,
    [GITHUB_APP_ID_ENV]: '7',
    [GITHUB_PRIVATE_KEY_ENV]: privateKey,
  });
  const h = setupFixture(t);
  const repositories = t.mock.fn(async () => ({
    data: {
      total_count: 2,
      repositories: [
        { full_name: 'acme/old', archived: true },
        { full_name: 'acme/current', archived: false },
      ],
    },
  }));
  const pulls = t.mock.fn(async (_request: unknown) => ({ data: [{ number: 1 }] }));
  const app = {
    appSlug: 'aivi-app',
    accountLogin: 'acme',
    installationId: 42,
    octokit: { rest: { apps: { listReposAccessibleToInstallation: repositories }, pulls: { list: pulls } } },
  };
  const connect = t.mock.method(GitHubApp, 'connect', async () => app as unknown as GitHubApp);
  return { ...h, repositories, pulls, connect };
}

test('forge setup reads an active repository before recording its empty config block', async t => {
  const h = wizard(t);
  h.pulls.mock.mockImplementation(async request => {
    assert.deepEqual(request, { owner: 'acme', repo: 'current', state: 'all', per_page: 3 });
    assert.equal(h.configWrites.mock.callCount(), 0, 'a successful read must precede the write');
    return { data: [{ number: 1 }] };
  });
  const result = await setup(h.ctx);
  assert.equal(result.module, 'forge-github');
  assert.match(result.summary, /app aivi-app.*installation #42 on acme.*read acme\/current/);
  assert.deepEqual(h.connect.mock.calls[0]!.arguments[0]!.credentials, { appId: 7, privateKey });
  assert.deepEqual(h.repositories.mock.calls[0]!.arguments, [{ per_page: 100 }]);
  assert.deepEqual(
    h.configWrites.mock.calls.map(call => call.arguments),
    [[['plugins', 'forge-github'], {}]],
  );
  assert.equal(h.secretWrites.mock.callCount(), 0, 'the held identity is not written again');
  assert.equal(h.ask.mock.callCount(), 0);
  assert.match(h.log.mock.calls.at(-1)!.arguments[0], /2 repositories.*1 pull request\./);
});

test('forge setup falls back to an archived repository when the grant contains no active one', async t => {
  const h = wizard(t);
  h.repositories.mock.mockImplementation(async () => ({
    data: { total_count: 100, repositories: [{ full_name: 'acme/old', archived: true }] },
  }));
  h.pulls.mock.mockImplementation(async () => ({ data: [] }));
  await setup(h.ctx);
  assert.deepEqual(h.pulls.mock.calls[0]!.arguments, [{ owner: 'acme', repo: 'old', state: 'all', per_page: 3 }]);
  assert.match(h.log.mock.calls.at(-1)!.arguments[0], /more than 100 repositories.*0 pull requests\./);
});

test('forge setup refuses a grant with no repositories and writes no config', async t => {
  const h = wizard(t);
  h.repositories.mock.mockImplementation(async () => ({ data: { total_count: 0, repositories: [] } }));
  await assert.rejects(setup(h.ctx), /installation #42 reaches no repository/);
  assert.equal(h.pulls.mock.callCount(), 0);
  assert.equal(h.configWrites.mock.callCount(), 0);
});

test('forge setup propagates connection and repository-read failures without recording success', async t => {
  const h = wizard(t);
  const refused = new Error('credentials refused');
  h.connect.mock.mockImplementationOnce(async () => {
    throw refused;
  });
  await assert.rejects(setup(h.ctx), refused);
  const unreadable = new Error('repository access denied');
  h.pulls.mock.mockImplementation(async () => {
    throw unreadable;
  });
  await assert.rejects(setup(h.ctx), unreadable);
  assert.equal(h.configWrites.mock.callCount(), 0);
  assert.equal(h.secretWrites.mock.callCount(), 0);
});

test('cancelling the identity question stops forge setup before connecting or writing', async t => {
  const h = wizard(t);
  delete process.env[GITHUB_APP_ID_ENV];
  const cancelled = setupFixture(t, [cancelSetup]);
  await assert.rejects(setup(cancelled.ctx), /cancelled at the app identity/);
  assert.equal(h.connect.mock.callCount(), 0);
  assert.equal(cancelled.configWrites.mock.callCount(), 0);
  assert.equal(cancelled.secretWrites.mock.callCount(), 0);
});
