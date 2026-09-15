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

## Research

Researched 2026-09-14 from official docs only. Sub-pages not fetched are
marked as such; nothing below is inferred from source code of other projects.

### OpenClaw ("Automations", `openclaw cron` is an alias)

Sources: <https://docs.openclaw.ai/automation>, <https://docs.openclaw.ai/automation/cron-jobs>.

- Definition: CLI (`openclaw automations create <ISO-time> --name … --session main
  --system-event … --wake now --delete-after-run`), conversational management by
  the agent, and inbound webhooks (`POST /hooks/agent`). Jobs are persisted by the
  Gateway scheduler.
- Schedule kinds: one-shot (`--at`/ISO), interval, cron expression; also event
  triggers ("condition watchers"), dynamic pacing, and a `/loop` chat shortcut.
  Docs mention DOM/DOW OR-logic and a "timezone gotchas" page.
- Session context per job: isolated (fresh), current, named, or main session.
  Isolated runs create a record in a separate "Background Tasks" ledger
  (`openclaw tasks list|audit`); main-session runs do not. Run history:
  `openclaw automations runs <id>`.
- Delivery: chat channel, webhook, or nowhere; a "failure notifications" section
  exists (not fetched). Model/thinking/tools can be overridden per job.
- Overlap: the system-owned Heartbeat (30-min default, main session) "defer[s]
  while the main queue or automation work is busy, another run for the same
  agent is active, or the target session has active or queued work". A
  "retry behavior" section exists under managing-jobs (not fetched).
- Notable decision: the "inferred commitments" experiment (extracting follow-ups
  from conversations) was removed in v2026.8.1; reminders must be explicit
  automations.

### Hermes Agent (`cronjob` tool, `/cron`, `hermes cron`)

Sources: <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>,
<https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals>.

- Definition: one agent tool with actions `create|list|update|pause|resume|run|remove`;
  the same operations as `/cron …` in chat and `hermes cron …` on the CLI.
  Natural-language requests ("every morning at 9am…") go through the tool.
  Jobs live in `~/.hermes/cron/jobs.json`; attempts in `executions.db`
  (`claimed → running → completed|failed|unknown`; `unknown` is never rerun).
- Schedule formats: relative one-shot (`in 30m`), interval (`every 2h`),
  natural day/time recurring (`every monday 9am`, `weekdays at 9am`, compiled to
  cron), cron expressions, ISO timestamps (one-shot). Optional `repeat=N`.
- Session: always a fresh agent session, no memory; `workdir` binds it to a
  repo; `context_from`/`continuity` prepend a previous run's output as text.
- Delivery: `origin` (chat where it was created) is the default on messaging
  platforms, `local` file on the CLI; also platform home channel, explicit
  `platform:chat[:thread]`, `all`. The agent's final answer is delivered by the
  scheduler, the agent does not send messages. `[SILENT]` in a successful answer
  suppresses delivery; failures always deliver. Delivery failure is a distinct
  status (`delivery_failed`) and does not count as a job failure. Output is
  wrapped with a "Cronjob Response: <name>" header by default.
- Misfires: gateway ticks every 60 s. Down-time collapses to one catch-up run
  (`catch_up_missed: true`); the opt-out re-anchors to the next future slot
  after a grace window of half the period (clamped 120 s–2 h). Paused jobs
  never catch up.
