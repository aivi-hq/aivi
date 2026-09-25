import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { KnowledgeKind, KnowledgeService, LoadedConfig, Logger, ModuleHealth, Person, Status } from '@aivi/core';
import {
  getLogger,
  jobRequestSchema,
  knowledgeKindHelp,
  knowledgeKindNames,
  knowledgeKindSchema,
  personCreateSchema,
  personTokenCreateSchema,
  projectSummaries,
  searchSchema,
  selectSources,
  sourceSelectionSchema,
  taskLabel,
  toolCallSchema,
} from '@aivi/core';
import { type JobHandler, JobRefused } from './jobs.ts';
import type { Store } from './store.ts';
import { ToolError, type ToolRegistry } from './tools.ts';

/**
 * The person a request's bearer names, for association (whose job, whose link,
 * whose memory). Auth is `none`: a request never needs a bearer, and an
 * unknown or absent one stays anonymous — only endpoints whose answer must be
 * attached to a person (whoami, link creation) reject it.
 */
export function bearerPerson(store: Store, authorization: string | null | undefined): Person | null {
  const header = authorization ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (!secret) return null;
  return store.personForToken(secret)?.person ?? null;
}

export function status(store: Store, loaded: LoadedConfig, now = Date.now(), modules: ModuleHealth[] = []): Status {
  return {
    version: '0.1.0',
    counts: store.counts(),
    sources: loaded.sources.length,
    leases: store.leaseCount(),
    completion: 'verified-final-answer',
    modules,
    upcoming: store
      .jobs()
      .filter(j => j.state === 'active' && j.nextAt !== null)
      .slice(0, 3)
      .map(j => ({
        id: j.spec.id,
        source: j.source,
        kind: taskLabel(j.spec.task),
        title: j.spec.title ?? null,
        nextAt: new Date(j.nextAt!).toISOString(),
      })),
    recent: store.recent(now - 24 * 3_600_000, 20).map(r => ({
      id: r.id,
      jobId: r.jobId,
      kind: taskLabel(r.task),
      state: r.state,
      finishedAt: new Date(r.finishedAt ?? now).toISOString(),
      error: r.error,
    })),
  };
}

/** What a public route sees: the request and its raw body (signatures are computed over bytes, never re-serialized JSON). */
export interface PublicRequest {
  method: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}
export type PublicRouteHandler = (request: PublicRequest) => Promise<{ status: number; body?: unknown }>;

/**
 * Routes a module exposes without the bearer token: webhooks from platforms
 * that authenticate with their own signature. A path is owned by one handler;
 * registering it twice is a programming error. `/health` is the only other
 * unauthenticated route.
 */
export class PublicRoutes {
  private readonly handlers = new Map<string, PublicRouteHandler>();
  register(path: string, handler: PublicRouteHandler): () => void {
    if (!path.startsWith('/v1/')) throw new Error(`Public route ${path} must be under /v1/`);
    if (this.handlers.has(path)) throw new Error(`Public route ${path} is registered twice`);
    this.handlers.set(path, handler);
    return () => {
      if (this.handlers.get(path) === handler) this.handlers.delete(path);
    };
  }
  get(path: string): PublicRouteHandler | undefined {
    return this.handlers.get(path);
  }
}

export interface HostServerOptions {
  store: Store;
  loaded: LoadedConfig;
  knowledge?: KnowledgeService | undefined;
  /** `POST /v1/jobs`; absent when the host runs without one (tests). */
  jobs?: JobHandler | undefined;
  /** `POST /v1/wake`: the CLI changed the queue in SQLite; dispatch now. */
  wake?: (() => void) | undefined;
  /** Module health for `/v1/status`; absent from the CLI. */
  health?: (() => ModuleHealth[]) | undefined;
  /** `GET /v1/context?session=`: describe an OpenCode session for the agent running in it; absent without OpenCode. */
  context?: ((sessionID: string, signal: AbortSignal) => Promise<string>) | undefined;
  /** Module webhooks, outside bearer auth; absent from the CLI. */
  routes?: PublicRoutes | undefined;
  /** The channel modules that can consume a link code, with their redemption hints; absent from the CLI. */
  linkable?: (() => { id: string; hint?: string }[]) | undefined;
  /**
   * The tool door the OpenCode plugin reads: the host claims its own tools
   * here when it is given one, and composed modules claim theirs. Absent
   * from the CLI, where `/v1/tools` simply serves nothing.
   */
  tools?: ToolRegistry | undefined;
  log?: Logger | undefined;
}

