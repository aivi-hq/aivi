/** Which SDK the knowledge service talks to when it is not handed one: QMD's
 *  own `createStore` and `extractSnippet`. `@tobilu/qmd` is a module mock,
 *  registered before the service is imported, so the real QMD is not loaded. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { configSchema } from '@aivi/core';

const store = {
  searchLex: mock.fn(
    async (
      _query: string,
      _options: { limit: number; collection: string[] },
    ): Promise<
      { collectionName: string; filepath: string; displayPath: string; title: string; score: number; body?: string }[]
    > => [],
  ),
  search: mock.fn(async () => []),
  embed: mock.fn(async () => ({ chunksEmbedded: 4, errors: 0 })),
  update: mock.fn(async () => ({})),
  close: mock.fn(async () => {}),
};
const qmd = {
  createStore: mock.fn(async (_options: { dbPath: string; config: { collections: Record<string, unknown> } }) => store),
  extractSnippet: mock.fn((body: string, query: string) => ({ snippet: `${query}|${body}`, line: 1 })),
};
mock.module('@tobilu/qmd', { exports: { createStore: qmd.createStore, extractSnippet: qmd.extractSnippet } });

const { createKnowledgeService, warmKnowledge } = await import('../src/index.ts');

/** A home with one document source, and a model cache that holds nothing. */
async function home(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aivi-knowledge-default-')));
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  t.after(async () => {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
    await rm(root, { recursive: true, force: true });
  });
  const docs = join(root, 'docs');
  await mkdir(docs);
  await writeFile(join(docs, 'guide.md'), '# Guide');
  for (const fn of [qmd.createStore, qmd.extractSnippet, ...Object.values(store)]) fn.mock.resetCalls();
  return {
    root,
    docs,
    loaded: {
      path: join(root, 'config.json'),
      config: configSchema.parse({ version: 1, stateDirectory: join(root, 'state'), search: { provider: 'qmd' } }),
      projects: [],
      sources: [{ id: 'docs', path: docs, kind: 'doc' as const, scope: 'core' as const }],
    },
  };
}

test('with no loader the service opens QMD’s own store and cuts excerpts with QMD’s own snippet', async t => {
  const h = await home(t);
  const service = await createKnowledgeService(h.loaded);
  t.after(() => service.close());
  const [options] = qmd.createStore.mock.calls[0]!.arguments;
  const [id] = Object.keys(options.config.collections);
  store.searchLex.mock.mockImplementationOnce(async () => [
    {
      collectionName: id!,
      filepath: 'guide.md',
      displayPath: `${id}/guide.md`,
      title: 'Guide',
      score: 1,
      body: 'body',
    },
  ]);

  const hits = await service.search({ query: 'q' });

  assert.equal(options.dbPath, join(h.root, 'state', 'knowledge', 'qmd.sqlite'));
  assert.deepEqual(
    hits.map(hit => [hit.path, hit.excerpt]),
    [[join(h.docs, 'guide.md'), 'q|body']],
  );
});

test('with no loader, warming opens QMD’s own store too', async t => {
  const h = await home(t);

  const warmed = await warmKnowledge(h.loaded);

  assert.equal(qmd.createStore.mock.callCount(), 1);
  assert.equal(warmed.embedded, 4);
  assert.equal(store.close.mock.callCount(), 1);
});
