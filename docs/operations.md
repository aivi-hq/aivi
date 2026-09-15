# Operations

For whoever runs `aivi serve`: what happens at startup and shutdown, what a
tick does, how runs end, and what to do when work is blocked. Configuration
fields are in [configuration](configuration.md); the reasons behind the
behaviour are in [architecture](architecture.md).

## Startup

Startup validates the auth mode and token first (so a missing `AIVI_TOKEN`
never launches QMD or Chrome), acquires installation ownership, initializes
shared services, reconciles the job definitions it owns (`jobs[]` from
`aivi.json` and the system job `retention` seeded from `scheduler.retention`;
`Store.syncJobs`), refreshes the search index when configured, opens the API on
`host.bind:host.port`, then starts modules in order and announces readiness
once each has had its first attempt. From then on the loop sleeps until the
next due instant and wakes early when something changes the queue
(`HostServices.wake`, `POST /v1/wake` from the CLI, a run or turn releasing
capacity). Nothing periodic exists. `aivi tick` runs
the same lifecycle in one-shot mode: no API, no modules (and no token needed),
one dispatch round, drain, exit.

A module whose start fails does not take the host down (live finding
2026-09-15: a chat platform answered 503 during startup and the knowledge
server and scheduler died with it). The `ModuleSupervisor` retries the start
in the background with exponential backoff, 1 s doubling to a 10 minute cap,
for as long as the host runs, and `/v1/status` lists every module as
`starting`, `running`, `degraded` (with its last error and next retry) or
`stopped`. Readiness never waits for a retry; the API, the scheduler and the
other modules run meanwhile. Only a `ConfigurationError` is fatal: a missing
token, a token Discord or Slack rejects, an application id that does not match.
Modules throw it for what the operator has to change; everything else is
assumed transient.

OpenCode runs as its own background service; aivi discovers it through the SDK's
service registration at the start of each job or conversation turn (one file
read), so an `opencode service restart` is picked up by the next turn. With
`opencode.lifecycle: "own"` (default) `aivi serve` restarts a running service
once at startup and starts a missing one whenever needed, handing it
`AIVI_TOKEN`; `ensure` only starts, `discover` never touches it. aivi never
manages OpenCode's installation. QMD uses its
library API inside aivi, with no QMD server or separate launch command. Only the
configured Discord module loads discord.js, only the configured Slack module
loads the Slack SDK, and only enabled search loads QMD. A configured browser
service is created after installation ownership is acquired; its MCP/Chrome
processes start on first use and stop with the host ([browser](browser.md)).

`aivi serve` logs one JSON object per line on stderr; `--log-level debug` shows
job materialization. stdout is reserved for command output.

## Tick

Each tick first materializes due job occurrences into runs. An occurrence
found later than its misfire grace (`scheduler.misfire.graceSeconds`, per-job
`misfire`) is recorded as one `missed` run for the whole gap and reported like
a failure; nothing is executed for it and the job moves to its next future
occurrence ([configuration](configuration.md#jobs-runs-tasks)). Then the tick
claims queued runs within capacity and executes them.

## How runs end

Run outcomes distinguish "nothing happened" from "unknown": OpenCode not
reachable or a command that cannot start ends `failed`, and the next occurrence
simply tries again; anything after the first request or after the process
started ends `blocked` when it cannot be verified. For an agent turn that means:
a failure before the prompt is accepted (OpenCode unreachable, session
create/get rejected) is `failed`; a timeout, a failed turn, a changed
agent/directory, or a host shutdown mid-turn is `blocked`, because none of
those prove the session stopped doing things. Blocked runs keep their capacity
until an operator has looked at the session:

```sh
npm run aivi -- runs show RUN_ID       # task, session id, result, transition history
npm run aivi -- runs resolve RUN_ID --outcome succeeded --reason "Inspected completed session" --confirm-stopped
```

Failed runs do not retry automatically; the next occurrence does.

Retention is a job like any other: `retention` (source `system`, task
`runs.prune`) runs through the queue in its pool, appears in `aivi jobs list`
and `/status`, and deletes finished runs with their audit rows and finished
one-off definitions older than `olderThanDays`; blocked runs, active work and
recurring definitions are never pruned. `scheduler.retention: false` removes
the job at the next startup.

## Shutdown

Shutdown stops dispatch and aborts running runs at once: a shell command gets
`SIGTERM`, an agent turn stops waiting. Each interrupted run ends `blocked` with
the reason "Host stopped …" and keeps its capacity, because aivi cannot know
what the external side had already done; `aivi runs resolve` releases it after a
look. `aivi runs abort ID` does the same to one run while the host keeps
running (reason "Aborted by operator"); every run has its own abort signal
combined with the host's. Modules are then stopped in reverse startup order, the aborted runs are
awaited so their outcomes are recorded and reported, HTTP requests finish, the
browser/MCP and QMD close, and ownership is released. A grace period that lets
work finish first is a design choice not yet made
([shutdown-hooks](backlog/shutdown-hooks.md)).

A conversation turn interrupted by the shutdown is the one exception to
"blocked": its only external effect is the reply, so it is discarded and the
person is told aivi is going offline and to send the message again; waiting
conversations hear that their messages stay queued
([channels](channels.md#feedback-and-recovery-shared)).

## Blocked conversation turns

Chat turns take leases from the same pools as runs. A turn that could not be
finished blocks its lease until you have inspected the native session:

```sh
npm run aivi -- discord status
npm run aivi -- discord resolve TURN_ID --confirm-stopped --reason "Inspected native session and Discord delivery; no owned work remains"
npm run aivi -- slack status
npm run aivi -- slack resolve TURN_ID --confirm-stopped --reason "…"
```

Resolution discards that blocked turn and releases capacity. It does not stop the
native session or resend a reply. Inspect/stop native work first. Queued messages
can then continue in the same session. Platform-specific parameters (id
formats, reply splitting, binding rotation) are in [discord](discord.md#queue-and-recovery)
and [slack](slack.md#queue-and-recovery).

## Jobs and runs from the command line

Run `npm run aivi -- --help` for commands. `jobs …` act on definitions,
`runs …` on executions.

`jobs add FILE` adds a job from a task file (a bare task, or
`{ task, report?, resource? }`): `--cron EXPR --timezone TZ` makes it
recurring, `--at ISO|30m|2h|1d` a one-off for later, neither a one-off for
now, whose run is queued at once. `--title` labels it, `--resource` picks the
pool, `--key` deduplicates identical requests (a changed payload under the
same key is rejected). Operator jobs (source `operator`, ids `job-…`) and
agent jobs are paused, resumed and removed with `jobs pause|resume|remove ID`;
configured and system ones are edited in `aivi.json`. `jobs run ID` queues one
run now, refused while one is outstanding. `jobs list` shows every definition
with its source, state, next occurrence and last run; `jobs show ID` adds its
runs.

`runs list [--job ID --state S --limit N]` and `runs show ID` (task, session
ID, result, transition history). `runs cancel ID` only cancels queued work.
`runs abort ID` asks the scheduler to stop a running run; the run then ends
`blocked` and keeps its capacity until `runs resolve`, as above.

The CLI writes to SQLite directly and pokes the running host (`POST /v1/wake`)
so it dispatches without waiting; when the host is not reachable the command
says so and the change takes effect at the next dispatch.

## Projects

`aivi projects list|add|remove|purge` manage the checkouts under
`<home>/projects` ([projects](projects.md#adding-listing-renaming-removing)).
The host reads that directory at startup, so restart `aivi serve` after adding
or removing one.
