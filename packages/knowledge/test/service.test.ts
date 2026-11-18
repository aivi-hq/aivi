/** The knowledge service as a unit: what it opens QMD with, what a scan and a
 *  search ask of the store, and what it makes of the answers. The QMD SDK is
 *  what the loader answers (a fake with the members the unit touches), the log
 *  is two recorders, and the sources are small trees under a temp directory:
 *  the unit's input is a tree on disk. The real QMD is not loaded here. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { KnowledgeService, KnowledgeSource, LoadedConfig, Logger } from '@aivi/core';
import { configSchema } from '@aivi/core';
import type { ModelRole, QmdSDK, QmdStore } from '../src/index.ts';
import { createKnowledgeService, QMD_BUILTIN_MODELS, SearchUnavailable, warmKnowledge } from '../src/index.ts';

type Lexical = Awaited<ReturnType<QmdStore['searchLex']>>;
type Semantic = Awaited<ReturnType<QmdStore['search']>>;
type Models = { embed?: string; rerank?: string; generate?: string };
type Search = false | { models?: Models };

const project = (id: string, path: string, kind: KnowledgeSource['kind'] = 'doc'): KnowledgeSource => ({
  id,
  path,
  kind,
  scope: 'project',
  projectId: 'app',
});
const core = (id: string, path: string, kind: KnowledgeSource['kind'] = 'doc'): KnowledgeSource => ({
  id,
  path,
  kind,
  scope: 'core',
});

const file = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const refusal = (message: string) => (error: unknown) => {
  assert.ok(error instanceof SearchUnavailable, 'a SearchUnavailable');
  assert.equal(error.message, message);
  return true;
};

/** Sets variables of the process env for one test and puts them back after. */
function env(t: TestContext, values: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const put = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  put(values);
  t.after(() => put(before));
}

/** A temp directory for the sources, the fake QMD (a store that records what it
 *  is asked, and the SDK around it), the log, and the services a test started:
 *  they are closed after the test, once every scan it left open is settled. */
async function world(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aivi-knowledge-unit-')));
  const store = {
    searchLex: t.mock.fn(
      async (_query: string, _options: { limit: number; collection: string[] }): Promise<Lexical> => [],
    ),
    search: t.mock.fn(
      async (_options: { query: string; limit: number; collections: string[] }): Promise<Semantic> => [],
    ),
    embed: t.mock.fn(async () => ({ chunksEmbedded: 0, errors: 0 })),
    update: t.mock.fn(async (): Promise<unknown> => ({ updated: true })),
    close: t.mock.fn(async () => {}),
  };
  const cached = new Set<ModelRole>();
  const sdk = {
    createStore: t.mock.fn(async (_options: Parameters<QmdSDK['createStore']>[0]): Promise<QmdStore> => store),
    extractSnippet: t.mock.fn((body: string, query: string, _length: number, _position?: number) => ({
      snippet: `${query}|${body}`,
    })),
    modelCached: (role: ModelRole) => cached.has(role),
  };
  const loader = t.mock.fn(async (): Promise<QmdSDK> => sdk);
  const info = t.mock.fn((_message: string, _fields?: unknown) => {});
  const warn = t.mock.fn((_message: string, _fields?: unknown) => {});
  const log = { info, warn } as unknown as Logger;

  const services: KnowledgeService[] = [];
  const pending: PromiseWithResolvers<unknown>[] = [];
  t.after(async () => {
    for (const scan of pending) scan.resolve(undefined);
    await Promise.all(services.map(service => service.close()));
    await rm(root, { recursive: true, force: true });
  });

  const loaded = (sources: KnowledgeSource[], search: Search = {}): LoadedConfig => ({
    path: join(root, 'config.json'),
    config: configSchema.parse({
      version: 1,
      stateDirectory: join(root, 'state'),
      search: search === false ? false : { provider: 'qmd', ...search },
    }),
    projects: [],
    sources,
  });
  const collections = (call = 0) => sdk.createStore.mock.calls[call]!.arguments[0].config.collections;
  return {
    root,
    store,
    sdk,
    loader,
    cached,
    info,
    warn,
    log,
    loaded,
    collections,
    start: async (sources: KnowledgeSource[] = [], search?: Search) => {
      const service = await createKnowledgeService(loaded(sources, search), loader, log);
      services.push(service);
      return service;
    },
    /** The id QMD was given for the collection at `path`. */
    idOf: (path: string) => Object.entries(collections()).find(([, collection]) => collection.path === path)![0],
    /** Each call of `update` answers when the test says so; `pending[n]` is the nth call. */
    manual: () => {
      store.update.mock.mockImplementation(() => {
        const scan = Promise.withResolvers<unknown>();
        pending.push(scan);
        return scan.promise;
      });
      return pending;
    },
    /** An SDK that has no probe of its own: the unit looks in QMD's model cache. */
    withoutProbe: () => {
      const { modelCached: _own, ...bare } = sdk;
      loader.mock.mockImplementation(async () => bare);
    },
  };
}

