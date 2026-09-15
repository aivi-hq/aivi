# Jobs: what they are, who starts them, where results go

Status: design agreed with the owner 2026-09-15; being built in the order at
the end of this page. As each part lands, its owning document (see the map in
`CONTEXT.md`) takes over the facts; this page then shrinks to what is still
unbuilt.

## What exists today

A job is one row in aivi's SQLite: a `task`, a resource pool, a state
(`queued → running → succeeded | failed | blocked`, or `cancelled`), an optional
`report`, and an audit trail. Jobs come from `schedules` in `aivi.json` (cron +
timezone + pool + task + report) and from `aivi jobs enqueue FILE`. Task kinds:
`system.check`, `knowledge.index`, `shell` (argv, cwd, timeout),
`opencode.prompt` (agent, directory, prompt, timeout, permission policy),
`dreaming`. Capacity is `scheduler.maxConcurrent` plus named pools; Discord
turns take leases from the same pools. Blocked work keeps its slot until an
operator resolves it. `report: { to, channel, on }` posts the outcome through a
module-registered destination (Discord, allow-listed by `reportChannels`);
delivery is audited and never changes the outcome.

Constraints that stay: OpenCode is the runtime (an `opencode.prompt` job is an
ordinary session); capacity is shared with interactive use; everything is
recoverable after restart and retries never create duplicates; destinations
decide whether aivi may post there.

## The agreed design

Guiding rule: OpenClaw and Hermes both grew schedulers with dozens of knobs.
aivi adopts the things every user actually hits and keeps the rest at the
current defaults.

### Vocabulary

| Word | Meaning | Where |
| --- | --- | --- |
| task | what to do: `kind` + parameters | config, CLI files, tool input |
| schedule | a recurring definition: cron + timezone + task (+ report) | `schedules[]`, `aivi schedules`, the tool |
| job | one unit of queued/running/finished work; one row, one audit trail | `aivi jobs`, status, reports |
| run | plain-English synonym for a job that came from a schedule | docs, chat |

No renames. `cron` is a field name (`cron: "0 9 * * 1"`), never a noun in
aivi's own UI.

### Two kinds of job

- **Agent job** (`opencode.prompt`): a fresh OpenCode session runs the prompt to
  a verified final answer. "Summarize my mail every morning."
- **Script job** (`shell`): a process runs, no model involved. "Delete old logs
  nightly." Argv only, never a shell string.

Both can be one-off (a job with a future `scheduled_for`, no `schedule_id`) or
recurring (a schedule). Both persist across restarts; misfires coalesce to one
run; nothing retries after the model or the process was reached.

### Who creates jobs

1. **Operator**: any task kind via `aivi.json` or the CLI. Unchanged.
2. **Any OpenCode agent** through the plugin tool `aivi_schedule`, both kinds.
   Authority is whoever may talk to that agent: Discord's user allow-list, or
   the operator in a native session (sessions without aivi metadata are the
   operator). Jobs are the admin's responsibility; the tool does not
   second-guess a script's argv.
3. **Not from a job.** A session whose `metadata.aivi.origin` is `job` is
   refused by the tool: jobs do not make jobs (Hermes' default; prevents
   runaway loops). A result re-entering a conversation (below) is a Discord
   turn, not a job, so the librarian may schedule follow-ups from there, but
   the job it came from could not.
4. No Discord slash command. The librarian with the tool covers it. Structured
   confirmation widgets are a separate idea ([discord-widgets](discord-widgets.md)).

Agent-job fields default to the *calling* agent in the *calling* directory
(derived by the host from the calling session, never trusted from input) and
may be overridden explicitly with `agent` / `directory` so the librarian can
schedule, say, a coding agent in another project.

### Destinations

A small extension of today's `report`. `on: always | failure | never` applies
to all. Config schedules keep "silent unless `report`".

