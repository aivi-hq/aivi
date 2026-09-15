# Configuration

## Home

aivi reads one directory, the **home**: `~/.aivi` by default, or `AIVI_HOME`.
It holds `aivi.json`, `.env`, and `state/` (SQLite, the search index, dreaming
transcripts). There is no config-path option. If `aivi.local.json` exists in
the home it is used instead of `aivi.json`; `*.local.json` is git-ignored, so a
checked-in home such as `example/` can carry a private setup beside the public
one. In this repository `npm run aivi` sets `AIVI_HOME=example`; that home has
every feature enabled, so `serve` needs `DISCORD_BOT_TOKEN` in `example/.env`
unless the `modules.discord` block is removed.

`aivi.json` is installation configuration. `aivi.project.json` lives inside each
registered project. OpenCode's own files stay in their native locations.
Unknown fields and invalid combinations fail validation; nothing silently falls
back to another project or resource pool.

Paths in installation config and in task files resolve relative to the home.
Project source paths resolve relative to the project directory. The home is
also the OpenCode location: agents live in `<home>/.opencode/agents/`.

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
| `knowledge` | Core sources, each `{id, path, kind?}`; kinds: `doc` (default), `decision`, `memory`, `conversation` |
| `projects` | Project registry, each `{id, directory}` |
| `modules.discord.config` | Optional path to Discord module settings |
| `browser` | On by default: aivi launches its own Chrome with a profile in `state/chrome` on first use. `false` disables it; an object selects another mode or limits; see [browser setup](browser.md) |
| `search` | Optional `{provider: "qmd", indexOnStart: true, maxPending: 32}` |
| `scheduler.maxConcurrent` | `1`; counts running and blocked jobs |
| `scheduler.resources` | `{"local-model": 1}`; named pool limits |
| `scheduler.pollMs` | `30000`; safety-net interval. The host sleeps until the next due instant and is woken by changes; this only bounds a missed wake |
| `scheduler.agentSchedules` | On by default as `{ "resource": "local-model", "max": 50 }`: any OpenCode agent with the plugin creates jobs through `aivi_schedule`, run in that pool, at most `max` schedules and pending one-offs at once. `false` disables the tool; a custom pool set must name one of its pools here or disable |
| `schedules` | Empty; named cron/timezone/resource/task entries, each with optional `title`, `report`, `enabled` (default `true`) and `misfire.skipAfterMs` (an occurrence found later than that after downtime is recorded as skipped, not run) |

## Tasks

| Kind | Fields | Outcome |
| --- | --- | --- |
| `system.check` | – | Reports whether every knowledge source path exists |
| `knowledge.index` | – | Refreshes the search index |
| `shell` | `command` (argv array, never a shell string), `cwd`, `env` (merged over the inherited environment), `timeoutMs` (10 min) | Exit 0 succeeds, other exits fail, a timeout blocks; stdout/stderr tails are kept. The process inherits the host environment minus aivi's secrets (`AIVI_TOKEN`, `DISCORD_BOT_TOKEN`, `OPENCODE_*`, and every key of `<home>/.env`); set a secret in `env` on purpose if a script needs it |
| `opencode.prompt` | `agent`, `directory`, `prompt`, `timeoutMs` (30 min), `onPermission` (`reject`/`fail`) | Runs one agent turn to a verified answer; see [OpenCode integration](opencode.md) |
| `dreaming` | `memoryDirectory`, `agent` (`dreamer`), `directory` (the home), `origins` (`["discord"]`), `maxSessions`, `timeoutMs` | Reviews conversations since the last run and maintains memory files; see [dreaming](dreaming.md) |

## Reporting

Any schedule, or a task file passed to `jobs enqueue` as `{ "task": …, "report": …, "resource"?: … }`,
may carry a `report`. Delivery success or failure is recorded in the job's
audit history and never changes the job's outcome. `on` is `"always"`
(default), `"failure"` or `"never"`. Two shapes exist:

