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

/** The orchestrator's face as a tracker module meets it: hand work over,
 *  stop a run, follow the typed run events. The run types are the host's;
 *  the shared event a tracker subscribes to is this package's. */
export type {
  AiviModule,
  AiviServices,
  Orchestrator,
  PublicRequest,
  PublicRoutes,
  RunningModule,
  RunOutcome,
  RunQuestion,
  RunState,
  RunView,
  Store,
  WorkRequest,
} from '@aivi/host';
export * from './cli.ts';
export * from './plugin.ts';
export * from './run-events.ts';
export * from './setup.ts';
export * from './setup-project.ts';
