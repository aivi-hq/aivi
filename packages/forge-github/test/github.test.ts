import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError } from '@aivi/host';
import { GITHUB_PRIVATE_KEY_ENV } from '../src/config.ts';
import { GIT_USER } from '../src/github.ts';
import { githubCredentials as credentials, GitHubApp, gitCredential } from '../src/index.ts';
import { installationToken, jwtClaims, privateKey, scripted } from './github-api.ts';

/** The credential is present for every test but the ones that watch what
 *  happens when it is not, which take it away and put it back. */
test.beforeEach(() => {
  process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;
});

test.afterEach(() => {
  delete process.env[GITHUB_PRIVATE_KEY_ENV];
});

test('the private key is read from the environment, and its absence says where to put it', () => {
  delete process.env[GITHUB_PRIVATE_KEY_ENV];
  assert.throws(
    () => credentials({ app: 7 }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match((error as Error).message, /GITHUB_APP_PRIVATE_KEY is not set/);
      assert.match((error as Error).message, /\.env/);
      return true;
    },
  );
});

test('a key that arrived as one escaped line is a key again', () => {
  // A `.env` file is line-based, so a PEM is written with its newlines escaped
  // and read back as one line. The reader unwraps that shape.
  const escaped = privateKey.trim().replaceAll('\n', '\\n');
  const creds = credentials({ app: 7 }, { [GITHUB_PRIVATE_KEY_ENV]: escaped });
  assert.equal(creds.appId, 7);
  assert.equal(creds.privateKey, privateKey.trim());
});

test('bytes that are not a private key are said as that, not as octokit’s complaint about formats', () => {
  assert.throws(() => credentials({ app: 7 }, { [GITHUB_PRIVATE_KEY_ENV]: 'ghp_0123456789' }), /not a PEM private key/);
});

test('the app proves itself, and the one installation it is granted is the one it speaks through', async () => {
  const { fetch, seen } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent', name: 'aivi' } }),
    'GET /app/installations': () => ({
      status: 200,
      body: [{ id: 99, account: { login: 'aivi-hq', id: 12 }, target_type: 'Organization' }],
    }),
  });
  const app = await GitHubApp.connect({ app: 7 }, { fetch });
  assert.equal(app.appSlug, 'aivi-agent');
  assert.equal(app.installationId, 99);
  assert.equal(app.accountLogin, 'aivi-hq');
  // The reads that found this were made as the app, not as an installation: no
  // installation token exists yet, and the app's own JWT is what GitHub took.
  assert.deepEqual(
    seen.map(call => `${call.method} ${call.path}`),
    ['GET /app', 'GET /app/installations'],
  );
  assert.equal(jwtClaims(seen[0]?.authorization).iss, '7');
});

test('the installation token is minted once and held: nothing mints per command', async () => {
  let mints = 0;
  const { fetch, seen } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
    'POST /app/installations/99/access_tokens': () => {
      mints++;
      return installationToken(mints);
    },
  });
  const app = await GitHubApp.connect({ app: 7 }, { fetch });
  assert.equal(mints, 0, 'connecting authenticates as the app and mints nothing');
  assert.equal(await app.gitToken(), 'ghs_token_1');
  assert.equal(await app.gitToken(), 'ghs_token_1', 'the same token is still the current one');
  assert.equal(mints, 1);
  // The mint itself is the app asking an installation for a token: the app's
  // JWT on the request, the answer belonging to installation 99.
  const mint = seen.find(call => call.method === 'POST');
  assert.equal(jwtClaims(mint?.authorization).iss, '7');
});

test('an app nobody installed says so with the link that fixes it', async () => {
  const { fetch } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [] }),
  });
  await assert.rejects(GitHubApp.connect({ app: 7 }, { fetch }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match((error as Error).message, /installed on no account/);
    assert.match((error as Error).message, /https:\/\/github\.com\/apps\/aivi-agent\/installations\/new/);
    return true;
  });
});

test('an app installed twice is a setup error naming the grants, never a choice aivi makes', async () => {
  const { fetch } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({
      status: 200,
      body: [
        { id: 99, account: { login: 'aivi-hq' } },
        { id: 100, account: { login: 'someone-else' } },
      ],
    }),
  });
  await assert.rejects(GitHubApp.connect({ app: 7 }, { fetch }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match((error as Error).message, /installed 2 times/);
    assert.match((error as Error).message, /aivi-hq #99, someone-else #100/);
    assert.match((error as Error).message, /one installation/);
    return true;
  });
});

test('a key that is not the app’s is a configuration failure, not something to retry', async () => {
  const { fetch, seen } = scripted({
    'GET /app': () => ({ status: 401, body: { message: 'Bad credentials' } }),
  });
  await assert.rejects(GitHubApp.connect({ app: 7 }, { fetch }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match((error as Error).message, /refused the credential for app 7/);
    assert.match((error as Error).message, /same app/);
    return true;
  });
  assert.equal(seen.length, 1, 'one attempt: a refused credential is not retried');
});

test('a repository under the grant answers, and one outside it answers 404 — which is the same as absent', async () => {
  const { fetch } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
    'POST /app/installations/99/access_tokens': () => installationToken(),
    'GET /repos/acme/widget': () => ({
      status: 200,
      body: { default_branch: 'main', clone_url: 'https://github.com/acme/widget.git', private: true },
    }),
    'GET /repos/acme/hidden': () => ({ status: 404, body: { message: 'Not Found' } }),
  });
  const app = await GitHubApp.connect({ app: 7 }, { fetch });
  assert.deepEqual(await app.repository('acme', 'widget'), {
    defaultBranch: 'main',
    cloneUrl: 'https://github.com/acme/widget.git',
    private: true,
  });
  assert.equal(await app.repository('acme', 'hidden'), undefined);
});

test('a transfer authenticates in the environment, where a process listing cannot read it', () => {
  const env = gitCredential('ghs_secret');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.equal(
    env.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from(`${GIT_USER}:ghs_secret`).toString('base64')}`,
    "GitHub's HTTPS transport takes the installation token as x-access-token's password",
  );
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper', 'the person’s stored credential is switched off');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
});
