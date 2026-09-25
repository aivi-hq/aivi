import type { Person } from '@aivi/core';
import type { MiddlewareHandler } from 'hono';

/** The one Env of the host API: the person the bearer names, resolved once per request. */
export type AppEnv = { Variables: { person: Person | null } };
export type AppMiddleware = MiddlewareHandler<AppEnv>;
