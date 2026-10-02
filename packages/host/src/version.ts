import { createRequire } from 'node:module';

/**
 * The version of this `@aivi/host` installation — read from its own
 * `package.json` at runtime, so the number can never drift from the package
 * that carries it. The server gates on it; clients name themselves with the
 * kit's version (`@aivi/plugin/api` reads its own `package.json`), and the
 * changesets `fixed` group keeps `@aivi/cli`, `@aivi/host` and `@aivi/plugin`
 * in lockstep, so the two sides of the wire agree. The gate's rules are in
 * `api/gate.ts`.
 */
export const hostVersion: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
