/** The process-wide app: one client for the forge and the tracker, and a failed connection is
 *  not remembered. It has a test file of its own because the client is kept for the life of the
 *  process, so the order of the calls is the test. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError } from '@aivi/plugin';
import { githubApp } from '../src/github.ts';
import { scripted } from './github-api.ts';

test('a failed connection is not cached: the next caller connects again, and then everyone shares that one', async () => {
  const refused = scripted({ 'GET /app': () => ({ status: 401, body: { message: 'Bad credentials' } }) });
  await assert.rejects(githubApp({ fetch: refused.fetch }), ConfigurationError);

  const granted = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
  });
  const app = await githubApp({ fetch: granted.fetch });

  assert.equal(app.appSlug, 'aivi-agent');
  assert.equal(await githubApp({ fetch: refused.fetch }), app, 'the connection that worked is the one everyone gets');
  assert.deepEqual(refused.calls(), ['GET /app'], 'the refused fetch was asked once, by the caller that failed');
});
