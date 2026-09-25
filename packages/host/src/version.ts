import { createRequire } from 'node:module';

/**
 * The version of this `@aivi/host` installation — read from its own
 * `package.json` at runtime, so the number can never drift from the package
 * that carries it. The same file answers on both sides of the wire: the
 * server gates on it, and `createHostClient` (which lives in this package)
 * sends it. `@aivi/cli` is versioned in lockstep with this package by the
 * changesets `fixed` group, so the thin CLI's own version is comparable
 * here; the gate's rules are in `api/gate.ts`.
 */
export const hostVersion: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
