# A schedule config should say frequency, nothing else

Status: owner's review feedback (2026-09-18) on the job-definition shape the
[task registry](task-registry.md) work exposed. Not built; settle this
**before** rebuilding the registry, because the registry's `HostModule.jobs`
seeding and any `scheduler.<name>` block inherit this shape.

## The objection

A system job's seeded definition today is a full `Job`: `id`, `cron`,
`timezone`, `resource`, `task`. The owner, reading the seeded `dreaming`/
sweep-style definitions:

- **`id`** — a name/label belongs to the task or the operation; a generated
  schedule definition is just *schedule defaults* for that operation.
- **`timezone`** — a system-wide setting, not per job.
- **`resource`** — the operator should not have to know what a capacity pool
  is to schedule a system job.
- **`task`** — convention should let it be the operation **name** by default;
  `task: { kind: "invocation", name: "linear.sweep" }` restates what is
  already known.
- The principle: *"All the user cares about is the frequency of tasks.
  Configuration for each invocation task goes in args. Why is this config
  needed at all?"*

## Direction (agreed in spirit, not yet designed)

- What lives in SQLite stays the full `Job` — the shrink is the **config
  surface**, not the storage. The host translates frequency knobs into the
  full definition when seeding.
- A `scheduler.<name>` block for a system operation shrinks toward `{ cron
  (or `every`), args? }` — `false` disables. `id`, `timezone` and the pool
  come from host-wide defaults (`scheduler.timezone`, a default resource)
  unless deliberately overridden.
- Hand-written jobs in `aivi.json` (`prompt`/`shell`, and invocations like
  dreaming the operator opts into) may keep the explicit shape — that is the
  one place a person *is* writing a definition. Even there a bare operation
  name for `task` could expand by convention.
- The desktop-app vision reinforces this: it lists jobs and lets a person set
  frequency; every knob shown is a config field the CLI could have hidden.

## Questions to settle before building

- Is the knob `cron` or a human interval (`"daily"`, `"hourly"`)? Croner
  accepts both shapes today (`* * * * *` and durations via `parseDue` for
  one-offs); pick one voice for system blocks.
- Do per-job `timezone`/`resource` overrides survive as escape hatches, or
  vanish until someone asks?
- Reserved-id rules (`retention`, `projects-sync`) follow from ids being
  derived — do they become unnecessary?