- Retries: only when a run failed with a transient network/DNS error before any
  model call (5/15/30 min ladder, "spend-neutral, cannot duplicate any side
  effect"). Otherwise none. A `failure_streak` of 3 adds a review nudge;
  incidents can be acknowledged to silence repeat pings.
- Overlap: a tick file lock, an in-flight guard per job ("already running" is
  refused rather than double-fired), `cron.max_parallel_jobs`.
- Authority: agents launched by the scheduler cannot use `cronjob` unless
  `allow_agent_scheduling: true`; model/reasoning pins are user-owned and not on
  the tool; `deliver: origin` is resolved to a concrete target at create time;
  preflight validation marks a misconfigured job `blocked_config` with one alert
  and no model call. Scripts must live under `$HERMES_HOME/scripts/` and run with
  a sanitized environment (no provider secrets).
- Pause/resume exist, including create-paused canaries; pausing is documented as
  "not a security boundary against an operator who can run jobs".

### OpenCode v2 itself

Sources: <https://opencode.ai/v2/docs/build/client/>,
<https://opencode.ai/v2/docs/api/session/v2-session-inbox-list>,
<https://opencode.ai/v2/docs/api/session/v2-session-background>,
API summary of `POST /api/session/{id}/prompt` as indexed at
<https://opencode.ai/v2/docs/api/session/v2-session-prompt>.

- No scheduler, cron, timer, or "run later" concept exists in the v2 docs.
- `session.prompt` "durably admit[s] one session input and schedule[s]
  agent-loop execution"; a session has a durable **inbox** of enqueued work with
  `delivery: steer | queue` (`GET /api/session/{id}/inbox`, plus endpoints to
  requeue steered items). aivi's `runTurn` already prompts with
  `delivery: 'queue'` (`packages/host/src/session.ts:109`).
- `POST /api/session/{id}/background` moves *backgroundable tools* of a running
  turn into background observation. It is about tool execution, not background
  sessions or queued prompts.
- Events (`client.event.subscribe()`) are live-only: no replay, no automatic
  reconnection. They cannot serve as a durable trigger source.
- `Service.discover()` returns the registered local endpoint; `Service.ensure()`
  can start one. aivi already uses discovery.

Conclusion: OpenCode owns *per-session* ordering and durability of prompts;
nobody owns *time* or *cross-session capacity*. The host should keep owning
schedules, the job queue, and leases, and should not build a per-session queue
of its own (use the inbox when a standing session is ever wanted).

## Recommendation

Guiding rule: OpenClaw and Hermes both grew a scheduler with dozens of knobs;
aivi should adopt the three things every user actually hits (create from chat,
one-off at a time, results back to where I asked) and keep everything else as
the current defaults.

### Vocabulary

| Word | Meaning | Where it appears |
| --- | --- | --- |
| task | what to do: `kind` + parameters (`taskSchema`) | config, CLI files, tool input |
| schedule | a recurring definition: cron + timezone + task (+ report) | `schedules[]`, `aivi schedules`, `aivi_schedule` |
| job | one unit of queued/running/finished work, one row, one audit trail | `aivi jobs`, status, reports |
| run | plain-English synonym for a job that came from a schedule; not a table | docs, chat |

Do not rename tables or CLI groups. In chat the librarian may say "scheduled
task" or "reminder"; both map onto these nouns. Accept "cron" as the field name
only (`cron: "0 9 * * 1"`), never as a noun in aivi's own UI.

### The ten questions

1. **Vocabulary.** As above. Smallest change: a glossary paragraph in
   `configuration.md`; no code.
2. **Who may create jobs.** Three tiers, one rule each. (a) Operator: any task
   kind via `aivi.json` or CLI (unchanged). (b) Agent tool `aivi_schedule`:
   only `opencode.prompt` tasks that run the *caller's own agent in the caller's
   own directory*; the host derives both from the calling session
   (`client.session.get`), never from tool input. Refused when the calling
   session's `metadata.aivi.origin` is `job` (Hermes' default, prevents runaway
   loops). Sessions without aivi metadata are native interactive sessions, i.e.
   the operator: allowed. (c) No Discord slash command: the librarian with the
   tool covers it and the Discord access policy already decides who is heard.
   Opt-in config: `scheduler.agentSchedules: { resource: "local-model", max: 20 }`
   (absent = tool answers "disabled by the operator"). Smallest change: one
   `POST /v1/schedule` route (auth as today), one plugin tool, a `source`
   column on `schedules` so `syncSchedules` only reconciles `source='config'`
   rows (schema v5). This intentionally revises the "no job mutations over the
   API" line in `architecture.md`; keep it limited to this one task kind.
3. **One-off vs recurring.** A one-off is a job with a future `scheduled_for`
   and no `schedule_id`; `Store.insert` already takes `due` and `claim` already
   filters `scheduled_for<=now`. Add `--at` to `aivi jobs enqueue` and `at` to
   the tool. Accept ISO 8601 and relative durations (`30m`, `2h`, `1d`) only;
   natural language is the model's job at the tool boundary, exactly as Hermes
   and OpenClaw do. No `--delete-after-run`: a one-off job simply finishes.
4. **Default destination.** Config schedules: silent unless `report` (keep).
   CLI one-offs: silent, `jobs show` has the result (keep). Agent-created:
   `origin`, resolved *at create time* to the creating session's Discord
   channel and stored as an ordinary `report`; if that channel is not in
   `reportChannels` the job is created with `report: null` and the tool says so.
   No "home channel" concept and no digest yet: `on: "failure"` plus the
   `[SILENT]` marker below cover the noise problem for now.