const MAX_JOB_BODY = 64 * 1024;
const MAX_PUBLIC_BODY = 1024 * 1024;

/** Flat object schemas for the model-facing tool inputs; the host validates the exact wire shape with zod. */
const selectionProperties = {
  projects: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Project IDs. Omit for all projects; [] for core only. Project knowledge is only relevant to that project unless the question compares projects.',
  },
  includeCore: { type: 'boolean', description: 'Include company-wide core sources (default true).' },
  kinds: {
    type: 'array',
    items: { type: 'string', enum: knowledgeKindNames },
    description: `Restrict to kinds of material. ${knowledgeKindHelp}`,
  },
} as const;

const jobsInput = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'remove', 'run'] },
    id: { type: 'string', description: 'Job id, for pause/resume/remove/run (from list or create).' },
    title: { type: 'string', maxLength: 80, description: 'create: short label the person would recognise.' },
    prompt: {
      type: 'string',
      maxLength: 20000,
      description:
        'create, agent job: a self-contained instruction for a fresh session of the agent. It cannot ask questions; include everything it needs.',
    },
    command: {
      type: 'array',
      items: { type: 'string' },
      description: 'create, script job: argv (no shell). Exactly one of prompt or command.',
    },
    cwd: { type: 'string', description: 'Script working directory; default the calling session’s directory.' },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment for the script.' },
    timeoutMs: { type: 'integer', minimum: 10000, description: 'Default 30 min for agent jobs, 10 min for scripts.' },
    agent: { type: 'string', description: 'Agent job override; default the calling agent.' },
    directory: { type: 'string', description: 'Agent job override; default the calling session’s directory.' },
    at: {
      type: 'string',
      description:
        'One-off: ISO 8601 instant (2026-09-16T09:00:00+02:00) or a duration (30m, 2h, 1d). Exactly one of at or cron.',
    },
    cron: { type: 'string', description: 'Recurring: 5-field cron, e.g. "0 9 * * 1-5" for weekdays at 09:00.' },
    timezone: { type: 'string', description: 'IANA timezone for cron; default the host’s.' },
    report: {
      type: 'string',
      enum: ['session', 'channel', 'none'],
      description:
        'Where results go. session (default): back into this conversation, you will read and relay them. channel: posted as a new thread in a chat channel, by default the channel this conversation is in ("post it here/to this channel"), or the one named in `channel`. none: nowhere.',
    },
    module: {
      type: 'string',
      description:
        'Chat platform for report channel (discord, slack). Default: the platform this conversation is on; required from a native session.',
    },
    channel: {
      type: 'string',
      description: 'Platform channel id when report is channel; omit for the current channel.',
    },
    on: {
      type: 'string',
      enum: ['always', 'failure'],
      description: 'Report every outcome (default) or only failures.',
    },
  },
} as const;

