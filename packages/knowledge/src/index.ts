import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  /** Full pipeline: expansion + multi-signal retrieval + reranking. `file` is the
   *  same `qmd://<collection>/<path>` virtual path searchLex answers with. */
  search(options: { query: string; limit: number; collections: string[] }): Promise<
    {
      file: string;
      displayPath: string;
      title: string;
      body: string;
      bestChunk: string;
      bestChunkPos: number;
      score: number;
    }[]
  >;
  /** Embeds documents that lack vectors; downloads the embed model when absent. */
  embed(options?: { force?: boolean }): Promise<{ chunksEmbedded: number; errors: number }>;
  update(): Promise<unknown>;
  close(): Promise<void>;
}
/** `search.models` in the config, in its exact zod shape (`exactOptionalPropertyTypes`). */
type SearchModels = { embed?: string | undefined; rerank?: string | undefined; generate?: string | undefined };
export interface QmdSDK {
  createStore(options: {
    dbPath: string;
    config: {
      collections: Record<string, { path: string; pattern: string; ignore?: string[] }>;
      // QMD's own ModelsConfig shape: named URIs only, never explicit undefined.
      models?: { embed?: string; rerank?: string; generate?: string };
    };
  }): Promise<QmdStore>;
  extractSnippet(body: string, query: string, maxLen: number): { snippet: string; line: number };
  /** Is this role's model on disk? Absent (a bare QMD module) means the built-in
   *  probe of QMD's documented model cache directory; tests name their own answer
   *  so search paths never depend on the machine running them. */
  modelCached?(role: ModelRole, models?: SearchModels): boolean;
}
const defaultSDK: QmdSDK = { createStore, extractSnippet, modelCached };
const collectionID = (s: KnowledgeSource) =>
  `aivi-${createHash('sha256')
    .update(JSON.stringify([s.scope, s.projectId, s.id, s.path]))
    .digest('hex')
    .slice(0, 24)}`;
export class SearchUnavailable extends Error {}

/** QMD 2.8.3's built-in model URIs. The runtime never imports them as law —
 *  qmd resolves its own defaults when the config names none — they exist here
 *  only to locate a model's cache file for the availability probe. */
const QMD_BUILTIN_MODELS = {
  embed: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',
  rerank: 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',
  generate: 'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf',
} as const;
const MODEL_ENV = { embed: 'QMD_EMBED_MODEL', rerank: 'QMD_RERANK_MODEL', generate: 'QMD_GENERATE_MODEL' } as const;
type ModelRole = keyof typeof QMD_BUILTIN_MODELS;

/** QMD's own resolution order: config URI, then its env override, then its default. */
function resolveModel(role: ModelRole, models: SearchModels | undefined): string {
  return models?.[role] || process.env[MODEL_ENV[role]] || QMD_BUILTIN_MODELS[role];
}
/** Where QMD caches model files (its documented cache directory). */
function modelCacheDir(): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'qmd', 'models');
}
/** QMD's own cache rule: node-llama-cpp names downloads its own way (it may
 *  prefix the repo), so a model is on disk when any cached file contains the
 *  URI's last segment. */
function modelCached(role: ModelRole, models?: SearchModels): boolean {
  const file = resolveModel(role, models).split('/').pop();
  if (!file) return false;
  try {
    return readdirSync(modelCacheDir()).some(name => name.includes(file));
  } catch {
    return false;
  }
}

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
    // Archives are aivi's own too: touch the file so the source exists from the
    // start; dreaming fills it as facts retire.
    if (source.kind === 'archive') {
      await mkdir(dirname(source.path), { recursive: true });
      await writeFile(source.path, '', { flag: 'a' });
    }
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
 *  not served, but it must not take the whole query down.
 *  `fullBody` marks a semantic hit: the excerpt is the reranker's chunk (already
 *  in `result.body`) and its line comes from the whole document. */
