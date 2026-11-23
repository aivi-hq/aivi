import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Logger } from '@aivi/core';
import { ConfigurationError } from '@aivi/plugin';
import {
  githubCredentials as credentials,
  GIT_USER,
  GITHUB_APP_ID_ENV,
  GITHUB_PRIVATE_KEY_ENV,
  GitHubApp,
  gitCredential,
  githubApp,
  resolveKeyPath,
} from '../src/github.ts';
import { installationToken, jwtClaims, privateKey, scripted } from './github-api.ts';

/** The credential is present for every test but the ones that watch what
 *  happens when it is not, which take it away and put it back. */
test.beforeEach(() => {
  process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;
  process.env[GITHUB_APP_ID_ENV] = '7';
});

test.afterEach(() => {
  delete process.env[GITHUB_PRIVATE_KEY_ENV];
  delete process.env[GITHUB_APP_ID_ENV];
});

test('the credential is read from the environment, and its absence says where to put it', () => {
  delete process.env[GITHUB_PRIVATE_KEY_ENV];
  assert.throws(
    () => credentials(),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match((error as Error).message, /GITHUB_APP_PRIVATE_KEY is not set/);
      assert.match((error as Error).message, /\.env/);
      return true;
    },
  );
  process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;
  delete process.env[GITHUB_APP_ID_ENV];
  assert.throws(() => credentials(), /GITHUB_APP_ID is not set/, 'the id is as much a credential as the key');
});

test('an app id that is not a number is said, not guessed at', () => {
  process.env[GITHUB_APP_ID_ENV] = 'aivi-agent';
  assert.throws(() => credentials(), /GITHUB_APP_ID is "aivi-agent", not a number/);
});

test('a key that arrived as one escaped line is a key again', () => {
  // A `.env` file is line-based, so a PEM is written with its newlines escaped
  // and read back as one line. The reader unwraps that shape.
  const escaped = privateKey.trim().replaceAll('\n', '\\n');
  const creds = credentials({ [GITHUB_APP_ID_ENV]: '7', [GITHUB_PRIVATE_KEY_ENV]: escaped });
  assert.equal(creds.appId, 7);
  assert.equal(creds.privateKey, privateKey.trim());
});

test('bytes that are not a private key are said as that, not as octokit’s complaint about formats', () => {
  assert.throws(
    () => credentials({ [GITHUB_APP_ID_ENV]: '7', [GITHUB_PRIVATE_KEY_ENV]: 'ghp_0123456789' }),
    /not a PEM private key/,
  );
});

test('the app proves itself, and the one installation it is granted is the one it speaks through', async () => {
  const { fetch, seen } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent', name: 'aivi' } }),
    'GET /app/installations': () => ({
      status: 200,
      body: [{ id: 99, account: { login: 'aivi-hq', id: 12 }, target_type: 'Organization' }],
    }),
  });
  const app = await GitHubApp.connect({ fetch });
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

test('a deprecation header GitHub answers with is a log line, not console noise', async () => {
  // Live: octokit's warning about the deprecated issue-creation endpoint
  // printed straight over the wizard's spinner. The fact goes to the
  // Logger the caller handed over — the same line, one place, heard or not
  // by the startup's one logging decision.
  const { fetch } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
    'POST /app/installations/99/access_tokens': () => installationToken(),
    'POST /repos/acme/shop/issues': () => ({
      status: 201,
      body: { number: 9 },
      headers: {
        deprecation: 'true',
        sunset: 'Fri, 10 Mar 2028 00:00:00 GMT',
        link: '<https://docs.github.com/en/rest/about-the-rest-api/api-versions>; rel="deprecation"',
      },
    }),
  });
  const warnings: string[] = [];
  const log = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => void warnings.push(message),
    error: () => {},
  } as unknown as Logger;
  const app = await GitHubApp.connect({ fetch, log });
  const created = await app.octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner: 'acme',
    repo: 'shop',
    title: 'test',
  });
  assert.equal(created.status, 201, 'the deprecated endpoint still answers');
  assert.equal(warnings.length, 1, `the warning reached the Logger once: ${warnings.join(' | ')}`);
  assert.match(warnings[0]!, /POST https:\/\/api\.github\.com\/repos\/acme\/shop\/issues.*is deprecated/);
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
  const app = await GitHubApp.connect({ fetch });
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
  await assert.rejects(GitHubApp.connect({ fetch }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match((error as Error).message, /installed on no account/);
    assert.match((error as Error).message, /https:\/\/github\.com\/apps\/aivi-agent\/installations\/new/);
    return true;
  });
});

