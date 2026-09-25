import { createServer, type Server } from 'node:http';
import type { KnowledgeService, LoadedConfig, Logger, ModuleHealth } from '@aivi/core';
import { getLogger } from '@aivi/core';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { methodNotAllowed } from 'hono/method-not-allowed';
import type { JobHandler } from '../jobs.ts';
import type { Store } from '../store.ts';
import type { ToolRegistry } from '../tools.ts';
import { hostVersion } from '../version.ts';
import type { AppEnv } from './env.ts';
import { versionGate } from './gate.ts';
import { claimHostTools } from './host-tools.ts';
import { respond } from './http.ts';
import { requireOperator, resolvePerson } from './person.ts';
import { type PublicRoutes, publicDispatch } from './public.ts';
import { registerContext } from './routes/context.ts';
import { registerJobs } from './routes/jobs.ts';
import { registerKnowledge } from './routes/knowledge.ts';
import { registerLinks } from './routes/links.ts';
import { registerPeople } from './routes/people.ts';
import { registerStatus } from './routes/status.ts';
import { registerTools } from './routes/tools.ts';
import { registerWake } from './routes/wake.ts';
import { registerWhoami } from './routes/whoami.ts';

export interface HostApiOptions {
  store: Store;
  loaded: LoadedConfig;
  knowledge?: KnowledgeService | undefined;
  /** `POST /jobs`; absent when the host runs without one (tests). */
  jobs?: JobHandler | undefined;
  /** `POST /wake`: the CLI changed the queue in SQLite; dispatch now. */
  wake?: (() => void) | undefined;
  /** Module health for `/status`; absent from the CLI. */
  health?: (() => ModuleHealth[]) | undefined;
  /** `GET /context?session=`: describe an OpenCode session for the agent running in it; absent without OpenCode. */
  context?: ((sessionID: string, signal: AbortSignal) => Promise<string>) | undefined;
  /** Module webhooks, outside the version gate and bearer auth; absent from the CLI. */
  routes?: PublicRoutes | undefined;
  /** The channel modules that can consume a link code, with their redemption hints; absent from the CLI. */
  linkable?: (() => { id: string; hint?: string }[]) | undefined;
  /**
   * The tool door the OpenCode plugin reads: the host claims its own tools
   * here when it is given one, and composed modules claim theirs. Absent
   * from the CLI, where `/tools` simply serves nothing.
   */
  tools?: ToolRegistry | undefined;
  log?: Logger | undefined;
}

/**
 * The host API as a Hono app, listening on no port. The chain order is the
 * contract: standing headers wrap everything; `/health` and `/version` answer
 * first and are exempt from the gate by that order alone; module webhooks
 * dispatch on raw bytes before a client version is ever asked; then the
 * version gate, the bearer's person, and the operator gate on `/people`.
 * Unknown paths answer 404 to a GET and 405 to anything else, as the API has
 * always done, and a known path with the wrong method answers 405 with the
 * methods it takes.
 */
export function createApp(options: HostApiOptions): Hono<AppEnv> {
  const {
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
  } = options;
  const app = new Hono<AppEnv>();
  if (tools) claimHostTools(tools, { store, loaded, knowledge, jobs, health, context, log });

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('content-type', 'application/json');
    c.res.headers.set('cache-control', 'no-store');
  });
  // Liveness and the version are public so process supervisors and the
  // negotiation itself need no credentials and answer whatever else is wrong.
  app.get('/health', c => c.json({ ok: true }));
  app.get('/version', c => c.json({ version: hostVersion }));
  app.use('*', publicDispatch(routes, log));
  app.use('*', versionGate);
  app.use('*', resolvePerson(store));
  app.use('/people', requireOperator);
  app.use('/people/*', requireOperator);

  registerWhoami(app);
  registerStatus(app, { store, loaded, health });
  registerKnowledge(app, { loaded, knowledge, log });
  registerContext(app, { context, log });
  registerWake(app, { wake });
  registerLinks(app, { store, linkable });
  registerPeople(app, { store });
  registerJobs(app, { jobs, log });
  registerTools(app, { tools, log });

  app.use(
    '*',
    methodNotAllowed<AppEnv>({
      app,
      onMethodNotAllowed: (_c, methods) => respond({ error: 'Method not allowed' }, 405, { Allow: methods.join(', ') }),
    }),
  );
  app.notFound(c =>
    c.req.method === 'GET' ? respond({ error: 'Not found' }, 404) : respond({ error: 'Method not allowed' }, 405),
  );
  app.onError((error, c) => {
    log.warn('api.failed', { path: c.req.path, error });
    return respond({ error: 'Internal error' }, 500);
  });
  return app;
}

/**
 * The app over a real node http Server, not yet listening: `application.ts`
 * and the tests attach `error`/`listening` handlers before `listen` runs.
 */
export function serveApp(app: Hono<AppEnv>): Server {
  return createServer(getRequestListener(app.fetch));
}
