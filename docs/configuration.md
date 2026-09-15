# Configuration

## Home

aivi reads one directory, the **home**: `~/.aivi` by default, or `AIVI_HOME`.
It holds `aivi.json`, `.env`, and `state/` (SQLite, the search index, dreaming
transcripts). There is no config-path option. If `aivi.local.json` exists in
the home it is used instead of `aivi.json`; `*.local.json` is git-ignored, so a
checked-in home such as `example/` can carry a private setup beside the public
one. In this repository `npm run aivi` sets `AIVI_HOME=example`; that home has
every feature enabled, so `serve` needs `DISCORD_BOT_TOKEN` and the two Slack
tokens in `example/.env` unless the `modules.discord` and `modules.slack`
blocks are removed.

`aivi.json` is installation configuration and describes the projects too; a
project's checkout carries nothing of aivi's ([projects](projects.md)).
OpenCode's own files stay in their native locations.
Unknown fields and invalid combinations fail validation; nothing silently falls
back to another project or resource pool.

Paths in installation config and in task files resolve relative to the home.
Project source paths resolve relative to the checkout, `<home>/projects/<id>`.
The home is also the OpenCode location: agents live in `<home>/.opencode/agents/`.

## Fields

| Field | Default / purpose |
| --- | --- |
| `version` | Required; `1` |
| `stateDirectory` | `state` inside the home |
| `host.bind` | `127.0.0.1`. Use a LAN/tailnet address or `0.0.0.0` so remote OpenCode installs can reach the knowledge server |
| `host.port` | `4100` |
| `host.auth.mode` | `token` (default): callers send `AIVI_TOKEN` as a bearer token. `none`: trust the network (loopback, Tailscale, LAN you control) |
| `opencode.url` | Omit to discover the local `opencode service` automatically (recommended). Set only for a server elsewhere; then `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` supply its basic-auth credentials |
| `opencode.lifecycle` | How much of the local service aivi owns. `own` (default): at `aivi serve` startup a running service is replaced by a fresh one (persistent terminals handed off) and a missing one is started, always with `AIVI_TOKEN` in its environment, so a new plugin build is live and the plugin can authenticate. `ensure`: only start when missing. `discover`: never start or stop (the example home uses this so tests never touch a developer's OpenCode). Ignored with `opencode.url` |
| `knowledge` | Core sources, each `{id, path, kind?}`; kinds: `doc` (default), `decision`, `memory`, `conversation`. `<home>/memory` is added as the core `memory` source automatically; that id is reserved |
| `projectDefaults.knowledge` | The repository convention every project gets unless it lists its own; default `docs` (`doc`) and `docs/adr` (`decision`). A file belongs to its most specific source ([projects](projects.md)) |
| `projects` | Object keyed by project id; each value `{knowledge?, linear?}`. The checkout must exist at `<home>/projects/<id>`; `<home>/memory/<id>` is its `memory` source |
| `modules.discord.config` | Optional path to Discord module settings ([discord](discord.md)) |
| `modules.slack.config` | Optional path to Slack module settings ([slack](slack.md)) |
| `browser` | On by default: aivi launches its own Chrome with a profile in `state/chrome` on first use. `false` disables it; an object selects another mode or limits; see [browser setup](browser.md) |
| `search` | Optional `{provider: "qmd", indexOnStart: true, maxPending: 32}` |
| `scheduler.maxConcurrent` | `1`; counts running and blocked runs |
| `scheduler.resources` | `{"local-model": 1}`; named pool limits |
| `scheduler.agentSchedules` | On by default as `{ "resource": "local-model", "max": 50 }`: any OpenCode agent with the plugin creates jobs through `aivi_jobs`, run in that pool, at most `max` agent jobs (recurring, or one-offs not yet fired) at once. `false` disables the tool; a custom pool set must name one of its pools here or disable |
| `scheduler.misfire.graceSeconds` | `60`. An occurrence found later than this (aivi was not running) is recorded as one `missed` run per job and never executed; see [Jobs, runs, tasks](#jobs-runs-tasks). A large value means "run whenever" |
| `scheduler.retention` | `{ "cron": "0 4 * * *", "timezone": <host>, "olderThanDays": 30, "resource": "local-model" }`: the host seeds a system job `retention` (task `runs.prune`) that deletes finished runs and finished one-off jobs older than that. `resource` defaults to `local-model`, or the first pool when that does not exist. `false` removes the job. `example/aivi.json` writes the default out explicitly, in its `maintenance` pool |
| `jobs` | Empty; job definitions, each `id`, `task`, and either `cron` + `timezone` (recurring) or `at` (an ISO 8601 instant; one-off), with optional `title`, `resource` (`local-model`), `report`, `enabled` (default `true`) and `misfire.graceSeconds` (per-job override). The id `retention` is reserved while `scheduler.retention` is on |

## Tasks

| Kind | Fields | Outcome |
| --- | --- | --- |
| `system.check` | – | Reports whether every knowledge source path exists |
| `knowledge.index` | – | Refreshes the search index |
| `runs.prune` | `olderThanDays` (≥ 1) | Deletes runs that ended `succeeded`, `failed`, `cancelled` or `missed` before that, with their audit rows, then the `done`/`missed` one-off jobs that have no runs left. Blocked and active runs and recurring jobs are never touched. The host seeds one such job from `scheduler.retention` |
| `shell` | `command` (argv array, never a shell string), `cwd`, `env` (merged over the inherited environment), `timeoutMs` (10 min) | Exit 0 succeeds, other exits fail, a timeout blocks; stdout/stderr tails are kept. The process inherits the host environment minus aivi's secrets (`AIVI_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_*_TOKEN`, `OPENCODE_*`, and every key of `<home>/.env`); set a secret in `env` on purpose if a script needs it |
| `opencode.prompt` | `agent`, `directory`, `prompt`, `timeoutMs` (30 min), `onPermission` (`reject`/`fail`) | Runs one agent turn to a verified answer; see [OpenCode integration](opencode.md) |
| `dreaming` | `memoryDirectory` (`memory`, the org memory in the home), `agent` (`dreamer`), `directory` (the home), `origins` (`["discord"]`; add `slack` for Slack conversations), `maxSessions`, `timeoutMs` | Reviews conversations since the last run and maintains memory files; see [dreaming](dreaming.md) |

## Jobs, runs, tasks

A **task** is what to do: `kind` plus parameters (the table above). A **job**
is a definition: a task plus *when*, either recurring (`cron` + `timezone`) or
one-off (`at`), with an `id`, optional `title`, a `resource` pool, an optional
`report`, `misfire`, and `enabled`. A **run** is one execution of a job:
`queued → running → succeeded | failed | blocked`, or `cancelled`, or
`missed`; one row, one audit trail, and always a `jobId`. The run snapshots
the job's task when it is created, so editing a definition never changes a
queued run.

Every job has a `source`: `config` (this file), `system` (seeded by the host
from `scheduler.retention`), `agent` (created through `aivi_jobs`) or
`operator` (created with `aivi jobs add`). Startup reconciles `config` and
`system` jobs against the settings: unchanged definitions keep their next
occurrence, changed ones cancel their queued run and start from the next
future occurrence, a `config` job that disappeared is paused, a `system` job
that disappeared is removed. Agent and operator jobs are never touched by
that; they are paused, resumed and removed through the tool or the CLI.
Config changes require a host restart.

A job's own state is `active`, `paused`, or, for one-offs only, `done` (its
run has finished, been cancelled, or been resolved) or `missed`. Recurring
jobs have one outstanding run at a time: an occurrence that arrives while a
run is still queued, running or blocked is skipped.

**Misfire: it matched or it didn't.** When a due occurrence is materialized,
`now - due` is compared with the job's `misfire.graceSeconds` (default
`scheduler.misfire.graceSeconds`, 60). Within the grace the run is queued as
usual. Beyond it a run is recorded in the terminal state `missed`, never
executed, with the reason `missed: aivi was not running at <time>`; the job
advances to its next future occurrence (a one-off becomes `missed`). Downtime
therefore produces one `missed` run per job for the whole gap, not one per
missed minute, and the job's report fires for it like a failure. A time-bound
job (a 9:00 standup) needs nothing special; a job that should run whenever
aivi is back (a nightly index) sets a large grace.