export function createHostServer({
  store,
  loaded,
  knowledge,
  jobs,
  wake,
  health,
  context,
  routes,
  linkable,
  tools,
  log = getLogger(['aivi']),
}: HostServerOptions) {
  // The tool surface the OpenCode plugin builds itself from, claimed under
  // `host` with the ids agent-file permission rules already match. A
  // capability that does not exist claims nothing, so its tool is absent
  // from the plugin rather than present and failing.
  if (tools) {
    const claim = tools.claim.bind(tools, 'host');
    claim(
      {
        namespace: 'aivi',
        name: 'status',
        description: 'Inspect aivi job counts and capabilities. This does not start work.',
        input: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => status(store, loaded, Date.now(), health?.() ?? []),
    );
    claim(
      {
        namespace: 'aivi',
        name: 'sources',
        description: 'List configured knowledge sources and their paths. Omit projects for all; [] for core only.',
        input: { type: 'object', properties: selectionProperties, additionalProperties: false },
        timeoutMs: 10_000,
      },
      async call => {
        const parsed = sourceSelectionSchema.safeParse(call.input);
        if (!parsed.success) throw new ToolError(400, 'Invalid source selection');
        try {
          return selectSources(loaded, parsed.data.projects, parsed.data.includeCore, parsed.data.kinds);
        } catch (error) {
          throw new ToolError(400, (error as Error).message);
        }
      },
    );
    claim(
      {
        namespace: 'knowledge',
        name: 'projects',
        description:
          'List the projects the team works on, with the source kinds each can be searched by. A project marked removed no longer has a checkout; only what was remembered about it is left, and it can still be asked about.',
        input: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => projectSummaries(loaded),
    );
    if (knowledge)
      claim(
        {
          namespace: 'knowledge',
          name: 'search',
          description:
            'Keyword search over configured knowledge with source paths and excerpts. Omit projects for all; [] selects core only; includeCore defaults true.',
          input: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 2000 },
              limit: { type: 'integer', minimum: 1, maximum: 20 },
              ...selectionProperties,
            },
          },
        },
        async call => {
          const parsed = searchSchema.safeParse(call.input);
          if (!parsed.success) throw new ToolError(400, 'Invalid search request');
          try {
            selectSources(loaded, parsed.data.projects, parsed.data.includeCore, parsed.data.kinds);
          } catch (error) {
            throw new ToolError(400, (error as Error).message);
          }
          const { query, limit, projects, includeCore, kinds } = parsed.data;
          try {
            return await knowledge.search({
              query,
              limit,
              ...(projects ? { projects } : {}),
              ...(includeCore !== undefined ? { includeCore } : {}),
              ...(kinds ? { kinds } : {}),
            });
          } catch (error) {
            log.warn('knowledge.search.failed', { error });
            throw new ToolError(503, 'Knowledge search is unavailable');
          }
        },
      );
    if (context)
      claim(
        {
          namespace: 'aivi',
          name: 'context',
          description:
            'Describe this conversation’s context: the window in use against the model’s limit, compactions, token and cost totals for the session, and the knowledge in scope. Use when someone asks about context, tokens, cost or which model is answering. Relay the returned markdown as it is; every number comes from OpenCode.',
          input: { type: 'object', properties: {}, additionalProperties: false },
          timeoutMs: 20_000,
        },
        async call => {
          try {
            return { text: await context(call.sessionId, AbortSignal.timeout(15_000)) };
          } catch (error) {
            log.warn('context.failed', { session: call.sessionId, error });
            throw new ToolError(502, 'Could not read that session from OpenCode');
          }
        },
      );
    if (jobs)
      claim(
        {
          namespace: 'aivi',
          name: 'jobs',
          description:
            'Create, list, pause, resume, remove or run jobs: a one-off (`at`) or recurring (`cron`) agent job (`prompt`, runs your agent in a fresh session) or script job (`command`). Translate what the person said into cron/ISO/duration yourself; the reply names the next occurrences, relay them so the person can confirm. Results default to coming back into this conversation for you to relay. Only create when a person asked; never from inside a job. If the tool fails, relay its error message word for word: it says what to fix.',
          input: jobsInput,
          timeoutMs: 30_000,
        },
        async call => {
          // The envelope's ids win over anything in the model's input: they
          // come from the native tool context, and authority follows them.
          const parsed = jobRequestSchema.safeParse({
            ...call.input,
            sessionId: call.sessionId,
            ...(call.messageId ? { messageId: call.messageId } : {}),
          });
          if (!parsed.success)
            throw new ToolError(
              400,
              `Invalid job request: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            );
          try {
            return await jobs(parsed.data);
          } catch (error) {
            if (error instanceof JobRefused) throw new ToolError(error.status, error.message);
            log.warn('jobs.failed', { action: parsed.data.action, error });
            throw new ToolError(500, 'The job operation failed on the host; check its log.');
          }
        },
      );
  }
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
    const publicRoute = routes?.get(url.pathname);
    if (publicRoute) {
      handlePublic(request, publicRoute, send);
      return;
    }

    if (url.pathname === '/v1/people' || (url.pathname.startsWith('/v1/people/') && url.pathname.endsWith('/tokens'))) {
      // Managing people names who you are and requires the operator role; the
      // store-direct path on the server itself is the operator at the console.
      const person = bearerPerson(store, request.headers.authorization);
      if (!person?.roles.includes('operator')) {
        send(
          person ? 403 : 401,
          person
            ? { error: 'Only an operator manages people' }
            : { error: 'Managing people names who you are; send a bearer token' },
        );
        return;
      }
      if (url.pathname === '/v1/people') {
        if (request.method === 'POST') handlePeople(request, response, send);
        else if (request.method === 'GET') send(200, store.people());
        else send(405, { error: 'Use GET to list people or POST to create one' });
      } else {
        handlePersonToken(url, request, response, send);
      }
      return;
    }
    if (url.pathname === '/v1/tools') {
      handleTools(request, response, send);
      return;
    }
    if (url.pathname === '/v1/jobs') {
      handleJobs(request, response, send);
      return;
    }
    if (url.pathname === '/v1/wake') {
      if (request.method !== 'POST') send(405, { error: 'Use POST to wake the scheduler' });
      else {
        wake?.();
        send(200, { woken: wake !== undefined });
      }
      return;
    }
    if (url.pathname === '/v1/links') {
      const person = bearerPerson(store, request.headers.authorization);
      if (!person) {
        send(401, { error: 'Linking names a person; send a bearer token that resolves to one' });
        return;
      }
      // GET lists the running channels and whether this person already holds a
      // binding in each; the CLI shows what is eligible before asking to mint.
      if (request.method === 'GET') {
        const channels = linkable?.() ?? [];
        send(200, {
          channels: channels.map(c => ({
            channel: c.id,
            ...(c.hint ? { hint: c.hint } : {}),
            linked: store.personLinkedIn(c.id, person.id),
          })),
        });
        return;
      }
      if (request.method !== 'POST') {
        send(405, { error: 'Use GET to list channels or POST to mint a link code' });
        return;
      }
      // The mint names its channel: no code exists that no running module could
      // read, and none is minted for a channel the person is linked in already.
      void (async () => {
        const body = await readJson(request, MAX_JOB_BODY);
        if (typeof body === 'string') {
          send(body === 'too large' ? 413 : 415, { error: body === 'too large' ? 'Request is too large' : body });
          return;
        }
        const channelId =
          typeof (body as { channel?: unknown } | null)?.channel === 'string'
            ? (body as { channel: string }).channel
            : '';
        const running = linkable?.().find(c => c.id === channelId);
        if (!running) {
          send(404, { error: `No channel module "${channelId || '<none>'}" is running` });
          return;
        }
        if (store.personLinkedIn(running.id, person.id)) {
          send(409, { error: `Already linked in the ${running.id} channel.` });
          return;
        }
        const minted = store.mintLinkCode(person.id);
        // `next` is the one instruction that follows: where this code is spent.
        send(200, {
          code: minted.code,
          expiresAt: new Date(minted.expiresAt).toISOString(),
          person: person.name,
          next: running.hint
            ? running.hint.replace(/<code>/, minted.code)
            : `Paste \`/link ${minted.code}\` in the ${running.id} channel the bot reads.`,
        });
      })().catch(() => {
        if (!response.headersSent) send(400, { error: 'Link request interrupted' });
      });
      return;
    }
    if (request.method !== 'GET') {
      send(405, { error: 'Method not allowed' });
      return;
    }
    if (url.pathname === '/v1/whoami') {
      const person = bearerPerson(store, request.headers.authorization);
      if (!person) {
        send(401, { error: 'whoami names a person; send a bearer token that resolves to one' });
        return;
      }
      // The roles are the person's own, read from the store; whoami still
      // refuses to name an anonymous caller.
      send(200, { person: { id: person.id, name: person.name }, roles: person.roles });
      return;
    }
    if (url.pathname === '/v1/status') {
      send(200, status(store, loaded, Date.now(), health?.() ?? []));
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
    if (url.pathname === '/v1/projects') {
      send(200, projectSummaries(loaded));
      return;
    }
    if (url.pathname === '/v1/context') {
      const session = url.searchParams.get('session');
      if (!session) {
        send(400, { error: 'session is required' });
        return;
      }
      if (!context) {
        send(503, { error: 'Session context is unavailable' });
        return;
      }
      context(session, AbortSignal.timeout(15_000)).then(
        text => send(200, { text }),
        error => {
          log.warn('context.failed', { session, error });
          send(502, { error: 'Could not read that session from OpenCode' });
        },
      );
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

  function handleTools(request: IncomingMessage, response: ServerResponse, send: Send) {
    // GET is the plugin's load-time read: descriptors only, no handler crosses the wire.
    if (request.method === 'GET') {
      send(200, { tools: tools?.list() ?? [] });
      return;
    }
    if (request.method !== 'POST') {
      send(405, { error: 'Use GET to list tools or POST to call one' });
      return;
    }
    void (async () => {
      const body = await readJson(request, MAX_JOB_BODY);
      if (typeof body === 'string') {
        send(body === 'too large' ? 413 : 415, { error: body === 'too large' ? 'Tool call is too large' : body });
        return;
      }
      const parsed = toolCallSchema.safeParse(body);
      if (!parsed.success) {
        send(400, { error: 'Invalid tool call' });
        return;
      }
      const claim = tools?.get(parsed.data.tool);
      if (!claim) {
        send(404, { error: `No tool "${parsed.data.tool}" is offered by this host` });
        return;
      }
      const call = {
        sessionId: parsed.data.sessionId,
        ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}),
        input: parsed.data.input,
      };
      try {
        send(200, await claim.handler(call));
      } catch (error) {
        if (error instanceof ToolError) {
          send(error.status, { error: error.message });
          return;
        }
        log.warn('tools.failed', { tool: parsed.data.tool, error });
        send(500, { error: 'The tool failed on the host; check its log.' });
      }
    })().catch(error => {
      log.warn('tools.interrupted', { error });
      if (!response.headersSent) send(400, { error: 'Tool call interrupted' });
    });
  }

  function handleJobs(request: IncomingMessage, response: ServerResponse, send: Send) {
    if (request.method !== 'POST') {
      send(405, { error: 'Use POST for job operations' });
      return;
    }
    if (!jobs) {
      send(503, { error: 'Job operations are not available' });
      return;
    }
    void (async () => {
      const body = await readJson(request, MAX_JOB_BODY);
      if (typeof body === 'string') {
        send(body === 'too large' ? 413 : 415, { error: body === 'too large' ? 'Job request is too large' : body });
        return;
      }
      const parsed = jobRequestSchema.safeParse(body);
      if (!parsed.success) {
        send(400, {
          error: `Invalid job request: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        });
        return;
      }
      try {
        send(200, await jobs(parsed.data));
      } catch (error) {
        if (error instanceof JobRefused) {
          send(error.status, { error: error.message });
          return;
        }
        log.warn('jobs.failed', { action: parsed.data.action, error });
        send(500, { error: 'The job operation failed on the host; check its log.' });
      }
    })().catch(error => {
      log.warn('jobs.interrupted', { error });
      if (!response.headersSent) send(400, { error: 'Job request interrupted' });
    });
  }

  function handlePeople(request: IncomingMessage, response: ServerResponse, send: Send) {
    if (request.method !== 'POST') {
      send(405, { error: 'Use POST to create a person' });
      return;
    }
    void (async () => {
      const body = await readJson(request, MAX_JOB_BODY);
      if (typeof body === 'string') {
        send(body === 'too large' ? 413 : 415, { error: body === 'too large' ? 'Person request is too large' : body });
        return;
      }
      const parsed = personCreateSchema.safeParse(body);
      if (!parsed.success) {
        send(400, {
          error: `Invalid person: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        });
        return;
      }
      send(
        200,
        store.createPerson({
          name: parsed.data.name,
          email: parsed.data.email ?? null,
          ...(parsed.data.roles ? { roles: parsed.data.roles } : {}),
        }),
      );
    })().catch(() => {
      if (!response.headersSent) send(400, { error: 'Person request interrupted' });
    });
  }

  function handlePersonToken(url: URL, request: IncomingMessage, response: ServerResponse, send: Send) {
    if (request.method !== 'POST') {
      send(405, { error: 'Use POST to mint a person token' });
      return;
    }
    void (async () => {
      const personId = decodeURIComponent(url.pathname.slice('/v1/people/'.length, -'/tokens'.length));
      if (!store.person(personId)) {
        send(404, { error: `Unknown person ${personId}` });
        return;
      }
      const body = await readJson(request, MAX_JOB_BODY);
      if (typeof body === 'string') {
        send(body === 'too large' ? 413 : 415, { error: body === 'too large' ? 'Token request is too large' : body });
        return;
      }
      const parsed = personTokenCreateSchema.safeParse(body);
      if (!parsed.success) {
        send(400, {
          error: `Invalid token request: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        });
        return;
      }
      send(200, store.mintToken(personId, parsed.data.label));
    })().catch(() => {
      if (!response.headersSent) send(400, { error: 'Token request interrupted' });
    });
  }

  async function handlePublic(request: IncomingMessage, handler: PublicRouteHandler, send: Send) {
    const body = await readRaw(request, MAX_PUBLIC_BODY);
    if (body === null) {
      send(413, { error: 'Body too large' });
      return;
    }
    try {
      const outcome = await handler({ method: request.method ?? 'GET', headers: request.headers, body });
      send(outcome.status, outcome.body ?? {});
    } catch (error) {
      log.warn('api.public.failed', { path: request.url, error });
      send(500, { error: 'Internal error' });
    }
  }
}

/** The raw body up to `max` bytes, or null when larger. */
async function readRaw(request: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The parsed JSON body, or a short reason it was not read (`too large`, `Expected JSON`). */
async function readJson(request: IncomingMessage, max: number): Promise<unknown | string> {
  if (!request.headers['content-type']?.startsWith('application/json')) return 'Expected JSON';
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > max) return 'too large';
    chunks.push(chunk);
  }
  return safeJson(Buffer.concat(chunks).toString('utf8'));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
