import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema } from '@aivi/core';
import type { QmdSDK } from '../src/index.ts';
import { createKnowledgeService } from '../src/index.ts';

test('scopes are filtered before search; empty/unknown scopes cannot broaden retrieval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1, stateDirectory: root, search: { provider: 'qmd' } }),
    projects: [{ id: 'app', directory: root, settings: { knowledge: [] } }],
    sources: [
      { id: 'core', path: root, kind: 'doc', scope: 'core' },
      { id: 'docs', path: root, kind: 'doc', scope: 'project', projectId: 'app' },
    ],
  };
  const requests: string[][] = [];
  const sdk: QmdSDK = {
    async createStore() {
      return {
        async searchLex(_q, options) {
          requests.push(options.collection);
          return [];
        },
        async update() {},
        async close() {},
      };
    },
    extractSnippet() {
      return { snippet: '', line: 1 };
    },
  };
  const service = await createKnowledgeService(loaded, async () => sdk);
  t.after(() => service.close());
  await service.search({ query: 'a', projects: ['app'], includeCore: false });
  assert.equal(requests[0]!.length, 1);
  await service.search({ query: 'a' });
  assert.equal(requests[1]!.length, 2);
  await service.search({ query: 'a', projects: [], includeCore: false });
  assert.equal(requests.length, 2);
  assert.throws(() => service.search({ query: 'a', projects: ['typo'] }), /Unknown project/);
  assert.throws(() => service.search({ query: '' }));
});

test('real QMD keyword indexing retrieves scoped documents and refreshes modified/deleted content', async t => {
  // Hits carry canonical paths; macOS aliases /var to /private/var, so compare against realpath.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aivi-qmd-real-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'company'));
  await mkdir(join(root, 'project'));
  const company = join(root, 'company/Handbook.md');
  const project = join(root, 'project/Decision Notes.md');
  await writeFile(company, '# Company\n\nOrchard is our shared deployment process.');
  await writeFile(project, '# Decision\n\nOrchard uses a blue release for this project.');
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1, stateDirectory: root, search: { provider: 'qmd' } }),
    projects: [{ id: 'app', directory: join(root, 'project'), settings: { knowledge: [] } }],
    sources: [
      { id: 'company', path: join(root, 'company'), kind: 'doc', scope: 'core' },
      { id: 'adrs', path: join(root, 'project'), kind: 'decision', scope: 'project', projectId: 'app' },
    ],
  };
  let sdk: QmdSDK;
  try {
    const name = '@tobilu/qmd';
    sdk = (await import(name)) as QmdSDK;
  } catch {
    t.skip('Optional QMD dependency is not installed');
    return;
  }
  const service = await createKnowledgeService(loaded, async () => sdk);
  t.after(() => service.close());
  await service.index();
  const all = await service.search({ query: 'Orchard' });
  assert.equal(all.length, 2);
  assert.ok(all.every(h => h.excerpt.includes('Orchard') && h.line > 0));
  const scoped = await service.search({ query: 'Orchard', projects: ['app'], includeCore: false });
  assert.deepEqual(
    scoped.map(h => h.path),
    [project],
  );
  assert.equal(scoped[0]!.kind, 'decision');
  assert.deepEqual(
    (await service.search({ query: 'Orchard', kinds: ['decision'] })).map(h => h.path),
    [project],
    'kind filter narrows across scopes',
  );
  assert.deepEqual(
    (await service.search({ query: 'Orchard', projects: [] })).map(h => h.path),
    [company],
  );
  await writeFile(project, '# Updated\n\nCobalt is the new process.');
  await rm(company);
  await service.index();
  assert.deepEqual(await service.search({ query: 'Orchard' }), []);
  assert.equal((await service.search({ query: 'Cobalt' }))[0]!.path, project);
});

test('backend scope violations are rejected rather than relabelled as permitted results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-search-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1, stateDirectory: root, search: { provider: 'qmd' } }),
    projects: [],
    sources: [{ id: 'core', path: root, kind: 'doc', scope: 'core' }],
  };
  const service = await createKnowledgeService(loaded, async () => ({
    async createStore() {
      return {
        async update() {},
        async close() {},
        async searchLex() {
          return [
            {
              collectionName: 'unconfigured',
              filepath: '/private',
              displayPath: 'private',
              title: 'Private',
              score: 1,
              body: 'private',
            },
          ];
        },
      };
    },
    extractSnippet() {
      return { snippet: '', line: 1 };
    },
  }));
  t.after(() => service.close());
  await assert.rejects(service.search({ query: 'secret' }), /out-of-scope/);
});
