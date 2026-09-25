import type { Person } from '@aivi/core';
import type { Store } from '../store.ts';
import type { AppMiddleware } from './env.ts';
import { respond } from './http.ts';

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

/** Resolved once per request; endpoints read `c.get('person')` instead of parsing again. */
export const resolvePerson = (store: Store): AppMiddleware => {
  return async (c, next) => {
    c.set('person', bearerPerson(store, c.req.header('authorization')));
    await next();
  };
};

/** Endpoints whose answer must be attached to a person refuse the anonymous. */
export function requirePerson(message: string): AppMiddleware {
  return async (c, next) => {
    if (!c.get('person')) return respond({ error: message }, 401);
    await next();
  };
}

/**
 * Managing people names who you are and requires the operator role; the
 * store-direct path on the server itself is the operator at the console.
 */
export const requireOperator: AppMiddleware = async (c, next) => {
  const person = c.get('person');
  if (!person?.roles.includes('operator'))
    return respond(
      person
        ? { error: 'Only an operator manages people' }
        : { error: 'Managing people names who you are; send a bearer token' },
      person ? 403 : 401,
    );
  await next();
};