test('with search disabled the service refuses to search and to index, loads nothing, and has nothing to close', async t => {
  const w = await world(t);
  const service = await w.start([], false);

  await assert.rejects(service.search({ query: 'a' }), refusal('Knowledge search is disabled in the config'));
  await assert.rejects(service.index(), refusal('Knowledge search is disabled in the config'));
  await service.close();
  assert.equal(w.loader.mock.callCount(), 0);
});

test('the store is opened under the state directory with the sources as its collections', async t => {
  const w = await world(t);
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  await w.start([project('docs', join(w.root, 'docs'))]);

  const [options] = w.sdk.createStore.mock.calls[0]!.arguments;
  assert.equal(options.dbPath, join(w.root, 'state', 'knowledge', 'qmd.sqlite'));
  assert.deepEqual(options.config, {
    collections: { [w.idOf(join(w.root, 'docs'))]: { path: join(w.root, 'docs'), pattern: '**/*.md' } },
  });
  assert.equal((await stat(join(w.root, 'state', 'knowledge'))).mode & 0o777, 0o700, 'private to its owner');
});

test('only the models the config names go to QMD; a role left out is QMD’s to resolve', async t => {
  const w = await world(t);
  await w.start([], { models: { embed: 'hf:acme/embed.gguf', rerank: '' } });

  assert.deepEqual(w.sdk.createStore.mock.calls[0]!.arguments[0].config.models, { embed: 'hf:acme/embed.gguf' });
});

test('a memory directory is made, so that it is indexed from the start', async t => {
  const w = await world(t);
  const memory = join(w.root, 'memory', 'app');
  await w.start([project('memory', memory, 'memory')]);

  assert.equal((await stat(memory)).isDirectory(), true);
  assert.deepEqual(Object.values(w.collections()), [{ path: memory, pattern: '**/*.md' }]);
});

test('an archive is touched into being, and keeps what it already holds', async t => {
  const w = await world(t);
  const archive = join(w.root, 'memory', 'app', 'archive.md');
  const source = project('archive', archive, 'archive');

  await w.start([source]);
  assert.equal(await readFile(archive, 'utf8'), '');
  assert.deepEqual(Object.values(w.collections()), [{ path: dirname(archive), pattern: 'archive.md' }]);

  await writeFile(archive, '# Archive\n- a retired fact\n');
  await w.start([source]);
  assert.equal(await readFile(archive, 'utf8'), '# Archive\n- a retired fact\n');
});

test('a source that is not on disk is said and left out', async t => {
  const w = await world(t);
  const research = join(w.root, 'research');
  const handbook = join(w.root, 'handbook');
  await w.start([project('research', research), core('handbook', handbook)]);

  assert.deepEqual(
    w.warn.mock.calls.map(call => call.arguments),
    [
      ['knowledge.missing', { source: 'research', projectId: 'app', path: research }],
      ['knowledge.missing', { source: 'handbook', projectId: undefined, path: handbook }],
    ],
  );
  assert.deepEqual(w.collections(), {});
});

