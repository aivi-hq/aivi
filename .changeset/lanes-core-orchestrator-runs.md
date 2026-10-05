---
'@aivi/core': minor
'@aivi/plugin': minor
'@aivi/host': minor
---

**Lanes are core's; the orchestrator runs and emits.** `projects.<id>.lanes`
is now a **core** ordered array (`projectLanesSchema`): each lane names a
tracker platform's state, may name the `agent` that works it, may say
`worktree: true`, and may override the success target (`complete`) or the
failure target (`return`) — neighbours by default, a stop never moves, a
state named nowhere is silence. Names unique and every override naming a
lane of the same array are load-time errors; the old plugin-side lane maps
die with it. `laneOf` is the one question the decision code asks.

The host gains `host/src/orchestrator/`: the run machinery that owns a
ticket's working session — durable ledger, worker tools (`ask`, `plan`,
`work_complete`), nudges, lane moves decided from the array — and it **emits
typed run events** (`started`, `question`, `plan`, `ended`) at subscribers.
The orchestrator may not know a tracker exists (ruled 2026-10-01): it never
calls one, never mirrors delivery, holds no conversation column. The event
vocabulary is declared at `@aivi/plugin/run-events` for followers to type
against. The project-setup context grows `forgeConfigured` and `agents(id)`
— lane prompts pick from the OpenCode agents that can work the project's
checkout, never type.
