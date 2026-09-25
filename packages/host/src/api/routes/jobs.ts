import type { Logger } from '@aivi/core';
import { jobRequestSchema } from '@aivi/core';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JobHandler } from '../../jobs.ts';
import { JobRefused } from '../../jobs.ts';
import type { AppEnv } from '../env.ts';
import { capBody, MAX_JOB_BODY, requireJson, respond, zBody } from '../http.ts';

/**
 * `POST /jobs` — the one job mutation on the API. Without a jobs handler the
 * route still exists and answers 503 before any body is read: the operation
 * is absent, which is not the same as a bad request.
 */
export function registerJobs(app: Hono<AppEnv>, deps: { jobs?: JobHandler | undefined; log: Logger }): void {
  const { jobs, log } = deps;
  if (!jobs) {
    app.post('/jobs', () => respond({ error: 'Job operations are not available' }, 503));
    return;
  }
  app.post(
    '/jobs',
    requireJson,
    capBody(MAX_JOB_BODY, 'Job request is too large'),
    zBody('job request', jobRequestSchema),
    async c => {
      const request = c.req.valid('json');
      try {
        return c.json(await jobs(request));
      } catch (error) {
        if (error instanceof JobRefused) return respond({ error: error.message }, error.status as ContentfulStatusCode);
        log.warn('jobs.failed', { action: request.action, error });
        return respond({ error: 'The job operation failed on the host; check its log.' }, 500);
      }
    },
  );
}