5. **Result shape.** Chat text (current `describeOutcome`) plus one trailing
   line `session ses_aivi_… in OpenCode` so long answers are one click away;
   raise the cap to ~4000 chars and let the destination split (Discord already
   has `splitReply`). Adopt Hermes' marker: an `opencode.prompt` answer that is
   exactly `[SILENT]` succeeds without delivery (`shouldReport` change, three
   lines). No files or attachments; the native transcript is the file.
6. **Retries and misfires.** Keep coalesce and keep "no retry after the model
   was reached". Two small additions: (a) if `deps.opencode()` rejects before
   any session was created, return `failed` instead of `blocked`; nothing
   external happened and the next occurrence will try again (this is Hermes'
   only automatic-retry case, stated more conservatively). (b) optional
   `misfire: { skipAfterMs }` on a schedule: in `materializeDue`, an occurrence
   older than that is recorded as `skipped` in the audit and not enqueued. The
   9:00 standup sets `skipAfterMs: 1800000`; maintenance leaves it unset.
7. **Job-created sessions.** Fresh per run stays the default and the only mode
   for now; Hermes and OpenClaw isolated jobs agree. Memory across runs belongs
   in files (dreaming's cursor and `facts.md` are the pattern), not in a
   growing transcript. If a standing session is ever wanted, it is
   `session: "standing"` on the task, a session ID derived from the schedule
   ID, and OpenCode's inbox (`delivery: 'queue'`) does the ordering. Defer.
8. **Shell task safety.** "Operator wrote it in config" is enough for *who*;
   fix *what it sees*: `execFile` currently inherits the whole host environment,
   including `AIVI_TOKEN` and `DISCORD_BOT_TOKEN`. Pass an explicit `env` of
   `PATH, HOME, LANG, TZ` plus an optional `env: {}` map on the task. No
   executable allow-list. `shell` is never reachable through the agent tool.
9. **Visibility.** Add to `/status` (and to `/v1/status` for `aivi_status`) two
   compact lists: next three schedule occurrences (`schedules.next_at`, needs a
   `Store.schedules()` reader, missing today) and outcomes of the last 24 h.
   `aivi_schedule list` shows the caller's own schedules and their last state.
10. **Pause/resume/kill.** Pause = `enabled: false`; for config schedules that
    is a config edit (queued occurrences are already cancelled by
    `syncSchedules`), for agent schedules it is `aivi_schedule pause|resume`
    and `aivi schedules pause ID`. Kill: `aivi jobs abort ID` sets a
    `cancel_requested` flag; the scheduler gives each job its own
    `AbortController` (`AbortSignal.any([global, perJob])`) so the running turn
    stops, and the job ends `blocked` with reason "aborted by operator" for
    `jobs resolve`. Capacity is never released by the abort itself, which is the
    agent-first step of the future cleanup protocol, not a replacement for it.

### Tool shape: `aivi_schedule`

Registered by the plugin in namespace `aivi` next to `status` and `sources`.

```
input: {
  action: "create" | "list" | "pause" | "resume" | "remove" | "run",
  id?: string,                 // for pause/resume/remove/run
  prompt?: string,             // create: the instruction, self-contained
  title?: string,              // create: short human label
  at?: string,                 // create one-off: ISO 8601 or "30m" | "2h" | "1d"
  cron?: string, timezone?: string,   // create recurring (IANA tz, default from host)
  report?: "origin" | "none"   // default origin
}
```

Host behaviour on `create`: look up the calling session; refuse origin `job`;
build `{ kind: 'opencode.prompt', agent, directory, prompt }` with the
unattended defaults (`onPermission: 'reject'`, 30 min timeout); resource from
`agentSchedules.resource`; enforce `max`; `at` → `enqueue` with a future due
time and dedupe key `agent:<sessionId>:<messageId>`; `cron` → insert a
`source='agent'` schedule. Audit reason `agent:<sessionId>`. The tool never
accepts `agent`, `directory`, `resource`, `timeoutMs`, `onPermission`, or any
other task kind; those stay operator-owned, as Hermes keeps model pins
user-owned.

### Order of work

1. Store: `scheduled_for` on enqueue, `source` on schedules, `Store.schedules()`,
   `cancel_requested`; `env` for shell; `[SILENT]`; session line in reports.
2. `POST /v1/schedule` + `aivi_schedule` + `agentSchedules` config; `--at`.
3. `/status` lists; `misfire.skipAfterMs`; `jobs abort`.
Everything else on this page is deferred until someone asks for it twice.