test('the transport retries are the caller’s: off, a refused request stands as the answer', async () => {
  let asks = 0;
  const { fetch } = scripted({
    'GET /app': () => {
      asks += 1;
      return { status: 502, body: { message: 'bad gateway' } };
    },
  });
  await assert.rejects(GitHubApp.connect({ fetch, retry: { enabled: false } }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match((error as Error).message, /refused the credential/);
    return true;
  });
  assert.equal(asks, 1, 'no hidden re-asks: the scripted answer was the answer');
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
  await assert.rejects(GitHubApp.connect({ fetch }), (error: unknown) => {
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
  await assert.rejects(GitHubApp.connect({ fetch }), (error: unknown) => {
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
  const app = await GitHubApp.connect({ fetch });
  assert.deepEqual(await app.repository('acme', 'widget'), {
    defaultBranch: 'main',
    cloneUrl: 'https://github.com/acme/widget.git',
    private: true,
  });
  assert.equal(await app.repository('acme', 'hidden'), undefined);
});

test('one process, one app: the shared client connects once and every caller shares it', async () => {
  let connects = 0;
  const { fetch } = scripted({
    'GET /app': () => {
      connects++;
      return { status: 200, body: { id: 7, slug: 'aivi-agent' } };
    },
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
  });
  const first = await githubApp({ fetch });
  const second = await githubApp({ fetch });
  assert.equal(first, second, 'the forge and the tracker speak through one client');
  assert.equal(connects, 1, 'the JWT and the installation read are paid once');
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

test('the grant, the hook, and its deliveries read with the app’s own JWT', async () => {
  const { fetch, seen } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 9, account: { login: 'aivi-hq' } }] }),
    'GET /app/installations/9': () => ({
      status: 200,
      body: {
        id: 9,
        events: ['issues', 'issue_comment'],
        permissions: { issues: 'write', organization_projects: 'read', members: null },
      },
    }),
    'GET /app/hook/config': () => ({
      status: 200,
      body: { url: 'https://my-machine.ts.net/github/webhooks', insecure_ssl: 0 },
    }),
    'GET /app/hook/deliveries': () => ({
      status: 200,
      body: [
        {
          id: 28173922244,
          guid: 'g-1',
          delivered_at: '2026-10-07T00:00:00Z',
          redelivery: false,
          duration: 0.04,
          status: 'failed',
          status_code: 405,
          event: 'issues',
          action: null,
        },
        {
          id: 2,
          guid: 'g-2',
          delivered_at: '2026-10-07T00:00:01Z',
          redelivery: false,
          duration: 0.03,
          status: 'ok',
          status_code: 204,
          event: 'issue_comment',
          action: 'created',
        },
      ],
    }),
  });
  const app = await GitHubApp.connect({ fetch });

  assert.deepEqual(
    await app.grantFacts(),
    { events: ['issues', 'issue_comment'], permissions: { issues: 'write', organization_projects: 'read' } },
    'the grant record in aivi words; a null permission level is not a level',
  );
  assert.deepEqual(await app.webhookConfig(), {
    url: 'https://my-machine.ts.net/github/webhooks',
    insecureSsl: false,
  });
  const deliveries = await app.webhookDeliveries(2);
  assert.equal(deliveries[0]?.id, '28173922244', 'delivery ids exceed 2^53: strings, never numbers');
  assert.deepEqual(deliveries[1], {
    id: '2',
    event: 'issue_comment',
    action: 'created',
    status: 'ok',
    statusCode: 204,
  });
  assert.equal((await app.webhookDeliveries(1)).length, 1, 'the cap cuts the answer');

  // The reads that answer “can the tracker work here” carry the app’s own JWT:
  // no installation token reads its own grant.
  for (const path of ['/app/installations/9', '/app/hook/config', '/app/hook/deliveries']) {
    const call = seen.find(other => other.path === path);
    assert.ok(call, `${path} was asked`);
    assert.equal(jwtClaims(call.authorization).iss, '7', `${path} carries the app JWT`);
  }
});

