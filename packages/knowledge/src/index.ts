import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { KnowledgeService, KnowledgeSource, LoadedConfig, Logger, SearchHit, SearchRequest } from '@aivi/core';
import { searchSchema, selectSources } from '@aivi/core';
import { createStore, extractSnippet } from '@tobilu/qmd';

// Narrow boundary matches QMD 2.8.3's public SDK. No dependency on its internal database.
export interface QmdStore {
  searchLex(
    query: string,
    options: { limit: number; collection: string[] },
  ): Promise<
    {
      collectionName: string;
      filepath: string;
      displayPath: string;
      title: string;
      score: number;
      body?: string;
    }[]
  >;
  update(): Promise<unknown>;
  close(): Promise<void>;
}
export interface QmdSDK {
  createStore(options: {
    dbPath: string;
    config: { collections: Record<string, { path: string; pattern: string; ignore?: string[] }> };
  }): Promise<QmdStore>;
  extractSnippet(body: string, query: string, maxLen: number): { snippet: string; line: number };
}
const collectionID = (s: KnowledgeSource) =>
  `aivi-${createHash('sha256')
    .update(JSON.stringify([s.scope, s.projectId, s.id, s.path]))
    .digest('hex')
    .slice(0, 24)}`;
export class SearchUnavailable extends Error {}

/** What one collection holds: the configured source, its root on disk, and the
 *  file itself when the source is a single file. */
type CollectionEntry = { source: KnowledgeSource; root: string; file?: string };
type QmdResult = Awaited<ReturnType<QmdStore['searchLex']>>[number];

/** A file belongs to the most specific source that contains it: a directory source ignores
 *  every source nested inside it, so nothing is indexed twice or under two kinds. */
function nestIgnores(sources: Map<string, CollectionEntry>, collections: Record<string, { ignore?: string[] }>): void {
  for (const [id, outer] of sources) {
    if (outer.file) continue;
    const ignore = [...sources.values()]
      .filter(inner => inner !== outer && (inner.file ?? inner.root).startsWith(`${outer.root}${sep}`))
      .map(
        inner =>
          `${relative(outer.root, inner.file ?? inner.root)
            .split(sep)
            .join('/')}${inner.file ? '' : '/**'}`,
      )
      .sort();
    if (ignore.length) collections[id]!.ignore = ignore;
  }
}

/** What the configured sources look like on disk right now, as QMD collections. */
async function surveySources(loaded: LoadedConfig, log?: Logger) {
  const collections: Record<string, { path: string; pattern: string; ignore?: string[] }> = {};
  const sources = new Map<string, CollectionEntry>();
  for (const source of loaded.sources) {
    // Memory directories are aivi's own and appear once dreaming writes; create them so they
    // are indexed from the start. A repository without the conventional directory is normal.
    if (source.kind === 'memory') await mkdir(source.path, { recursive: true });
    const canonical = await realpath(source.path).catch(() => null);
    if (!canonical) {
      log?.warn('knowledge.missing', { source: source.id, projectId: source.projectId, path: source.path });
      continue;
    }
    const directory = (await stat(canonical)).isDirectory();
    const root = directory ? canonical : dirname(canonical);
    const pattern = directory ? '**/*.md' : basename(canonical);
    if (!directory && /[[\]{}*?!(),]/.test(pattern))
      throw new Error('Single-file knowledge source contains glob characters');
    const id = collectionID(source);
    collections[id] = { path: root, pattern };
    sources.set(id, { source, root, ...(!directory ? { file: canonical } : {}) });
  }
  nestIgnores(sources, collections);
  return { collections, sources };
}

/** The hit for one QMD result, or undefined when the file was deleted since the
 *  last index refresh or escaped its source. A symlink that leaves its source is
 *  not served, but it must not take the whole query down. */
async function toHit(
  entry: CollectionEntry,
  result: QmdResult,
  query: string,
  sdk: QmdSDK,
  warned: Set<string>,
  log?: Logger,
): Promise<SearchHit | undefined> {
  const prefix = `${result.collectionName}/`;
  const display = result.displayPath.startsWith(prefix) ? result.displayPath.slice(prefix.length) : result.displayPath;
  let path = result.filepath;
  if (path.startsWith('qmd://')) path = display;
  path = resolve(entry.root, path);
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) return undefined;
  const rel = relative(entry.root, canonical);
  const escaped =
    isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (entry.file && canonical !== entry.file);
  if (escaped) {
    if (!warned.has(canonical)) {
      warned.add(canonical);
      log?.warn('knowledge.escaped', { source: entry.source.id, path: canonical });
    }
    return undefined;
  }
  const snippet = sdk.extractSnippet(result.body ?? '', query, 900);
  return {
    sourceId: entry.source.id,
    kind: entry.source.kind,
    scope: entry.source.scope,
    ...(entry.source.projectId ? { projectId: entry.source.projectId } : {}),
    path: canonical,
    title: result.title,
    excerpt: snippet.snippet,
    line: snippet.line,
    score: result.score,
  };
}

export async function createKnowledgeService(
  loaded: LoadedConfig,
  loader: () => Promise<QmdSDK> = async () => ({ createStore, extractSnippet }),
  log?: Logger,
): Promise<KnowledgeService> {
  const warned = new Set<string>();
  if (!loaded.config.search)
    return {
      async search() {
        throw new SearchUnavailable('Knowledge search is not enabled');
      },
      async index() {
        throw new SearchUnavailable('Knowledge search is not enabled');
      },
      async close() {},
    };
  const sdk = await loader();
  const { collections, sources } = await surveySources(loaded, log);
  const folder = resolve(loaded.config.stateDirectory, 'knowledge');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const store = await sdk.createStore({ dbPath: resolve(folder, 'qmd.sqlite'), config: { collections } });
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new SearchUnavailable('Knowledge service is closing'));
    if (pending >= loaded.config.search!.maxPending)
      return Promise.reject(new SearchUnavailable('Knowledge queue is full'));
    pending++;
    const result = chain.then(operation);
    chain = result
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return result;
  };
  return {
    async search(input: SearchRequest) {
      const request = searchSchema.parse(input);
      const ids = selectSources(loaded, request.projects, request.includeCore, request.kinds)
        .map(collectionID)
        .filter(id => sources.has(id));
      // Never pass an empty filter: QMD interprets it as an unscoped query.
      if (!ids.length) return [];
      return run(async () => {
        const results = await store.searchLex(request.query, { limit: request.limit, collection: ids });
        const hits: SearchHit[] = [];
        for (const result of results) {
          if (!ids.includes(result.collectionName)) throw new Error('QMD returned an out-of-scope collection');
          const hit = await toHit(sources.get(result.collectionName)!, result, request.query, sdk, warned, log);
          if (hit) hits.push(hit);
        }
        return hits;
      });
    },
    index: () => run(() => store.update()),
    async close() {
      closed = true;
      await chain;
      await store.close();
    },
  };
}
