# Jobs: what they are, who starts them, where results go

Status: design discussion wanted before this grows. The owner has opinions.

## What exists today

A job is one row in aivi's SQLite: a `task`, a resource pool, a state
(`queued → running → succeeded | failed | blocked`, or `cancelled`), an optional
`report`, and an audit trail. Sources of jobs:

- `schedules` in `aivi.json`: cron + timezone + pool + task (+ report).
- `aivi jobs enqueue FILE` with a dedupe key.
- Nothing else yet (no Discord command, no webhook, no agent tool).

Task kinds: `system.check`, `knowledge.index`, `shell` (argv, cwd, timeout),
`opencode.prompt` (agent, directory, prompt, timeout, permission policy).

Capacity: `scheduler.maxConcurrent` plus named pools (`local-model`,
`maintenance`, …). Discord turns take leases from the same pools. Blocked work
keeps its slot until an operator resolves it.

Reporting: `report: { to, channel, on }`; a module registers itself as a
destination (Discord: `reportChannels` allow-list). Delivery is audited and does
not change the outcome.

## Questions to settle

1. **Vocabulary.** "Job", "task", "schedule", "run" — which words do we want in
   config, CLI, and chat? Hermes/OpenClaw users may expect "cron" and "tasks".
2. **Who may create jobs.** Operator CLI only? An agent tool (`aivi_schedule`)
   so the librarian can set up "remind me every Monday"? A Discord command?
   Each needs an authority rule; a Discord user asking for a shell task is not
   the same as the operator writing one into `aivi.json`.
3. **One-off vs recurring.** Today one-offs are files. Should there be
   `aivi jobs run "prompt" --agent x --at "tomorrow 9:00"`, and natural-language
   times at all?
4. **Where results go by default.** Silent unless asked (current)? Back to the
   channel that created the job? Always to a "home" channel? What about a
   digest instead of one message per job?
5. **Result shape.** Chat message vs. file vs. both. Long agent answers,
   attachments, links to the native session.
6. **Retries and misfires.** Currently no retries; missed schedules coalesce to
   one run. Is that what people expect for "post the standup at 9:00"?
7. **Job-created sessions.** Should `opencode.prompt` jobs continue a standing
   session per schedule (memory across runs) or always start fresh (current)?
8. **Shell task safety.** argv-only, no shell. Do we want an allow-list of
   executables, an env allow-list, or is "operator wrote it in config" enough?
9. **Visibility.** `/status` in Discord shows conversation turns only. Should
   people see upcoming schedules and recent outcomes there?
10. **Pause/resume/kill.** Pausing a schedule, cancelling a running job (today
    only queued jobs can be cancelled), and how that ties into the future
    worker-cleanup protocol.

## Constraints already decided

- Keep OpenCode as the runtime: an `opencode.prompt` job is an ordinary session.
- Capacity is shared with interactive use; queued work waits, never overlaps.
- Everything recoverable after restart; duplicates never created by retries.
- Destinations decide whether aivi may post there.