test('a single file is a collection of its folder, matched by its own name', async t => {
  const w = await world(t);
  const agents = join(w.root, 'notes', 'AGENTS.md');
  await file(agents, '# Agents');
  await w.start([core('agents', agents)]);

  assert.deepEqual(Object.values(w.collections()), [{ path: join(w.root, 'notes'), pattern: 'AGENTS.md' }]);
});

for (const name of ['a[1].md', 'a*.md', 'a,b.md']) {
  test(`a single file whose name holds a glob character (${name}) is refused, not matched as a pattern`, async t => {
    const w = await world(t);
    const odd = join(w.root, 'notes', name);
    await file(odd, '# Odd');

    await assert.rejects(
      w.start([core('odd', odd)]),
      new Error('Single-file knowledge source contains glob characters'),
    );
  });
}

test('a source behind a link is indexed where it really is', async t => {
  const w = await world(t);
  await file(join(w.root, 'real', 'docs', 'guide.md'), '# Guide');
  await symlink(join(w.root, 'real', 'docs'), join(w.root, 'docs'));
  await w.start([project('docs', join(w.root, 'docs'))]);

  assert.deepEqual(Object.values(w.collections()), [{ path: join(w.root, 'real', 'docs'), pattern: '**/*.md' }]);
});

test('a directory source ignores every source inside it, so nothing is indexed twice or under two kinds', async t => {
  const w = await world(t);
  const docs = join(w.root, 'docs');
  await file(join(docs, 'guide.md'), '# Guide');
  await file(join(docs, 'adr', '0001.md'), '# ADR');
  await file(join(docs, 'NOTES.md'), '# Notes');
  await file(join(w.root, 'docs-old', 'old.md'), '# Old');
  await w.start([
    project('docs', docs),
    project('adr', join(docs, 'adr'), 'decision'),
    project('notes', join(docs, 'NOTES.md')),
    project('old', join(w.root, 'docs-old')),
  ]);

  assert.deepEqual(Object.values(w.collections()), [
    { path: docs, pattern: '**/*.md', ignore: ['NOTES.md', 'adr/**'] },
    { path: join(docs, 'adr'), pattern: '**/*.md' },
    { path: docs, pattern: 'NOTES.md' },
    { path: join(w.root, 'docs-old'), pattern: '**/*.md' },
  ]);
});

test('a scan updates the index and embeds when the embed model is on disk, and says how many chunks were embedded', async t => {
  const w = await world(t);
  w.cached.add('embed');
  w.store.embed.mock.mockImplementation(async () => ({ chunksEmbedded: 3, errors: 0 }));
  const service = await w.start();

  assert.deepEqual(await service.index(), { updated: true });
  assert.equal(w.store.embed.mock.callCount(), 1);
  assert.deepEqual(
    w.info.mock.calls.map(call => call.arguments),
    [['knowledge.embedded', { chunks: 3 }]],
  );

  w.store.embed.mock.mockImplementation(async () => ({ chunksEmbedded: 0, errors: 0 }));
  await service.index();
  assert.equal(w.info.mock.callCount(), 1, 'a scan that embedded nothing says nothing');
});

test('a scan never waits for a model download: without the embed model it embeds nothing, and says once that search is keyword-only', async t => {
  const w = await world(t);
  const service = await w.start();

  await service.index();
  await service.index();

  assert.equal(w.store.update.mock.callCount(), 2);
  assert.equal(w.store.embed.mock.callCount(), 0);
  assert.deepEqual(
    w.info.mock.calls.map(call => call.arguments),
    [['knowledge.semantic.off', { hint: '`aivi knowledge warm` fetches the local models for semantic search' }]],
  );
});