test('a replayed delivery keeps its id byte-exact and carries the app’s JWT', async () => {
  const { fetch, seen } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 9, account: { login: 'aivi-hq' } }] }),
    'POST /app/hook/deliveries/28173922244/attempts': () => ({ status: 204, body: null }),
  });
  const app = await GitHubApp.connect({ fetch });
  await app.redeliverWebhook('28173922244');
  const attempt = seen.find(call => call.method === 'POST');
  assert.ok(attempt, 'the attempt was asked for');
  assert.equal(
    attempt.path,
    '/app/hook/deliveries/28173922244/attempts',
    'the id survives: not coerced through a number',
  );
  assert.equal(jwtClaims(attempt.authorization).iss, '7', 'the replay is the app asking, not an installation');
});

test('a typed key path belongs to the directory the person ran the command from', t => {
  const had = process.env.INIT_CWD;
  t.after(() => {
    if (had === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = had;
  });
  process.env.INIT_CWD = '/home/dev/projects/team/aivi/dev';
  assert.equal(
    resolveKeyPath('./.config/aivi-agent.pem'),
    '/home/dev/projects/team/aivi/dev/.config/aivi-agent.pem',
    'npm moved the process to the package root; the typed path stays where the person typed it',
  );
  delete process.env.INIT_CWD;
  assert.equal(resolveKeyPath('a.pem'), join(process.cwd(), 'a.pem'), 'without npm, the process cwd is the person’s');
  assert.equal(resolveKeyPath('  /abs/b.pem  '), '/abs/b.pem', 'an absolute path is already a place; spaces are noise');
  assert.equal(resolveKeyPath('~/c.pem'), join(homedir(), 'c.pem'), '~ is the operator’s home');
});

/** One installation, granted to aivi-hq: what the reads below connect through. */
const GRANT = {
  'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
  'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
  'POST /app/installations/99/access_tokens': () => installationToken(),
};

const repos = (from: number, count: number) =>
  Array.from({ length: count }, (_, at) => ({ full_name: `acme/repo-${from + at}`, default_branch: 'main' }));

test('the repositories a grant reaches are read a page at a time, until a short page or the cap', async () => {
  const asked: string[] = [];
  const pages: Record<string, unknown[]> = { 1: repos(0, 100), 2: repos(100, 100), 3: repos(200, 5) };
  const { fetch } = scripted({
    ...GRANT,
    'GET /installation/repositories': call => {
      const query = new URL(`http://x${call.search}`).searchParams;
      asked.push(`${query.get('per_page')}/${query.get('page')}`);
      return { status: 200, body: { total_count: 205, repositories: pages[query.get('page')!] } };
    },
  });
  const app = await GitHubApp.connect({ fetch });

  const everything = await app.repositories();

  assert.equal(everything.length, 205);
  assert.deepEqual(everything[0], { id: 'acme/repo-0', defaultBranch: 'main' });
  assert.deepEqual(everything.at(-1), { id: 'acme/repo-204', defaultBranch: 'main' });
  assert.deepEqual(asked, ['100/1', '100/2', '100/3'], 'a short page is the last one');

  asked.length = 0;
  assert.equal((await app.repositories(150)).length, 150);
  assert.deepEqual(asked, ['100/1', '100/2'], 'the cap ends the paging too');
});

test('a grant whose answer lists no repositories reaches none', async () => {
  const { fetch } = scripted({
    ...GRANT,
    'GET /installation/repositories': () => ({ status: 200, body: { total_count: 0 } }),
  });

  assert.deepEqual(await (await GitHubApp.connect({ fetch })).repositories(), []);
});

test('a repository GitHub will not show is absent, and any other failure is an error to see', async () => {
  const { fetch, seen } = scripted({
    ...GRANT,
    'GET /repos/acme/forbidden': () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }),
    'GET /repos/acme/broken': () => ({ status: 500, body: { message: 'Server Error' } }),
  });
  const app = await GitHubApp.connect({ fetch, retry: { enabled: false } });

  assert.equal(await app.repository('acme', 'forbidden'), undefined);
  await assert.rejects(
    app.repository('acme', 'broken'),
    (error: unknown) => (error as { status?: number }).status === 500,
  );

  assert.equal(
    seen.filter(call => call.path === '/repos/acme/broken').length,
    1,
    'retries are off, so it was asked once',
  );
});