async function toHit(
  entry: CollectionEntry,
  result: QmdResult,
  query: string,
  sdk: QmdSDK,
  warned: Set<string>,
  log?: Logger,
  fullBody?: string,
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
  const snippet =
    fullBody === undefined
      ? sdk.extractSnippet(result.body ?? '', query, 900)
      : {
          snippet: (result.body ?? '').slice(0, 900),
          line: Math.max(1, fullBody.slice(0, Math.max(0, fullBody.indexOf(result.body ?? ''))).split('\n').length),
        };
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

/** Only named URIs ride to QMD; a role absent is left for QMD to resolve. */
function namedModels(models: SearchModels | undefined) {
  const entries = Object.entries(models ?? {}).filter(([, uri]) => !!uri) as [ModelRole, string][];
  return entries.length ? { models: Object.fromEntries(entries) } : {};
}

export async function createKnowledgeService(
  loaded: LoadedConfig,
  loader: () => Promise<QmdSDK> = async () => defaultSDK,
  log?: Logger,
): Promise<KnowledgeService> {
  const warned = new Set<string>();
  if (loaded.config.search === false)
    return {
      async search() {
        throw new SearchUnavailable('Knowledge search is disabled in the config');
      },
      async index() {
        throw new SearchUnavailable('Knowledge search is disabled in the config');
      },
      async close() {},
    };
  const sdk = await loader();
  const { collections, sources } = await surveySources(loaded, log);
  const models = loaded.config.search.models;
  const probe = (role: ModelRole) => (sdk.modelCached ?? modelCached)(role, models);
  const folder = resolve(loaded.config.stateDirectory, 'knowledge');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const store = await sdk.createStore({
    dbPath: resolve(folder, 'qmd.sqlite'),
    config: { collections, ...namedModels(models) },
  });
  let closed = false;
  // Searches never wait: QMD reads are synchronous SQLite on a WAL database,
  // which the database itself serializes at millisecond granularity — an
  // aivi-side queue could only add delay. Indexing owns its own lock (the
  // sync refuses to overlap, not the scheduler): one scan runs, and a caller
  // arriving mid-scan only indicates another sync is wanted — the re-scan
  // runs detached afterwards, so files written mid-scan still land while the
  // late caller is already on its way.
  let again = false;
  let scanning: Promise<unknown> | null = null;
  const startScan = (): Promise<unknown> => {
    const scan: Promise<unknown> = (async () => {
      try {
        const updated = await store.update();
        // Embedding rides the scan only when the model already sits on disk: a boot
        // or a mid-scan re-sync never waits on a download. `aivi knowledge warm`
        // brings the models; until then the corpus is keyword-only, by design.
        if (probe('embed')) {
          const embedded = await store.embed();
          if (embedded.chunksEmbedded) log?.info('knowledge.embedded', { chunks: embedded.chunksEmbedded });
        } else if (!warned.has('embed')) {
          warned.add('embed');
          log?.info('knowledge.semantic.off', {
            hint: '`aivi knowledge warm` fetches the local models for semantic search',
          });
        }
        return updated;
      } finally {
        scanning = null;
        if (again && !closed) {
          again = false;
          startScan().catch(() => {}); // the wanted-again re-scan: nobody awaits it
        }
      }
    })();
    scanning = scan;
    return scan;
  };
  const index = (): Promise<unknown> => {
    if (closed) return Promise.reject(new SearchUnavailable('Knowledge service is closing'));
    if (scanning) {
      again = true;
      return scanning; // resolves when the running scan ends; the follow-up is detached
    }
    return startScan();
  };
  return {
    async search(input: SearchRequest) {
      if (closed) throw new SearchUnavailable('Knowledge service is closing');
      const request = searchSchema.parse(input);
      const ids = selectSources(loaded, request.projects, request.includeCore, request.kinds)
        .map(collectionID)
        .filter(id => sources.has(id));
      // Never pass an empty filter: QMD interprets it as an unscoped query.
      if (!ids.length) return [];
      // Semantic when the models are home: expansion, vectors and reranking fused
      // and re-scored. A pipeline failure answers with keyword search, and says
      // it once; the scope guard below falls through to neither.
      // The semantic pipeline serves only when all three models are on disk: a
      // person's search never waits on a download. `aivi knowledge warm` brings
      // the models; until then QMD's keyword search answers alone.
      if ((['embed', 'rerank', 'generate'] as const).every(probe)) {
        let found: Awaited<ReturnType<QmdStore['search']>> | undefined;
        try {
          found = await store.search({ query: request.query, limit: request.limit, collections: ids });
        } catch (error) {
          if (!warned.has('semantic')) {
            warned.add('semantic');
            log?.warn('knowledge.semantic.failed', { error, hint: 'answering with keyword search' });
          }
        }
        if (found) {
          const hits: SearchHit[] = [];
          for (const result of found) {
            const collection = /^qmd:\/\/([^/]+)\//.exec(result.file)?.[1];
            if (!collection || !ids.includes(collection)) throw new Error('QMD returned an out-of-scope collection');
            const hit = await toHit(
              sources.get(collection)!,
              {
                collectionName: collection,
                filepath: result.file,
                displayPath: result.displayPath,
                title: result.title,
                score: result.score,
                // The reranker's chunk is the excerpt; the whole body only locates its line.
                body: result.bestChunk || result.body,
              },
              request.query,
              sdk,
              warned,
              log,
              result.body,
            );
            if (hit) hits.push(hit);
          }
          return hits;
        }
      }
      const results = await store.searchLex(request.query, { limit: request.limit, collection: ids });
      const hits: SearchHit[] = [];
      for (const result of results) {
        if (!ids.includes(result.collectionName)) throw new Error('QMD returned an out-of-scope collection');
        const hit = await toHit(sources.get(result.collectionName)!, result, request.query, sdk, warned, log);
        if (hit) hits.push(hit);
      }
      return hits;
    },
    index,
    async close() {
      closed = true;
      await scanning;
      await store.close();
    },
  };
}

/**
 * Bring the semantic models to this home: download what is missing, embed the
 * corpus, and load the expansion and rerank models with one scoped query.
 * Searches answer with keyword search alone until this has run once; repeat it
 * after changing `search.models` (vectors are not cross-model — repeat with
 * force). It opens the same QMD database the way `aivi knowledge index` does:
 * a short-lived visitor beside the host.
 */
export async function warmKnowledge(
  loaded: LoadedConfig,
  loader: () => Promise<QmdSDK> = async () => defaultSDK,
  log?: Logger,
): Promise<{ models: Record<ModelRole, string>; embedded: number }> {
  if (loaded.config.search === false) throw new SearchUnavailable('Knowledge search is disabled in the config');
  const sdk = await loader();
  const { collections } = await surveySources(loaded, log);
  const ids = Object.keys(collections);
  if (!ids.length) throw new SearchUnavailable('No knowledge source exists yet to warm against');
  const folder = resolve(loaded.config.stateDirectory, 'knowledge');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const models = loaded.config.search.models;
  const store = await sdk.createStore({
    dbPath: resolve(folder, 'qmd.sqlite'),
    config: { collections, ...namedModels(models) },
  });
  try {
    await store.update();
    // embed() is the embed model's download path; one full query is the other two's.
    const embedded = await store.embed();
    await store.search({ query: 'aivi', limit: 1, collections: ids });
    return {
      models: {
        embed: resolveModel('embed', models),
        rerank: resolveModel('rerank', models),
        generate: resolveModel('generate', models),
      },
      embedded: embedded.chunksEmbedded,
    };
  } finally {
    await store.close();
  }
}
