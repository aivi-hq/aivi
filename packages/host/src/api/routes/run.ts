import type { Logger } from '@aivi/core';
import type { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { respond } from '../http.ts';

/**
 * `GET /run?session=`: is this OpenCode session one of aivi's runs? The
 * redirect hook's one question (docs/plans/git-workflow.md), answered from
 * the run ledger and nothing else — a person's session never appears in the
 * ledger, so it is never denied. The plugin asks once per session and
 * caches; this read stays cheap by contract.
 */
export function registerRun(
  app: Hono<AppEnv>,
  deps: { runMembership?: ((sessionID: string) => boolean) | undefined; log: Logger },
): void {
  app.get('/run', c => {
    const session = new URL(c.req.url).searchParams.get('session');
    if (!session) return respond({ error: 'session is required' }, 400);
    if (!deps.runMembership) return respond({ error: 'Run membership is unavailable' }, 503);
    return c.json({ run: deps.runMembership(session) });
  });
}