test('a scan asked for during a scan is that scan, and one more follows it', async t => {
  const w = await world(t);
  const service = await w.start();
  const pending = w.manual();

  const first = service.index();
  const second = service.index();
  assert.equal(second, first, 'the late caller joins the running scan');
  assert.equal(pending.length, 1);

  pending[0]!.resolve('first');
  assert.equal(await first, 'first');
  assert.equal(pending.length, 2, 'the follow-up scan started as the first ended');

  pending[1]!.resolve('second');
  await service.close();
  assert.equal(w.store.update.mock.callCount(), 2);
});

test('a scan that fails rejects the callers that joined it, its follow-up fails unseen, and the next scan starts afresh', async t => {
  const w = await world(t);
  const service = await w.start();
  const pending = w.manual();

  const first = service.index();
  const second = service.index();
  pending[0]!.reject(new Error('disk full'));
  await assert.rejects(first, new Error('disk full'));
  await assert.rejects(second, new Error('disk full'));
  assert.equal(pending.length, 2);

  pending[1]!.reject(new Error('still full'));
  await new Promise(resolve => setImmediate(resolve));

  const third = service.index();
  assert.equal(pending.length, 3);
  pending[2]!.resolve('third');
  assert.equal(await third, 'third');
});

test('closing during a scan waits for it, starts no follow-up, and only then closes the store', async t => {
  const w = await world(t);
  const service = await w.start();
  const pending = w.manual();
  const scan = service.index();
  const joined = service.index();

  const closing = service.close();
  assert.equal(w.store.close.mock.callCount(), 0, 'the store stays open while the scan runs');
  pending[0]!.resolve('done');
  await closing;

  assert.deepEqual([await scan, await joined], ['done', 'done']);
  assert.equal(pending.length, 1, 'no follow-up scan after close');
  assert.equal(w.store.close.mock.callCount(), 1);
});

test('a closed service refuses to scan and to search', async t => {
  const w = await world(t);
  const service = await w.start();
  await service.close();

  await assert.rejects(service.index(), refusal('Knowledge service is closing'));
  await assert.rejects(service.search({ query: 'a' }), refusal('Knowledge service is closing'));
});

test('a keyword answer becomes hits: the source it came from, the file as it really is, and the excerpt QMD cuts', async t => {
  const w = await world(t);
  const docs = join(w.root, 'docs');
  await file(join(docs, 'guide.md'), '# Guide');
  await file(join(docs, 'extra.md'), '# Extra');
  const service = await w.start([project('docs', docs)]);
  const id = w.idOf(docs);
  w.store.searchLex.mock.mockImplementation(async () => [
    {
      collectionName: id,
      filepath: `qmd://${id}/guide.md`,
      displayPath: `${id}/guide.md`,
      title: 'Guide',
      score: 0.9,
      body: 'guide body',
    },
    { collectionName: id, filepath: 'extra.md', displayPath: 'extra.md', title: 'Extra', score: 0.5 },
    { collectionName: id, filepath: 'gone.md', displayPath: `${id}/gone.md`, title: 'Gone', score: 0.4, body: 'x' },
  ]);

  const hits = await service.search({ query: 'orchard', limit: 3 });

  assert.deepEqual(hits, [
    {
      sourceId: 'docs',
      kind: 'doc',
      scope: 'project',
      projectId: 'app',
      path: join(docs, 'guide.md'),
      title: 'Guide',
      excerpt: 'orchard|guide body',
      score: 0.9,
    },
    {
      sourceId: 'docs',
      kind: 'doc',
      scope: 'project',
      projectId: 'app',
      path: join(docs, 'extra.md'),
      title: 'Extra',
      excerpt: 'orchard|',
      score: 0.5,
    },
  ]);
  assert.deepEqual(w.store.searchLex.mock.calls[0]!.arguments, ['orchard', { limit: 3, collection: [id] }]);
  assert.deepEqual(
    w.sdk.extractSnippet.mock.calls.map(call => call.arguments),
    [
      ['guide body', 'orchard', 900, undefined],
      ['', 'orchard', 900, undefined],
    ],
    'a file deleted since the last scan is dropped before QMD cuts its excerpt',
  );
});