| `report.to` | Agent job | Script job |
| --- | --- | --- |
| `session` (default for tool-created jobs; the asking session, resolved at create time) | the result is submitted as a queued prompt into that session; the librarian reads it and replies in its own thread, in its own words | same, with the script's output as the prompt |
| `discord` + `channel` | a new thread in the channel showing the final answer, **bound to the job's own session** so a reply continues it: the agent already knows everything it did | the output is posted as a new thread; the thread gets a session on the first reply, with the output as that turn's context, so replying works and costs nothing until someone does |
| `none` | silent; `aivi jobs show` has the result | same |

Re-entry (`to: session`) needs the origin session id on the job (it is the
`report`) and the loop guard above. If the target session or thread no longer
exists, delivery is audited as `report-failed`; the job outcome is unchanged.

Result text keeps `describeOutcome` plus one trailing line naming the OpenCode
session, cap raised to ~4000 characters, destinations split long messages
(Discord has `splitReply`). No `[SILENT]` marker: with re-entry the librarian
reading the result *is* the silence mechanism, and `on: failure` covers the
rest.

### Shell environment

A script inherits the host environment **minus the secrets aivi itself
loaded**: the keys read from `<home>/.env` plus aivi's fixed secret names
(`AIVI_TOKEN`, `DISCORD_BOT_TOKEN`, `OPENCODE_USERNAME`/`OPENCODE_PASSWORD`). An optional `env: {}` map on the task is merged on top,
so a script that genuinely needs a secret gets it on purpose. This is Hermes'
sanitized subprocess environment plus OpenClaw's per-job `--command-env`; an
allow-list was rejected because it silently breaks scripts that expect a normal
shell.

### Validation before spending

At create time and again before a run: cron parses, timezone is IANA, the agent
exists for that directory, the destination channel is in `reportChannels`, the
target session exists, the script's executable resolves. A failing check ends
the job `failed` with the reason and no session or process is started (Hermes'
`blocked_config`, kept as `failed` because nothing external happened).

### Time input

