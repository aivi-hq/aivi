import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LoadedConfig, Logger } from '@aivi/core';
import { configSchema, getLogger } from '@aivi/core';
import type { QmdSDK } from '../src/index.ts';
import { createKnowledgeService } from '../src/index.ts';

/** A fresh logger whose `warn` records into `sink`; `.with({})` keeps the shared category logger untouched. */
function warningCatcher(sink: (event: string, data?: unknown) => void): Logger {
  return Object.assign(getLogger(['aivi', 'knowledge']).with({}), { warn: sink });
}

test('scopes are filtered before search; empty/unknown scopes cannot broaden retrieval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1, stateDirectory: root, search: { provider: 'qmd' } }),
    projects: [{ id: 'app', directory: root }],
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
  await assert.rejects(service.search({ query: 'a', projects: ['typo'] }), /Unknown project/);
  await assert.rejects(service.search({ query: '' }));
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
    projects: [{ id: 'app', directory: join(root, 'project') }],
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

test('a file belongs to its most specific source; missing directories are skipped and memory directories created', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aivi-qmd-nested-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/adr'), { recursive: true });
  await writeFile(join(root, 'docs/guide.md'), '# Guide\n\nPelican explains the release flow.');
  await writeFile(join(root, 'docs/adr/0001.md'), '# ADR\n\nPelican releases are decided on Tuesdays.');
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1, stateDirectory: root, search: { provider: 'qmd' } }),
    projects: [{ id: 'app', directory: root }],
    sources: [
      { id: 'docs', path: join(root, 'docs'), kind: 'doc', scope: 'project', projectId: 'app' },
      { id: 'adr', path: join(root, 'docs/adr'), kind: 'decision', scope: 'project', projectId: 'app' },
      { id: 'research', path: join(root, 'docs/research'), kind: 'doc', scope: 'project', projectId: 'app' },
      { id: 'memory', path: join(root, 'memory/app'), kind: 'memory', scope: 'project', projectId: 'app' },
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
  const warnings: unknown[] = [];
  const service = await createKnowledgeService(
    loaded,
    async () => sdk,
    warningCatcher((event, data) => void warnings.push([event, data])),
  );
  t.after(() => service.close());
  await service.index();
  const hits = await service.search({ query: 'Pelican' });
  assert.deepEqual(
    hits.map(h => [h.sourceId, h.kind]).sort(),
    [
      ['adr', 'decision'],
      ['docs', 'doc'],
    ],
    'the ADR is indexed once, as a decision, not also under docs',
  );
  assert.deepEqual(warnings, [
    ['knowledge.missing', { source: 'research', projectId: 'app', path: join(root, 'docs/research') }],
  ]);
  await writeFile(join(root, 'memory/app/facts.md'), '# Facts\n\n- Pelican is the codename.');
  await service.index();
  assert.ok(
    (await service.search({ query: 'Pelican', kinds: ['memory'] })).length === 1,
    'memory dir was created and indexed',
  );
  await service.close();

  // A source that disappears from the config (renamed project, removed source) is dropped by QMD
  // at the next start; its documents are never searched because queries name their collections.
  const fewer = await createKnowledgeService(
    { ...loaded, sources: loaded.sources.filter(s => s.id !== 'adr') },
    async () => sdk,
    getLogger(['aivi']),
  );
  t.after(() => fewer.close());
  assert.deepEqual((await fewer.search({ query: 'Pelican' })).map(h => h.sourceId).sort(), ['docs', 'memory']);
});

test('backend scope violations are rejected; a result that escapes its source is dropped, not served', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-search-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'aivi-search-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'leak.md'), 'leaked');
  await symlink(join(outside, 'leak.md'), join(root, 'leak.md'));
  await writeFile(join(root, 'ok.md'), 'fine');
  const loaded: LoadedConfig = {
    path: '/config',
    config: configSchema.parse({ version: 1, stateDirectory: root, search: { provider: 'qmd' } }),
    projects: [],
    sources: [{ id: 'core', path: root, kind: 'doc', scope: 'core' }],
  };
  let results: { collectionName: string; filepath: string; displayPath: string; title: string; score: number }[] = [];
  let collection = '';
  const warnings: string[] = [];
  const service = await createKnowledgeService(
    loaded,
    async () => ({
      async createStore(options) {
        collection = Object.keys(options.config.collections)[0]!;
        return {
          async update() {},
          async close() {},
          async searchLex() {
            return results;
          },
        };
      },
      extractSnippet() {
        return { snippet: '', line: 1 };
      },
    }),
    warningCatcher(event => void warnings.push(event)),
  );
  t.after(() => service.close());
  results = [
    { collectionName: 'unconfigured', filepath: '/private', displayPath: 'private', title: 'Private', score: 1 },
  ];
  await assert.rejects(service.search({ query: 'secret' }), /out-of-scope/);
  results = [
    { collectionName: collection, filepath: 'leak.md', displayPath: `${collection}/leak.md`, title: 'Leak', score: 2 },
    { collectionName: collection, filepath: 'ok.md', displayPath: `${collection}/ok.md`, title: 'Ok', score: 1 },
  ];
  const hits = await service.search({ query: 'x' });
  assert.deepEqual(
    hits.map(h => h.title),
    ['Ok'],
    'the symlinked file is dropped and the rest of the query is served',
  );
  await service.search({ query: 'x' });
  assert.deepEqual(warnings, ['knowledge.escaped'], 'warned once per path, not per query');
});