test('a core source’s hit names no project', async t => {
  const w = await world(t);
  const handbook = join(w.root, 'handbook');
  await file(join(handbook, 'process.md'), '# Process');
  const service = await w.start([core('handbook', handbook)]);
  const id = w.idOf(handbook);
  w.store.searchLex.mock.mockImplementation(async () => [
    {
      collectionName: id,
      filepath: 'process.md',
      displayPath: `${id}/process.md`,
      title: 'Process',
      score: 1,
      body: 'b',
    },
  ]);

  assert.deepEqual(await service.search({ query: 'q' }), [
    {
      sourceId: 'handbook',
      kind: 'doc',
      scope: 'core',
      path: join(handbook, 'process.md'),
      title: 'Process',
      excerpt: 'q|b',
      score: 1,
    },
  ]);
});

test('a single-file source serves its own file only: a sibling in its folder is dropped, and said once', async t => {
  const w = await world(t);
  const agents = join(w.root, 'notes', 'AGENTS.md');
  await file(agents, '# Agents');
  await file(join(w.root, 'notes', 'other.md'), '# Other');
  const service = await w.start([core('agents', agents)]);
  const id = w.idOf(join(w.root, 'notes'));
  w.store.searchLex.mock.mockImplementation(async () => [
    { collectionName: id, filepath: 'other.md', displayPath: `${id}/other.md`, title: 'Other', score: 2, body: 'o' },
    { collectionName: id, filepath: 'AGENTS.md', displayPath: `${id}/AGENTS.md`, title: 'Agents', score: 1, body: 'a' },
  ]);

  const hits = await service.search({ query: 'q' });
  await service.search({ query: 'q' });

  assert.deepEqual(
    hits.map(hit => hit.path),
    [agents],
  );
  assert.deepEqual(
    w.warn.mock.calls.map(call => call.arguments),
    [['knowledge.escaped', { source: 'agents', path: join(w.root, 'notes', 'other.md') }]],
  );
});

test('a result that leaves its source, by a path or by a link, is dropped and said once per file, and the query is served', async t => {
  const w = await world(t);
  const docs = join(w.root, 'docs');
  const leak = join(w.root, 'outside', 'leak.md');
  await file(join(docs, 'ok.md'), '# Ok');
  await file(leak, 'leaked');
  await symlink(leak, join(docs, 'link.md'));
  const service = await w.start([project('docs', docs)]);
  const id = w.idOf(docs);
  const result = (filepath: string, title: string) => ({
    collectionName: id,
    filepath,
    displayPath: `${id}/${filepath}`,
    title,
    score: 1,
    body: 'b',
  });
  w.store.searchLex.mock.mockImplementation(async () => [
    result('../outside/leak.md', 'By path'),
    result('link.md', 'By link'),
    result('ok.md', 'Ok'),
  ]);

  const hits = await service.search({ query: 'q' });

  assert.deepEqual(
    hits.map(hit => hit.title),
    ['Ok'],
  );
  assert.deepEqual(
    w.warn.mock.calls.map(call => call.arguments),
    [['knowledge.escaped', { source: 'docs', path: leak }]],
  );
});

const everything = ['embed', 'rerank', 'generate'] as const;

test('a selection that holds no source on disk answers nothing and never asks QMD, whose empty filter would mean everything', async t => {
  const w = await world(t);
  const docs = join(w.root, 'docs');
  await file(join(docs, 'guide.md'), '# Guide');
  const service = await w.start([project('docs', docs), project('gone', join(w.root, 'gone'))]);

  assert.deepEqual(await service.search({ query: 'q', projects: [], includeCore: false }), []);
  assert.equal(w.store.searchLex.mock.callCount() + w.store.search.mock.callCount(), 0);

  const asked = await service.search({ query: 'q' });
  assert.deepEqual(asked, []);
  assert.deepEqual(
    w.store.searchLex.mock.calls.map(call => call.arguments[1].collection),
    [[w.idOf(docs)]],
    'the source that is not on disk is not asked about',
  );
});

