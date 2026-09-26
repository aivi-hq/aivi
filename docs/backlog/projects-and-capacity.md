# Maintenance only when idle

Status: the one survivor of the 2026-09-14 capacity research. The per-project
lock half was built (plans/linear.md step 5) and removed again (step 11,
2026-09-19): worktrees became the isolation and the pool the capacity, and
one worker per issue remained as the redelivery guard
([linear](../linear.md)). What survives as an unscheduled idea is
**maintenance only when idle**: dreaming and indexing should run when no
agent is working, from the same queue, rather than at a fixed cron
regardless of load. They share the `local-model`/`maintenance` pools today;
nothing yet expresses "only when idle".

## The shape

Express it on the schedule, enforce it in `claim()`:

```json
{
  "id": "dreaming",
  "cron": "0 22 * * *",
  "timezone": "Europe/Amsterdam",
  "resource": "local-model",
  "when": { "idle": true, "deadline": "06:00" },
  "task": { "kind": "invocation", "name": "dreaming", "args": { "…": "…" } }
}
```

- The occurrence materializes at 22:00 as today (one outstanding run per
  job). While `when.idle` applies, `claim()` takes the job only when
  `capacityUsage()` is empty: no running or blocked job and no lease, across
  *all* pools. At `deadline` (the next wall-clock time after the occurrence,
  in the job's timezone) the idle requirement lapses and the job competes for
  capacity normally. No deadline means it waits as long as needed.
- Smallest change: `jobs.idle_until INTEGER NULL`, set by `materializeDue`
  from `when`; `claim()` adds
  `AND (idle_until IS NULL OR idle_until <= ? OR <no active rows>)`. `when`
  is validated beside `cron`/`timezone` in the job schema
  (`packages/core/src/config.ts`).
- "Idle" means aivi's own jobs and leases only. Native OpenCode sessions are
  not consulted first: a human typing in the TUI is not competing for the
  `local-model` pool unless that model is the shared local one, and even
  then the cost is contention, not corruption. If the live boundary
  (`npm run live:opencode`) shows a usable per-session busy signal — the v2
  client docs did not show a `session.active` operation; confirm at the
  boundary, do not assume — add `when.idle: "aivi" | "aivi+native"` with the
  native check as a *soft* condition (skip this tick, never block), keeping
  the deadline as the guarantee.
- Hysteresis (idle for at least N minutes before starting) is deliberately
  out; the deadline already bounds worst-case lateness.

## Prior art (researched 2026-09-14)

OpenClaw's heartbeat is the only "run when quiet" primitive found: it defers
while "the main queue or automation work is busy, another run for the same
agent is active, or the target session has active or queued work"; ordinary
automations do not defer (<https://docs.openclaw.ai/automation>). Hermes has
no idle policy: overlap is prevented per job (an in-flight guard, "already
running" refusals) and globally by `cron.max_parallel_jobs`; neither project
locks a repository
(<https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>).

## Later

- Per-project idle ("run project X's indexing when *X* is idle") is the same
  `when.idle` plus a project-scoped maintenance task; add it when one exists.
- A `last_active_at` marker, once hysteresis earns its keep.
