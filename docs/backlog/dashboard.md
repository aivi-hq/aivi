# Dashboard

Status: far out; idea from the owner (2026-09-15). Not before the Linear module.

## Wanted

One place to see what aivi is doing without the CLI:

- Logs: the structured log stream, filterable by component, job, session.
- Dream runs: when they ran, what they reviewed, what changed in memory, the
  agent's summary, the transcript; the pending proposals.
- Jobs and schedules: queue counts, next occurrences, recent outcomes, blocked
  work with its reason and a link to the native session.
- Projects: registered projects, their knowledge sources, index freshness.
- Settings: the effective configuration (secrets redacted), the OpenCode
  service aivi is connected to, module status (Discord, later Linear).

## Constraints

- Read-only first. Mutations stay with the CLI and the future agent tool until
  the authority rules in [jobs.md](jobs.md) are settled; `runs resolve` in
  particular requires a human statement that external work stopped.
- Served by the existing host listener under the existing auth
  (`host.auth`); no second server, no second credential.
- Logs need a durable sink before they can be shown: today they go to stdout.
  A ring buffer or a file under `stateDirectory` is the smallest step.
- Dream runs, jobs, schedules and leases already live in SQLite; the dashboard
  reads them through the same store, never through its own tables.
- Keep it plain: static HTML plus a few JSON routes on `/v1/…`. No frontend
  framework unless the page count makes one cheaper than the alternative.

## Prerequisites

- `Store.schedules()` reader and an outcomes-of-the-last-24h query
  (also wanted for `/status`, see [jobs.md](jobs.md) item 9).
- A dreaming run table or a stable way to list runs from the job history plus
  the transcript directory (retention policy for transcripts is open).
