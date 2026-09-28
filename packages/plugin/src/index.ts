/**
 * The kit a plugin author imports: the install-time contract (`./setup`
 * subpath), the operator-CLI contract (`./cli` subpath), and the module
 * contract under its authoring names. This package never depends on
 * `@aivi/host` at runtime: where a contract names a runtime type
 * (`Store`, `ConversationStore`) the import is type-only — the host
 * implements the bag, plugins receive it typed. The host's engine declares
 * the module contract (it implements it); this package is the face a
 * plugin author imports it through.
 */

export type { AiviModule, AiviServices, PublicRequest, PublicRoutes, RunningModule, Store } from '@aivi/host';
export * from './cli.ts';
export * from './plugin.ts';
export * from './setup.ts';
