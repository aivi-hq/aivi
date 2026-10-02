/** The module as the host starts it: the credential is proven, the forge is
 *  registered so the machinery has someone to ask, and stop gives the
 *  registration back. The GitHub behind the fetch only says what was
 *  scripted — the same fake the credential tests run. */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { getLogger } from '@aivi/core';
import { Forges } from '@aivi/host';
import type { AiviServices } from '@aivi/plugin';
import type { ForgeGithubConfig } from '../src/config.ts';
import { GITHUB_PRIVATE_KEY_ENV } from '../src/config.ts';
import { createForgeGithubModule } from '../src/module.ts';
import { privateKey, scripted } from './github-api.ts';

const run = promisify(execFile);

test('the module registers its forge at start; the registry answers for a GitHub remote, and stop unregisters', async t => {
  const previous = process.env[GITHUB_PRIVATE_KEY_ENV];
  process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;
  t.after(() => {
    if (previous === undefined) delete process.env[GITHUB_PRIVATE_KEY_ENV];
    else process.env[GITHUB_PRIVATE_KEY_ENV] = previous;
  });
  const { fetch } = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetch as never;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  // A checkout whose origin is a GitHub repository: the forge recognises it
  // from the local read of `origin` alone.
  const root = await mkdtemp(join(tmpdir(), 'aivi-forge-module-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'site');
  await run('git', ['init', '-q', '-b', 'main', source]);
  await run('git', ['-C', source, 'remote', 'add', 'origin', 'https://github.com/acme/site.git']);

  const forges = new Forges();
  const services = { log: getLogger(['aivi', 'test']), forges } as unknown as AiviServices;
  const running = await createForgeGithubModule({ app: 7 } satisfies ForgeGithubConfig).start(services);

  const owned = await forges.owner({ id: 'site', directory: source });
  assert.equal(owned?.repo.id, 'acme/site', 'the registered forge owns the GitHub remote');
  assert.ok(owned?.repo.remote.startsWith('https://'), 'the transfer URL is HTTPS, as the ruling says');

  await running.stop();
  assert.equal(await forges.owner({ id: 'site', directory: source }), undefined, 'stop gives the registration back');
});