A one-off created for "now" (`aivi jobs add` without `--at`, `knowledge
index`) is materialized at creation and waits only for capacity.

## Reporting

Any job, including a task file passed to `jobs add` as
`{ "task": …, "report": …, "resource"?: … }`, may carry a `report`.
Delivery success or failure is recorded in the run's audit history and never
changes the run's outcome. `on` is `"always"` (default), `"failure"` (failed,
blocked and missed) or `"never"`. Two shapes exist:

- **A channel**: `{ "to": "channel", "module": "discord", "channel": "<id>", "on": … }`.
  `module` names a running channel module ([channels](channels.md)), `channel`
  is that platform's own identifier. The module decides whether aivi may post
  there (`reportChannels` in its config) and how: Discord opens a thread that
  continues the run's session, so replying to an outcome talks to the agent
  that produced it ([discord](discord.md#setup)). See `example/tasks/shell.json`.
- **A session**: `{ "to": "session", "session": "<OpenCode session id>", "on": … }`.
  The outcome is not posted as text; it is submitted as a prompt into that
  session so the agent there reads it and answers in its own words. A session a
  channel module owns (a Discord thread) receives it as an ordinary turn, in
  order with the people talking there, replied to in the thread. Any other
  session gets it queued into its native inbox. This is the default for jobs an
  agent creates from a conversation.

The text is the run outcome (`describeOutcome`, up to 4000 characters, split
by the destination), headed by the job id, and, for agent jobs, one trailing
line naming the OpenCode session. A job that has failed three times in a row
says so in its failure report; missed runs do not count towards that.

## Agent-created jobs

Every OpenCode agent that has the aivi plugin gets `aivi_jobs` (unless
`scheduler.agentSchedules` is `false`): create, list, pause, resume, remove
and run. A
person asks in chat ("every Monday at 9, summarize last week"; "in two hours,
remind me"; "clean the logs nightly with this script"), the agent translates the
time into cron, ISO 8601 or a duration (`30m`, `2h`, `1d`) and calls the tool.
The host answers with the parsed job and its next occurrences so the agent
can confirm what it made. `list` shows recurring and one-off jobs uniformly:
`title`, `when`, `state`, `next`, `lastRun`.

Two kinds of job: an **agent job** (`prompt`) runs a fresh session of the
calling agent in the calling directory, both read from the calling session in
OpenCode and never trusted from tool input; `agent` and `directory` may
override them explicitly. A **script job** (`command`, argv) runs a process
with the sanitized environment above, in the session's directory unless `cwd`
says otherwise. Both can be one-off (`at`) or recurring (`cron` + `timezone`,
default the host's).

Results default to `report: "session"`: the outcome comes back into the asking
session as a turn (see Reporting), so the agent tells the person in the thread.
`channel` posts a new thread to `channel` on the platform `module`. Both
default to the asking conversation: its platform, and the channel it lives in
(a thread's parent, a DM itself), so "post it to this channel" needs no ids;
from a native session both must be named. The channel must be in that module's
`reportChannels`. `none` keeps quiet. Only failures with `on: "failure"`
(live finding 2026-09-15: the model never sees channel ids, so a required
`channel` made "post it here" impossible).

Authority is whoever may talk to the agent (Discord's access policy, or the
operator in a native session). Jobs do not create jobs: a session whose origin
is `job` or `dreaming` is refused, unless a conversation module has adopted it.
Before anything is created the host checks the session exists, the agent exists
in that directory, the cron and timezone parse, the report can be delivered,
and the `max` limit; a failing check is refused with the reason and nothing is
spent. Agent-created jobs have ids `agent-…` and source `agent`; `aivi jobs
list` shows them beside the configured ones.

## Linear mapping (validation only)

Installation config maps each application key to one unique OpenCode agent:

```json
{ "linear": { "applications": { "dev-app": { "agent": "dev" } } } }
```

The project entry selects applications by lane:

```json
{
  "projects": {
    "website": {
      "linear": {
        "workspaceId": "linear-workspace-id",
        "projectId": "linear-project-id",
        "lanes": { "Development": "dev-app", "Review": "dev-app" }
      }
    }
  }
}
```

Multiple lanes can reuse `dev-app`. Another application cannot also map to `dev`.
Global/project OpenCode configuration still resolves the agent named `dev`.
These application keys are configuration references; OAuth credentials and native
application installation details belong to the future Linear adapter.

## Operator commands

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
`runs abort ID` asks the scheduler to stop a running run (the command gets
`SIGTERM`, an agent turn stops waiting); the run then ends `blocked` with
"Aborted by operator" because aivi cannot know what the external side had
already done, and keeps its capacity until `runs resolve`. Resolving a blocked
run is an explicit operator action described in [OpenCode setup](opencode.md).
Failed runs do not retry automatically.

## Secrets

Secrets never live in JSON files. They come from the process environment, and
the CLI loads dotenv-style files without overriding variables that are already
set: `<home>/.env`. `fnox exec` works the same way. Variables: `AIVI_TOKEN`, `DISCORD_BOT_TOKEN`,
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (Slack's bot and app-level tokens),
`OPENCODE_USERNAME`/`OPENCODE_PASSWORD` (only with `opencode.url`).

With `host.auth.mode: "token"`, `AIVI_TOKEN` (at least 24 characters) must be
present in the host environment and in the OpenCode server's environment for the
plugin. With `mode: "none"` no token is needed anywhere; the host logs a warning
when it binds beyond loopback without auth. Per-device tokens and SSO (via a
reverse proxy) are planned as further modes. The plugin never receives an API
for reading host secrets.

The host discovers OpenCode through the SDK's service registration
(`~/.local/state/opencode/service.json`), so the random service port and its
basic-auth password never appear in aivi configuration.

Shell tasks never inherit these secrets: the child process gets the host
environment minus the fixed names above and minus every key defined in
`<home>/.env`. Everything else (PATH, HOME, the operator's shell variables)
passes through, and a task's own `env` map is merged on top.

`aivi serve` logs one JSON object per line on stderr; `--log-level debug` shows
job materialization. stdout is reserved for command output.

JSON schemas are generated into `schemas/` by `npm run schema`; `npm run check`
fails when they are stale. Point your editor at them for autocompletion and
field descriptions: `"$schema": "../schemas/aivi.schema.json"` (relative to the
config file) in `aivi.json` and the Discord and Slack configs. Runtime validation additionally checks cron
expressions, timezones, uniqueness, that every project is checked out, and
Linear application references.

`aivi serve` is the single application command. See [application lifecycle](application.md)
for ownership and [knowledge search](knowledge.md) for indexing and retrieval.