test('a keyword result from a collection that was not asked about is refused, never served', async t => {
  const w = await world(t);
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))]);
  w.store.searchLex.mock.mockImplementation(async () => [
    { collectionName: 'aivi-elsewhere', filepath: '/private', displayPath: 'private', title: 'Private', score: 1 },
  ]);

  await assert.rejects(service.search({ query: 'q' }), new Error('QMD returned an out-of-scope collection'));
});

test('with all three models on disk the full pipeline answers, and its excerpts are cut from the whole document at the matched chunk', async t => {
  const w = await world(t);
  for (const role of everything) w.cached.add(role);
  const docs = join(w.root, 'docs');
  await file(join(docs, 'guide.md'), '# Guide');
  await file(join(docs, 'short.md'), '# Short');
  const service = await w.start([project('docs', docs)]);
  const id = w.idOf(docs);
  w.store.search.mock.mockImplementation(async () => [
    {
      file: `qmd://${id}/guide.md`,
      displayPath: `${id}/guide.md`,
      title: 'Guide',
      body: 'whole guide',
      bestChunk: 'the chunk',
      bestChunkPos: 42,
      score: 0.8,
    },
    {
      file: `qmd://${id}/short.md`,
      displayPath: `${id}/short.md`,
      title: 'Short',
      body: '',
      bestChunk: 'only chunk',
      bestChunkPos: 0,
      score: 0.7,
    },
    {
      file: `qmd://${id}/gone.md`,
      displayPath: `${id}/gone.md`,
      title: 'Gone',
      body: 'b',
      bestChunk: 'c',
      bestChunkPos: 1,
      score: 0.6,
    },
  ]);

  const hits = await service.search({ query: 'orchard', limit: 5 });

  assert.deepEqual(w.store.search.mock.calls[0]!.arguments, [{ query: 'orchard', limit: 5, collections: [id] }]);
  assert.equal(w.store.searchLex.mock.callCount(), 0, 'keyword search is not asked');
  assert.deepEqual(
    hits.map(hit => [hit.path, hit.title, hit.excerpt, hit.score]),
    [
      [join(docs, 'guide.md'), 'Guide', 'orchard|whole guide', 0.8],
      [join(docs, 'short.md'), 'Short', 'orchard|only chunk', 0.7],
    ],
  );
  assert.deepEqual(
    w.sdk.extractSnippet.mock.calls.map(call => call.arguments),
    [
      ['whole guide', 'orchard', 900, 42],
      ['only chunk', 'orchard', 900, 0],
    ],
    'the whole body when there is one, else the chunk, and the chunk’s offset either way',
  );
});

test('a full pipeline that answers nothing is the answer: keyword search is not asked after it', async t => {
  const w = await world(t);
  for (const role of everything) w.cached.add(role);
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))]);

  assert.deepEqual(await service.search({ query: 'q' }), []);
  assert.equal(w.store.searchLex.mock.callCount(), 0);
});

test('a full pipeline that fails is answered by keyword search, and the failure is said once', async t => {
  const w = await world(t);
  for (const role of everything) w.cached.add(role);
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))]);
  const failure = new Error('model crashed');
  w.store.search.mock.mockImplementation(async () => {
    throw failure;
  });

  await service.search({ query: 'q' });
  await service.search({ query: 'q' });

  assert.equal(w.store.searchLex.mock.callCount(), 2);
  assert.deepEqual(
    w.warn.mock.calls.map(call => call.arguments),
    [['knowledge.semantic.failed', { error: failure, hint: 'answering with keyword search' }]],
  );
});

