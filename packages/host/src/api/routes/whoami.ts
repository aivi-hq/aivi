import type { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { requirePerson } from '../person.ts';

/**
 * `GET /whoami`: the roles are the person's own, read from the store;
 * whoami still refuses to name an anonymous caller.
 */
export function registerWhoami(app: Hono<AppEnv>): void {
  app.get('/whoami', requirePerson('whoami names a person; send a bearer token that resolves to one'), c => {
    const person = c.get('person')!;
    return c.json({ person: { id: person.id, name: person.name }, roles: person.roles });
  });
}
