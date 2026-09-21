import type {
  BrowserResult,
  HostClient,
  JobResponse,
  KnowledgeSource,
  ProjectSummary,
  SearchHit,
  SourceSelection,
  Status,
  Whoami,
} from '@aivi/core';

export interface HostClientOptions {
  /** Bearer token identifying the caller (a person token). Omit to stay anonymous. */
  token?: string | undefined;
}

/**
 * Fetch-only client for the aivi host API. Used by the OpenCode plugin, so it
 * must stay free of SQLite, QMD, and other host-side dependencies.
 */
export function createHostClient(baseUrl: string, options: HostClientOptions = {}): HostClient {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Expected an HTTP host URL without embedded credentials');
  }
  const headers: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {};

  async function request<T>(path: string, init: RequestInit & { timeoutMs: number }): Promise<T> {
    const { timeoutMs, ...rest } = init;
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        ...rest,
        headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      // Every aivi tool goes through the host; the usual cause is simply that `aivi serve` is not running.
      if (error instanceof Error && error.name === 'TimeoutError') throw error;
      throw new Error(`aivi is not reachable at ${base.origin}. Is \`aivi serve\` running?`, { cause: error });
    }
    if (!response.ok) throw new Error(await describeFailure(response));
    return (await response.json()) as T;
  }

  const get = <T>(path: string) => request<T>(path, { timeoutMs: 10_000 });

  return {
    browser(sessionId, body) {
      // An accepted operation can wait behind other browser actions. A timeout is an
      // uncertain outcome, never an invitation to retry a click automatically.
      return request<BrowserResult>('/v1/browser', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, request: body }),
        timeoutMs: 300_000,
      });
    },
    search(query) {
      const params = new URLSearchParams({ q: query.query });
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      appendSelection(params, query);
      return get<SearchHit[]>(`/v1/knowledge/search?${params}`);
    },
    status: () => get<Status>('/v1/status'),
    sources(selection: SourceSelection = {}) {
      const params = new URLSearchParams();
      appendSelection(params, selection);
      return get<KnowledgeSource[]>(`/v1/sources?${params}`);
    },
    projects: () => get<ProjectSummary[]>('/v1/projects'),
    context: sessionId =>
      request<{ text: string }>(`/v1/context?${new URLSearchParams({ session: sessionId })}`, { timeoutMs: 20_000 }),
    wake: () => request<{ woken: boolean }>('/v1/wake', { method: 'POST', timeoutMs: 3_000 }),
    whoami: () => get<Whoami>('/v1/whoami'),
    jobs(body) {
      // Creating a job checks the calling session and agent against OpenCode; a few seconds at most.
      return request<JobResponse>('/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
    },
  };
}

function appendSelection(params: URLSearchParams, selection: SourceSelection): void {
  for (const project of selection.projects ?? []) params.append('project', project);
  // An explicit empty selection means core only.
  if (selection.projects?.length === 0) params.set('coreOnly', 'true');
  if (selection.includeCore === false) params.set('includeCore', 'false');
  for (const kind of selection.kinds ?? []) params.append('kind', kind);
}

async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === 'string') detail = `: ${body.error}`;
  } catch {
    // Non-JSON error body; the status is enough.
  }
  if (response.status === 401)
    return `aivi host rejected the request (401)${detail}. This endpoint needs a bearer token that names a person.`;
  return `aivi host returned HTTP ${response.status}${detail}`;
}