for (const named of ['qmd://aivi-elsewhere/x.md', 'x.md']) {
  test(`a full-pipeline hit outside the asked collections is refused (${named})`, async t => {
    const w = await world(t);
    for (const role of everything) w.cached.add(role);
    await file(join(w.root, 'docs', 'guide.md'), '# Guide');
    const service = await w.start([project('docs', join(w.root, 'docs'))]);
    w.store.search.mock.mockImplementation(async () => [
      { file: named, displayPath: 'x.md', title: 'X', body: 'b', bestChunk: 'c', bestChunkPos: 0, score: 1 },
    ]);

    await assert.rejects(service.search({ query: 'q' }), new Error('QMD returned an out-of-scope collection'));
  });
}

test('the full pipeline needs all three models: with two on disk, keyword search answers', async t => {
  const w = await world(t);
  w.cached.add('embed');
  w.cached.add('rerank');
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))]);

  await service.search({ query: 'q' });

  assert.equal(w.store.search.mock.callCount(), 0);
  assert.equal(w.store.searchLex.mock.callCount(), 1);
});

/** QMD's model cache as a list of file names (or the error of reading it), for
 *  the probe that an SDK does not bring. `readdirSync` is imported by name, so
 *  the named export is synced after the mock and after its restore. */
function cache(t: TestContext, names: string[] | Error) {
  const listing = t.mock.method(fs, 'readdirSync', () => {
    if (names instanceof Error) throw names;
    return names;
  });
  syncBuiltinESMExports();
  t.after(() => {
    listing.mock.restore();
    syncBuiltinESMExports();
  });
  return listing;
}

const noOverrides = { QMD_EMBED_MODEL: undefined, QMD_RERANK_MODEL: undefined, QMD_GENERATE_MODEL: undefined };

test('without a probe of its own, an SDK’s models are looked for in QMD’s model cache, by the last segment of their URIs', async t => {
  env(t, { XDG_CACHE_HOME: '/cache', ...noOverrides });
  const listing = cache(t, [
    'hf_ggml-org_embeddinggemma-300M-Q8_0.gguf',
    'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf',
    'qmd-query-expansion-1.7B-q4_k_m.gguf',
  ]);
  const w = await world(t);
  w.withoutProbe();
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))]);

  await service.search({ query: 'q' });

  assert.equal(w.store.search.mock.callCount(), 1, 'all three are home, so the full pipeline answers');
  assert.deepEqual(
    listing.mock.calls.map(call => call.arguments),
    [[join('/cache', 'qmd', 'models')], [join('/cache', 'qmd', 'models')], [join('/cache', 'qmd', 'models')]],
  );
});

test('a model is looked for by the URI the config names, then the one the environment names, then QMD’s own', async t => {
  env(t, {
    XDG_CACHE_HOME: '/cache',
    QMD_EMBED_MODEL: 'hf:env/ignored-embed.gguf',
    QMD_RERANK_MODEL: 'hf:env/env-rerank.gguf',
    QMD_GENERATE_MODEL: undefined,
  });
  const listing = cache(t, ['custom-embed.gguf', 'env-rerank.gguf', 'qmd-query-expansion-1.7B-q4_k_m.gguf']);
  const w = await world(t);
  w.withoutProbe();
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))], {
    models: { embed: 'hf:acme/custom-embed.gguf' },
  });

  await service.search({ query: 'q' });
  assert.equal(w.store.search.mock.callCount(), 1);

  listing.mock.mockImplementation(() => ['custom-embed.gguf', 'qmd-query-expansion-1.7B-q4_k_m.gguf']);
  await service.search({ query: 'q' });
  assert.equal(w.store.search.mock.callCount(), 1, 'the model the environment names is gone: not all three are home');
  assert.equal(w.store.searchLex.mock.callCount(), 1);
});

