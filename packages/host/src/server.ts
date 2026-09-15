import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BrowserService, KnowledgeKind, KnowledgeService, LoadedConfig, Logger, Status } from '@aivi/core';
import { browserEnvelopeSchema, knowledgeKindSchema, searchSchema, selectSources, silentLogger } from '@aivi/core';
import type { Store } from './store.ts';

export type HostAuth = { mode: 'none' } | { mode: 'token'; token: string };

export const MIN_TOKEN_LENGTH = 24;

/** Build the auth policy from config plus environment; fails fast with an actionable message. */
export function resolveHostAuth(mode: 'none' | 'token', token: string | undefined): HostAuth {
  if (mode === 'none') return { mode: 'none' };
  if (!token)
    throw new Error(
      'AIVI_TOKEN is required while host.auth.mode is "token". Set it in the environment (fnox) or set host.auth.mode to "none" on a trusted network.',
    );
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(`AIVI_TOKEN must contain at least ${MIN_TOKEN_LENGTH} characters`);
  return { mode: 'token', token };
}

export function status(store: Store, loaded: LoadedConfig): Status {
  return {
    version: '0.1.0',
    counts: store.counts(),
    sources: loaded.sources.length,
    leases: store.leaseCount(),
    completion: 'verified-final-answer',
  };
}

export interface HostServerOptions {
  store: Store;
  loaded: LoadedConfig;
  auth: HostAuth;
  knowledge?: KnowledgeService | undefined;
  browser?: BrowserService | undefined;
  log?: Logger | undefined;
}

const MAX_BROWSER_BODY = 32 * 1024;

export function createHostServer({ store, loaded, auth, knowledge, browser, log = silentLogger }: HostServerOptions) {
  const expected = auth.mode === 'token' ? Buffer.from(`Bearer ${auth.token}`) : undefined;
  const authorized = (request: IncomingMessage) => {
    if (!expected) return true;
    const provided = Buffer.from(request.headers.authorization ?? '');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };

  return createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    const send = (code: number, body: unknown) => {
      response.writeHead(code);
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://localhost');

    // Liveness is public so process supervisors can probe without credentials.
    if (url.pathname === '/health') {
      send(200, { ok: true });
      return;
    }
    if (!authorized(request)) {
      send(401, { error: 'Unauthorized' });
      return;
    }

    if (url.pathname === '/v1/browser') {
      handleBrowser(request, response, send);
      return;
    }
    if (request.method !== 'GET') {
      send(405, { error: 'Method not allowed' });
      return;
    }
    if (url.pathname === '/v1/status') {
      send(200, status(store, loaded));
      return;
    }
    if (url.pathname === '/v1/knowledge/search') {
      handleSearch(url, send);
      return;
    }
    if (url.pathname === '/v1/sources') {
      handleSources(url, send);
      return;
    }
    send(404, { error: 'Not found' });
  });

  type Send = (code: number, body: unknown) => void;

  /** Shared query-string grammar: `project` (repeatable), `includeCore`, `coreOnly`, `kind` (repeatable). */
  function parseSelection(
    params: URLSearchParams,
    extra: string[],
  ): { projects?: string[]; includeCore: boolean; kinds?: KnowledgeKind[] } | string {
    const allowed = new Set(['project', 'includeCore', 'coreOnly', 'kind', ...extra]);
    for (const key of params.keys()) if (!allowed.has(key)) return `Unknown parameter: ${key}`;
    for (const key of ['includeCore', 'coreOnly']) {
      if (params.has(key) && !['true', 'false'].includes(params.get(key)!)) return `Invalid ${key}`;
    }
    const coreOnly = params.get('coreOnly') === 'true';
    const projects = params.getAll('project');
    if (coreOnly && projects.length) return 'Choose projects or coreOnly';
    const kinds = params.getAll('kind');
    for (const kind of kinds) if (!knowledgeKindSchema.safeParse(kind).success) return `Unknown kind: ${kind}`;
    return {
      ...(coreOnly ? { projects: [] } : projects.length ? { projects } : {}),
      includeCore: params.get('includeCore') !== 'false',
      ...(kinds.length ? { kinds: kinds as KnowledgeKind[] } : {}),
    };
  }

  function handleSources(url: URL, send: Send) {
    const selection = parseSelection(url.searchParams, []);
    if (typeof selection === 'string') {
      send(400, { error: selection });
      return;
    }
    try {
      send(200, selectSources(loaded, selection.projects, selection.includeCore, selection.kinds));
    } catch (error) {
      send(400, { error: (error as Error).message });
    }
  }

  function handleSearch(url: URL, send: Send) {
    const selection = parseSelection(url.searchParams, ['q', 'limit']);
    if (typeof selection === 'string') {
      send(400, { error: selection });
      return;
    }
    const parsed = searchSchema.safeParse({
      query: url.searchParams.get('q'),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...selection,
    });
    if (!parsed.success) {
      send(400, { error: 'Invalid search request' });
      return;
    }
    try {
      selectSources(loaded, parsed.data.projects, parsed.data.includeCore, parsed.data.kinds);
    } catch (error) {
      send(400, { error: (error as Error).message });
      return;
    }
    if (!knowledge) {
      send(503, { error: 'Knowledge search is unavailable' });
      return;
    }
    const { query, limit, projects, includeCore, kinds } = parsed.data;
    knowledge
      .search({
        query,
        limit,
        ...(projects ? { projects } : {}),
        ...(includeCore !== undefined ? { includeCore } : {}),
        ...(kinds ? { kinds } : {}),
      })
      .then(
        hits => send(200, hits),
        error => {
          log.warn('knowledge.search.failed', { error });
          send(503, { error: 'Knowledge search is unavailable' });
        },
      );
  }

  function handleBrowser(request: IncomingMessage, response: ServerResponse, send: Send) {
    if (request.method !== 'POST') {
      send(405, { error: 'Use POST for browser operations' });
      return;
    }
    if (!browser) {
      send(503, { error: 'Browser is not configured' });
      return;
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      send(415, { error: 'Expected JSON' });
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > MAX_BROWSER_BODY) {
          send(413, { error: 'Browser request is too large' });
          return;
        }
        chunks.push(chunk);
      }
      const parsed = browserEnvelopeSchema.safeParse(safeJson(Buffer.concat(chunks).toString('utf8')));
      if (!parsed.success) {
        send(400, { error: 'Invalid browser request' });
        return;
      }
      try {
        send(200, await browser.execute(parsed.data.sessionId, parsed.data.request));
      } catch (error) {
        log.warn('browser.failed', { session: parsed.data.sessionId, action: parsed.data.request.action, error });
        send(409, {
          error:
            'Browser operation failed. Inspect the owned tabs before retrying; uncertain connections require a host restart.',
        });
      }
    })().catch(error => {
      log.warn('browser.interrupted', { error });
      if (!response.headersSent) send(400, { error: 'Browser request interrupted' });
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