The tool accepts only validated forms: 5-field cron + IANA timezone (default
the host's), ISO 8601, or a relative duration (`30m`, `2h`, `1d`). Natural
language ("at 9", "every weekday") is the model's job at the tool boundary. The
tool answers with the next one to three occurrences in plain text so the
librarian confirms what it actually created. No natural-language parser in
aivi.

### Failures, misfires, control

- Discovery of OpenCode failing before any session exists → `failed`, not
  `blocked`; the next occurrence retries.
- After three consecutive failed runs of a recurring job, the failure report
  adds a nudge to fix, pause or remove it. One-offs never nudge.
- Optional `misfire: { skipAfterMs }` on a schedule: an occurrence older than
  that is audited as `skipped` and not enqueued (the 9:00 standup wants it;
  maintenance does not).
- Pause = `enabled: false` (config edit for config schedules;
  `aivi_schedule pause|resume` and `aivi schedules pause ID` for agent ones).
- Kill: `aivi jobs abort ID` sets `cancel_requested`; each job gets its own
  `AbortController` (`AbortSignal.any([global, perJob])`); the job ends
  `blocked` with "aborted by operator" for `jobs resolve`. Capacity is not
  released by the abort itself (agent-first step of the future cleanup
  protocol, not a replacement).
- Visibility: `/status` and `/v1/status` show the next three schedule
  occurrences and outcomes of the last 24 h; `aivi_schedule list` shows
  schedules with their last state.

### Tool shape: `aivi_schedule`

Registered by the plugin in namespace `aivi` next to `status` and `sources`.

```
input: {
  action: "create" | "list" | "pause" | "resume" | "remove" | "run",
  id?: string,                          // pause/resume/remove/run
  title?: string,                       // create: short human label
  // create: exactly one of
  prompt?: string,                      // agent job; self-contained instruction
  command?: string[],                   // script job; argv
  cwd?: string, env?: Record<string,string>, timeoutMs?: number,
  agent?: string, directory?: string,   // agent job overrides; default: the caller's
  // create: exactly one of
  at?: string,                          // one-off: ISO 8601 or "30m" | "2h" | "1d"
  cron?: string, timezone?: string,     // recurring
  report?: { to: "session" } | { to: "discord", channel: string } | { to: "none" },
  on?: "always" | "failure"             // default always
}
```

Host behaviour on `create`: look up the calling session; refuse origin `job`;
build the task with unattended defaults (`onPermission: 'reject'`, 30 min);
resolve `report.to: session` to the calling session id; run the validation
above; `at` → `enqueue` with a future due time and dedupe key
`agent:<sessionId>:<messageId>`; `cron` → insert a `source='agent'` schedule.
Audit reason `agent:<sessionId>`. Resource comes from
`scheduler.agentSchedules.resource`; `max` bounds how many agent schedules may
exist; absent config = tool answers "disabled by the operator".

This revises the "no job mutations over the API" line in `architecture.md`:
one `POST /v1/schedule` route, same auth as today, limited to what the tool
needs. Record it there as a deliberate revision when it lands.

## Order of work

Each step is one commit, tested at the boundary it changes.

1. Shell env: strip aivi's secrets, task `env` map. (`runtime.ts`, config)
2. Store: `source` on schedules, `Store.schedules()`, one-off `--at` on
   `aivi jobs enqueue`, `cancel_requested`. Schema v5.
3. `to: session` re-entry as a Discord turn; loop guard; result text with the
   session line and higher cap.
4. `POST /v1/schedule`, `aivi_schedule`, `scheduler.agentSchedules`,
   validation before spending, `architecture.md` revision.
5. `to: discord` thread binding for agent jobs; first-reply context for script
   jobs. Live Discord gate.
6. Failure nudge, `misfire.skipAfterMs`, `/status` lists, `jobs abort`.

Live gates: OpenCode for 3–4, Discord for 3 and 5.

## Deferred until someone asks twice

Standing sessions per schedule (memory across runs belongs in files; if ever
wanted, `session: "standing"` with a session id derived from the schedule id
and OpenCode's inbox for ordering). Retries after the model was reached.
Digests and a "home channel". Executable allow-lists. Natural-language time
parsing in aivi. Widgets ([discord-widgets](discord-widgets.md)).

## Research notes (2026-09-14/15, official docs only)

- **Hermes** (`cronjob` tool, `/cron`, `hermes cron`): one tool with
  `create|list|update|pause|resume|run|remove`; fresh session per run;
  `deliver: origin` resolved at create time; `[SILENT]` marker; delivery
  failure is a distinct status; scheduled agents cannot use `cronjob` unless
  opted in; scripts under `$HERMES_HOME/scripts/` with a sanitized environment
  (no provider secrets); `mirror_delivery` makes a delivery continuable by
  seeding it into a thread's session (the pain this design's thread binding
  removes); `blocked_config` preflight; failure streak nudge at 3; catch-up
  collapses to one run. <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>,
  <https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals>.
- **OpenClaw** (Automations): payloads `system-event | message | command |
  script`; command payloads are operator-admin only with `--command-argv`,
  `--command-env KEY=VALUE`, `--command-cwd`, timeout and output caps;
  sessions `main | isolated | current | session:<id>`; unattended-run contract
  with `NO_REPLY` as the silent token; jobs created by an agent are capped to
  that turn's tools. <https://docs.openclaw.ai/automation/cron-jobs>,
  <https://docs.openclaw.ai/automation/cron-jobs/payloads>.
- **OpenCode v2**: no scheduler or timer concept; `session.prompt` with
  `delivery: queue` is a durable per-session inbox (aivi's `runTurn` already
  uses it); events are live-only. Conclusion: OpenCode owns per-session
  ordering, nobody owns time or cross-session capacity; the host keeps
  schedules, the queue and leases.