test('with no XDG cache the model cache is under the home directory, and one that cannot be read holds no model', async t => {
  env(t, { XDG_CACHE_HOME: undefined, ...noOverrides });
  const listing = cache(t, new Error('ENOENT: no such file or directory'));
  const w = await world(t);
  w.withoutProbe();
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))]);

  await service.search({ query: 'q' });

  assert.deepEqual(
    listing.mock.calls.map(call => call.arguments),
    [[join(homedir(), '.cache', 'qmd', 'models')]],
  );
  assert.equal(w.store.searchLex.mock.callCount(), 1);
});

test('a model URI that ends in a slash names no file, so no cache can hold it', async t => {
  env(t, { XDG_CACHE_HOME: '/cache', ...noOverrides });
  const listing = cache(t, ['anything.gguf']);
  const w = await world(t);
  w.withoutProbe();
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  const service = await w.start([project('docs', join(w.root, 'docs'))], { models: { embed: 'hf:acme/repo/' } });

  await service.search({ query: 'q' });

  assert.equal(listing.mock.callCount(), 0, 'nothing to look for');
  assert.equal(w.store.searchLex.mock.callCount(), 1);
});

test('warming refuses when search is disabled, and when no source exists yet', async t => {
  const w = await world(t);

  await assert.rejects(
    warmKnowledge(w.loaded([], false), w.loader, w.log),
    refusal('Knowledge search is disabled in the config'),
  );
  await assert.rejects(
    warmKnowledge(w.loaded([]), w.loader, w.log),
    refusal('No knowledge source exists yet to warm against'),
  );
  assert.equal(w.sdk.createStore.mock.callCount(), 0);
});

test('warming updates the index, embeds, runs one scoped query so the other two models load, and closes the store', async t => {
  env(t, { QMD_EMBED_MODEL: undefined, QMD_RERANK_MODEL: 'hf:env/rerank.gguf', QMD_GENERATE_MODEL: undefined });
  const w = await world(t);
  const docs = join(w.root, 'docs');
  await file(join(docs, 'guide.md'), '# Guide');
  const order: string[] = [];
  w.store.update.mock.mockImplementation(async () => {
    order.push('update');
  });
  w.store.embed.mock.mockImplementation(async () => {
    order.push('embed');
    return { chunksEmbedded: 7, errors: 0 };
  });
  w.store.search.mock.mockImplementation(async () => {
    order.push('search');
    return [];
  });
  w.store.close.mock.mockImplementation(async () => {
    order.push('close');
  });

  const warmed = await warmKnowledge(
    w.loaded([project('docs', docs)], { models: { embed: 'hf:acme/embed.gguf' } }),
    w.loader,
    w.log,
  );

  const id = w.idOf(docs);
  assert.deepEqual(warmed, {
    models: { embed: 'hf:acme/embed.gguf', rerank: 'hf:env/rerank.gguf', generate: QMD_BUILTIN_MODELS.generate },
    embedded: 7,
  });
  assert.deepEqual(order, ['update', 'embed', 'search', 'close']);
  assert.deepEqual(w.sdk.createStore.mock.calls[0]!.arguments[0], {
    dbPath: join(w.root, 'state', 'knowledge', 'qmd.sqlite'),
    config: { collections: { [id]: { path: docs, pattern: '**/*.md' } }, models: { embed: 'hf:acme/embed.gguf' } },
  });
  assert.deepEqual(w.store.search.mock.calls[0]!.arguments, [{ query: 'aivi', limit: 1, collections: [id] }]);
});

test('warming closes the store even when a step fails, and the failure stands', async t => {
  const w = await world(t);
  await file(join(w.root, 'docs', 'guide.md'), '# Guide');
  w.store.embed.mock.mockImplementation(async () => {
    throw new Error('download failed');
  });

  await assert.rejects(
    warmKnowledge(w.loaded([project('docs', join(w.root, 'docs'))]), w.loader, w.log),
    new Error('download failed'),
  );

  assert.equal(w.store.close.mock.callCount(), 1);
  assert.equal(w.store.search.mock.callCount(), 0);
});