- **A channel**: `{ "to": "channel", "module": "discord", "channel": "<id>", "on": … }`.
  `module` names a running channel module ([channels](channels.md)), `channel`
  is that platform's own identifier. The module decides whether aivi may post
  there (`reportChannels` in its config) and how: Discord opens a thread that
  continues the job's session, so replying to an outcome talks to the agent
  that produced it ([discord](discord.md#setup)). See `example/tasks/shell.json`.
- **A session**: `{ "to": "session", "session": "<OpenCode session id>", "on": … }`.
  The outcome is not posted as text; it is submitted as a prompt into that
  session so the agent there reads it and answers in its own words. A session a
  channel module owns (a Discord thread) receives it as an ordinary turn, in
  order with the people talking there, replied to in the thread. Any other
  session gets it queued into its native inbox. This is the default for jobs an
  agent creates from a conversation ([jobs](backlog/jobs.md)).

The text is the job outcome (`describeOutcome`, up to 4000 characters, split
by the destination) and, for agent jobs, one trailing line naming the OpenCode
session. A recurring job that has failed three times in a row says so in its
failure report.

Scheduling starts at the next future occurrence on initial registration. Restart
preserves the next occurrence for unchanged definitions. Changes cancel stale
queued occurrences and calculate a new next time. Existing active work remains
owned. Config changes require a daemon restart; `schedules sync` also provides
explicit reconciliation when the daemon is stopped.

## Agent-created jobs

Every OpenCode agent that has the aivi plugin gets `aivi_schedule` (unless
`scheduler.agentSchedules` is `false`): create, list, pause, resume, remove
and run. A
person asks in chat ("every Monday at 9, summarize last week"; "in two hours,
remind me"; "clean the logs nightly with this script"), the agent translates the
time into cron, ISO 8601 or a duration (`30m`, `2h`, `1d`) and calls the tool.
The host answers with the parsed schedule and its next occurrences so the agent
can confirm what it made.

Two kinds of job: an **agent job** (`prompt`) runs a fresh session of the
calling agent in the calling directory, both read from the calling session in
OpenCode and never trusted from tool input; `agent` and `directory` may
override them explicitly. A **script job** (`command`, argv) runs a process
with the sanitized environment above, in the session's directory unless `cwd`
says otherwise. Both can be one-off (`at`) or recurring (`cron` + `timezone`,
default the host's).

Results default to `report: "session"`: the outcome comes back into the asking
session as a turn (see Reporting), so the agent tells the person in the thread.
`channel` posts to `channel` on the platform `module`, which defaults to the
platform the asking conversation is on and must be named from a native
session; the channel must be in that module's `reportChannels`. `none` keeps
quiet. Only failures with `on: "failure"`.

Authority is whoever may talk to the agent (Discord's access policy, or the
operator in a native session). Jobs do not create jobs: a session whose origin
is `job` or `dreaming` is refused, unless a conversation module has adopted it.
Before anything is created the host checks the session exists, the agent exists
in that directory, the cron and timezone parse, the report can be delivered,
and the `max` limit; a failing check is refused with the reason and nothing is
spent. Agent-created schedules have ids `agent-…`, are stored with source
`agent`, and are never touched by `schedules sync`; `aivi schedules list`
shows them beside the configured ones.

## Linear mapping (validation only)

Installation config maps each application key to one unique OpenCode agent:

```json
{ "linear": { "applications": { "dev-app": { "agent": "dev" } } } }
```

The project config selects applications by lane:

```json
{
  "knowledge": [{ "id": "adrs", "path": "docs/adr" }],
  "linear": {
    "workspaceId": "linear-workspace-id",
    "projectId": "linear-project-id",
    "lanes": { "Development": "dev-app", "Review": "dev-app" }
  }
}
```

Multiple lanes can reuse `dev-app`. Another application cannot also map to `dev`.
Global/project OpenCode configuration still resolves the agent named `dev`.
These application keys are configuration references; OAuth credentials and native
application installation details belong to the future Linear adapter.

## Operator commands

Run `npm run aivi -- --help` for commands.
The `--key` on `jobs enqueue` deduplicates identical requests; changed payloads
with the same key are rejected. `--at` makes a one-off that waits in the queue
until an ISO 8601 instant or a relative duration (`30m`, `2h`, `1d`) has
passed. Failed jobs do not retry automatically.

Use `jobs show ID` for the task, session ID, result, and transition history.
`jobs cancel ID` only cancels queued work. `jobs abort ID` asks the scheduler
to stop a running job (the command gets `SIGTERM`, an agent turn stops
waiting); the job then ends `blocked` with "Aborted by operator" because aivi
cannot know what the external side had already done, and keeps its capacity
until `jobs resolve`. Resolving a blocked job is an explicit operator action
described in [OpenCode setup](opencode.md).

`schedules list` shows configured and agent-created schedules with their next
occurrence and last outcome. Agent-created schedules (source `agent`, see
[jobs](backlog/jobs.md)) are paused, resumed and removed with
`schedules pause|resume|remove ID`; configured ones are edited in `aivi.json`.
`schedules run ID` enqueues one occurrence now, refused while one is
outstanding.

## Secrets

Secrets never live in JSON files. They come from the process environment, and
the CLI loads dotenv-style files without overriding variables that are already
set: `<home>/.env`. `fnox exec` works the same way. Variables: `AIVI_TOKEN`, `DISCORD_BOT_TOKEN`,
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
schedule materialization. stdout is reserved for command output.

JSON schemas are generated into `schemas/` by `npm run schema`; `npm run check`
fails when they are stale. Point your editor at them for autocompletion and
field descriptions: `"$schema": "../schemas/aivi.schema.json"` (relative to the
config file) in `aivi.json`, `aivi.project.json`, and the Discord config. Runtime validation additionally checks cron
expressions, timezones, uniqueness, and references across project files.

`aivi serve` is the single application command. See [application lifecycle](application.md)
for ownership and [knowledge search](knowledge.md) for indexing and retrieval.
