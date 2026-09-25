import { personCreateSchema, personTokenCreateSchema } from '@aivi/core';
import type { Hono } from 'hono';
import type { Store } from '../../store.ts';
import type { AppEnv } from '../env.ts';
import { capBody, issuesOf, MAX_JOB_BODY, readCapped, requireJson, respond, zBody } from '../http.ts';

/**
 * People live behind the operator gate (mounted in `createApp`): listing,
 * creating and minting tokens all name who you are. The mint checks the
 * person exists before it reads the body, so an unknown id answers 404
 * whatever the body holds.
 */
export function registerPeople(app: Hono<AppEnv>, deps: { store: Store }): void {
  app.get('/people', c => c.json(deps.store.people()));
  app.post(
    '/people',
    requireJson,
    capBody(MAX_JOB_BODY, 'Person request is too large'),
    zBody('person', personCreateSchema),
    async c => {
      const person = c.req.valid('json');
      return c.json(
        deps.store.createPerson({
          name: person.name,
          email: person.email ?? null,
          ...(person.roles ? { roles: person.roles } : {}),
        }),
      );
    },
  );
  app.post('/people/:id/tokens', async c => {
    const personId = c.req.param('id');
    if (!deps.store.person(personId)) return respond({ error: `Unknown person ${personId}` }, 404);
    if (!c.req.header('content-type')?.startsWith('application/json')) return respond({ error: 'Expected JSON' }, 415);
    const capped = await readCapped(c.req.raw.body, MAX_JOB_BODY);
    if (capped === null) return respond({ error: 'Token request is too large' }, 413);
    const parsed = personTokenCreateSchema.safeParse(safeParse(capped.toString('utf8')));
    if (!parsed.success) return respond({ error: `Invalid token request: ${issuesOf(parsed.error)}` }, 400);
    return c.json(deps.store.mintToken(personId, parsed.data.label));
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
