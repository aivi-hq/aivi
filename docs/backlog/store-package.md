# The database file does everything; it belongs below the kit

Status: parked by the operator to start right after the
[CLI refactor](../plans/cli-refactor/index.md) ends; the refactor merged
2026-10-03, so the parking lot is open. The *how* is the operator's — they
already have a split in mind; write it here when the work starts. This page
records the why and the payoff.

## The problem

`packages/host/src/store.ts` is 1,100 lines and ~63 methods: it opens the
database (node's built-in `node:sqlite`, so loading the file is genuinely
small) and then carries every query in the system — migrations, jobs, runs,
capacity leases, the request diary, people and tokens.
`ConversationStore` (`packages/host/src/channel/store.ts`) is the same story
for turns and leases. One class knows the whole system; "load this file" is
the constructor and the other ~1,500 lines are everything else.

## The architectural edge — resolved by the flip (2026-10-02)

This page once recorded that `@aivi/plugin` named host types in its
contracts and so could not be imported *by* the host engine
(project-reference cycle). The flip deleted that edge: the kit now
*declares* the contracts — `module.ts` carries the `Store` and
`Orchestrator` interfaces, `channel.ts` the `ConversationStore` and
`Channels` ones — and the host's classes carry `implements` clauses against
them. The kit depends on core, `@opencode/client` and `@clack/prompts`, and
on nothing above it.

What is left here is therefore *only* the implementation split: the kit's
`Store` interface mirrors the host class's public surface, and both would
rather the queries lived nearer their tables. When the split lands, the
interfaces move to whichever package ends up below the kit and the `implements`
clauses keep the classes honest through the move.

## The payoff when the split lands

- The queries live beside their tables, not in one class that knows the
  whole system.
- The database handle stays a handle: the runner reads `stateDirectory` from
  the config, opens the database, and hands plugins the open handle
  (`ctx.withStore`). No plugin ever names a path — that stays true either
  way.