test('an answer that names no app is a refused credential', async () => {
  const { fetch } = scripted({ 'GET /app': () => ({ status: 200, body: { id: 7 } }) });

  await assert.rejects(GitHubApp.connect({ fetch }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match((error as Error).message, /refused the credential for app 7.*GitHub answered with no app/);
    return true;
  });
});

test('installations are named by their account login, else the account id, else as unknown', async () => {
  const { fetch } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({
      status: 200,
      body: [{ id: 99, account: { login: 'aivi-hq' } }, { id: 100, account: { id: 55 } }, { id: 101 }],
    }),
  });

  await assert.rejects(GitHubApp.connect({ fetch }), /installed 3 times \(aivi-hq #99, 55 #100, \? #101\)/);
});

test('an installation that shows no account login is named by its id', async () => {
  const { fetch } = scripted({
    ...GRANT,
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99 }] }),
  });

  assert.equal((await GitHubApp.connect({ fetch })).accountLogin, '99');
});

test('with no fetch of its own, the connection reaches GitHub through the global one', async t => {
  const { fetch, calls } = scripted(GRANT);
  t.mock.method(globalThis, 'fetch', fetch);

  const app = await GitHubApp.connect();

  assert.equal(app.appSlug, 'aivi-agent');
  assert.deepEqual(calls(), ['GET /app', 'GET /app/installations']);
});

test('a mint that answers with no token is an error naming the installation, not an empty credential', async () => {
  const { fetch } = scripted({
    ...GRANT,
    'POST /app/installations/99/access_tokens': () => ({
      status: 201,
      body: {
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: {},
        repository_selection: 'all',
      },
    }),
  });

  await assert.rejects(
    (await GitHubApp.connect({ fetch })).gitToken(),
    /octokit answered with no installation token for #99/,
  );
});

test('a grant that records no permissions or events says none, and a hook that says nothing has no url and is not insecure', async () => {
  let hook: Record<string, unknown> = {};
  const { fetch } = scripted({
    ...GRANT,
    'GET /app/installations/99': () => ({ status: 200, body: { id: 99 } }),
    'GET /app/hook/config': () => ({ status: 200, body: hook }),
  });
  const app = await GitHubApp.connect({ fetch });

  assert.deepEqual(await app.grantFacts(), { events: [], permissions: {} });
  assert.deepEqual(await app.webhookConfig(), { url: '', insecureSsl: false });
  for (const [insecure, downgraded] of [
    [0, false],
    ['0', false],
    [1, true],
    ['1', true],
  ] as const) {
    hook = { url: 'https://my-machine.ts.net/github/webhooks', insecure_ssl: insecure };
    assert.equal((await app.webhookConfig()).insecureSsl, downgraded, `insecure_ssl ${JSON.stringify(insecure)}`);
  }
});
