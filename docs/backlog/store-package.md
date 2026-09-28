# The database file does everything; it belongs below the kit

Status: parked by the operator to start right after the
[CLI refactor](../plans/cli-refactor/index.md) ends. The *how* is the
operator's — they already have a split in mind; write it here when the work
starts. This page records the why and the payoff.

## The problem

`packages/host/src/store.ts` is 1,116 lines and ~63 methods: it opens the
database (node's built-in `node:sqlite`, so loading the file is genuinely
small) and then carries every query in the system — migrations, jobs, runs,
capacity leases, the request diary, people and tokens.
`ConversationStore` (`packages/host/src/channel/store.ts`, 495 lines) is the
same story for turns and leases. One class knows the whole system; "load
this file" is the constructor and the other ~1,500 lines are everything else.

## The architectural edge it leaves

`@aivi/plugin` — the package a plugin author imports — names host types in
its contracts: `Store` and `ConversationStore` (the CLI and setup contexts
hand them out), and the module contract's services bag names `Channels`,
`PublicRoutes`, `TaskClaims`, `ToolClaims`, `SessionEvents` and
`OpenCodeClient` besides.

This is type-only — verified 2026-09-28: the shipped JS of `@aivi/plugin`
never mentions the host, and its npm dependency is `@aivi/core` alone — but
it is still a reference the compiler follows, and it forces the one
deviation the refactor recorded
([plugin-contract, Landing](../plans/cli-refactor/plugin-contract.md)):
the kit cannot be imported *by* the host engine (project-reference cycle),
so the module contract's declaration stays in the host and the kit merely
re-exports it under the authoring names.

## The payoff when the split lands

- The store types live in a package *below* the kit — the host and the kit
  both depend on it — so the kit's only reference to the host disappears.
- With that edge gone, the host can import the contracts *from* the kit and
  the declarations really move there: one copy, owned by the package plugin
  authors already import.
- Where the database file lives stays the CLI's business exactly as it is
  today: the runner reads `stateDirectory` from the config, opens the
  database, and hands plugins the open handle
  (`ctx.withStore`). No plugin ever names a path.
