import type { Logger } from '@aivi/core';
import type { PublicRouteHandler, PublicRoutes as PublicRoutesApi } from '@aivi/plugin/module';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppMiddleware } from './env.ts';
import { MAX_PUBLIC_BODY, readCapped, respond } from './http.ts';

/** Paths the API answers before any routing logic: a public route may not claim either. */
const RESERVED = new Set(['/health', '/version']);

/**
 * Routes a module exposes without the bearer token: webhooks from platforms
 * that authenticate with their own signature. A path is owned by one handler;
 * registering it twice is a programming error. `/health` and `/version` are
 * the only other unauthenticated routes, and no module may take them.
 */
export class PublicRoutes implements PublicRoutesApi {
  private readonly handlers = new Map<string, PublicRouteHandler>();
  register(path: string, handler: PublicRouteHandler): () => void {
    if (!path.startsWith('/') || RESERVED.has(path))
      throw new Error(`Public route ${path} must be an absolute path and never /health or /version`);
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

/**
 * The dispatcher runs before the version gate: a platform webhook is not an
 * aivi client and authenticates with its own signature over the raw bytes.
 */
export function publicDispatch(routes: PublicRoutes | undefined, log: Logger): AppMiddleware {
  return async (c, next) => {
    const handler = routes?.get(c.req.path);
    if (!handler) return next();
    const body = await readCapped(c.req.raw.body, MAX_PUBLIC_BODY);
    if (body === null) return respond({ error: 'Body too large' }, 413);
    try {
      const outcome = await handler({
        method: c.req.method,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        body,
      });
      return respond(outcome.body ?? {}, outcome.status as ContentfulStatusCode);
    } catch (error) {
      log.warn('api.public.failed', { path: c.req.path, error });
      return respond({ error: 'Internal error' }, 500);
    }
  };
}
