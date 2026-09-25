import type { Logger } from '@aivi/core';
import type { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { respond } from '../http.ts';

/**
 * `GET /context?session=`: describe an OpenCode session for the agent
 * running in it. The AbortSignal is the read's own bound wait, as ever.
 */
export function registerContext(
  app: Hono<AppEnv>,
  deps: { context?: ((sessionID: string, signal: AbortSignal) => Promise<string>) | undefined; log: Logger },
): void {
  app.get('/context', async c => {
    const session = new URL(c.req.url).searchParams.get('session');
    if (!session) return respond({ error: 'session is required' }, 400);
    const { context } = deps;
    if (!context) return respond({ error: 'Session context is unavailable' }, 503);
    try {
      return c.json({ text: await context(session, AbortSignal.timeout(15_000)) });
    } catch (error) {
      deps.log.warn('context.failed', { session, error });
      return respond({ error: 'Could not read that session from OpenCode' }, 502);
    }
  });
}
