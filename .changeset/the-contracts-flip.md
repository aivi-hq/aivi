---
'@aivi/core': minor
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**The contracts flip: the kit declares, the host follows.** `@aivi/plugin`
now *declares* the shared vocabulary — `run.ts` (what a run is),
`tracker.ts` (the `Tracker` stages and the `Platform` adapter), `channel.ts`
(conversations on chat platforms), `module.ts` (the module contract, with
`Store`/`Orchestrator`/`ConversationStore`/`Channels`/`PublicRoutes`/
`TaskClaims`/`ToolClaims`/`SessionEvents` interfaces the host's classes carry
`implements` clauses against). The kit depends on core, `@opencode/client`
and `@clack/prompts` and on nothing above it; `@aivi/host` references the kit
and imports its own vocabulary from it — the direction the references always
pointed away from. Names that moved or renamed: `PlatformAdapter` →
`Platform` (the word "platform" is the system aivi talks to over an API —
channels, forges and trackers all use one), `LinearTracker` →
`LinearPlatform`, `TrackerQuestion`/`TrackerPlanStep` are gone (the adapter
renders the orchestrator's own `RunQuestion`/`RunPlan` — one shape, no
field-by-field twins), and the run shapes, `WorkRequest`, `ChatCommandName`
and the scheduler shapes (`Lease`, `JobEntry`, `ExecutionContext`,
`RequestLogEntry`, `ToolCall`) have one home each: the kit for the
run/tracker/channel/module contract, core for the data shapes. No runtime
behavior moved: 452 tests, same green.
