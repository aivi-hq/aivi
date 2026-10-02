/**
 * The kit: the contracts aivi is built on, in the package that owns them.
 * The **run** domain (what a run is), the **tracker** contract (the stages
 * the orchestrator walks and the platform behind them), the **channel**
 * contract (conversations on chat platforms), and the **module** contract
 * (what `runHost` composes and hands a module) are declared here; the host
 * implements them and imports them from here, and plugin packages import
 * them from here. One copy, owned by the package everyone already imports.
 *
 * This package depends on nothing above it: `@aivi/core` for the shared
 * facts, `@opencode/client` to name the client plugins receive. The host is
 * the one that depends on the kit, never the other way — at compile time or
 * at runtime. Where a contract names a store or a registry, it names an
 * interface here and the host's class is checked against it.
 */

export * from './cli.ts';
export * from './module.ts';
export * from './plugin.ts';
export * from './run.ts';
export * from './setup.ts';
export * from './setup-project.ts';
export * from './tracker.ts';
