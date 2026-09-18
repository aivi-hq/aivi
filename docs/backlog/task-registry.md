# Task registry: modules schedule work through the host

Status: **built and verified 2026-09-18.** The behaviour is documented where it
owns it: the vocabulary in `CONTEXT.md`, the task kinds and operations in
[configuration](../configuration.md), the module contract in
[architecture](../architecture.md). What is still open is the config surface
for tuning seeded schedules ([minimal-schedule-config](minimal-schedule-config.md)).
This file keeps the lessons that do not belong in a behaviour document.

## Why

The host could only run its own hardcoded task kinds (a closed zod union + a
switch in the executor). A module like Linear that needs periodic work (a
worktree sweep) had no door: the alternatives were the host learning about
Linear, or a private timer in the module — both against the rules (no
polling; adapters are optional). The owner's model: **task** = a thing that
can be done; **job** = a schedule around a task; **run** = one firing.
Modules register task types with the host; the host schedules and delegates
execution back to the registering module.

## Design as built (validated by tests, then reverted)

- `taskSchema` is three arms: `prompt` (renamed from `opencode.prompt`),
  `shell`, and `invocation { name, args? }`. The host's five system kinds
  (`system.check`, `knowledge.index`, `projects.sync`, `runs.prune`,
  `dreaming`) are no longer kinds — they are operations invoked by name.
  Kinds stay a closed set of three; the open set is names, not kinds.
- `TaskRegistry` (`packages/host/src/tasks.ts`, ~50 lines): `claim(owner,
  name, handler)` — each name claimed **exactly once**; a second owner is a
  fatal `ConfigurationError` that names the winner. The same owner
  re-claiming (a module restart) replaces. `forModule(id)` hands a module a
  door with its own id baked in, so it cannot claim or release under
  another's name.
- The host is just another claimant: `createExecutor` claims its five into
  the same registry; the executor's switch is `prompt` / `shell` /
  `invocation`→lookup. An unclaimed name **fails the run with the name in
  the reason** — never silent.
- `HostModule` gains `jobs?(config): Job[]`: system jobs seeded beside the
  host's while the module is composed; a module leaving the composition loses
  its jobs (existing `syncJobs` machinery); two definitions sharing an id are
  fatal at startup, not a silent overwrite. Modules claim operations in
  `start()` through the scoped door.
- `args` are opaque to the host; the claimant parses them at run time (bad
  args = failed run with a readable reason). Args schemas live in **core**
  (`runsPruneArgsSchema`, `dreamingArgsSchema`) because the host package has
  no zod dependency.
- Who may author what: `aivi_jobs` (agent-created) accepts only `prompt` and
  `shell` (`userTaskSchema`). Hand-written `aivi.json` jobs may write an
  invocation — that is how the dreaming job is opted into, the owner's own
  example (`task: { kind: "invoke", on: "dreaming" }` settled it).
- One `taskLabel(task)` in core: every view (CLI `jobs list`, `/status`,
  reports, scheduler logs) shows the operation name where a kind would
  appear, so a future desktop app lists `linear.sweep`, not `invocation`.
- Dreaming's `memoryDirectory` validation moved out of `loadConfig` into the
  dreaming operation itself: the config no longer knows any operation's args.

## Verified before reverting

152 tests, including through the real `runHost`: claim clash kills the host
naming the winner; module jobs seed as `system` and a shared id is fatal; the
scheduler dispatches to a module's handler and fails honestly when nobody
claimed. Schemas regenerated, smoke green, live example home loaded.

## Learnings

- **The store's read path is schema-free** (`JSON.parse` casts, no zod): old
  task JSON in history rows cannot crash views after a kind rename; only the
  construction paths parse. A pre-1.0 rename is therefore safe for history,
  and `syncJobs` replaces the live job rows on its own.
- **Order is the whole race**: module claims happen in `start()`, so
  `supervisor.start(modules)` must precede the wake loop's first
  `scheduler.tick()`; `syncJobs` precedes `serve`. It held;
  keep the application-level tests that pin it.
- **The CLI `aivi tick` was removed** (owner's call, 2026-09-18): the serving
  host is the only executor, so a module-owned operation can never meet a
  module-less dispatch. `scheduler.tick()` runs only inside `runHost`, after
  `supervisor.start(modules)`.
- Renaming a task kind touches: core schema + job builders, the executor,
  reports, `aivi_jobs`, both channel adapters (they check `task.kind` to
  decide session-adopt vs seed), the CLI, the example home, and the docs
  tables. Mechanical but wide — budget it.
