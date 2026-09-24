# Configuration

## Home

aivi reads one directory, the **home**: `~/.aivi` by default, or `AIVI_HOME`
(leading over the `home` field in the client config; `AIVI_CONFIG` moves that
file itself, which is how the development home stays separate). It holds
`config.json`, `.env`, and `state/` (SQLite, the search index, dreaming
transcripts). The live `config.json` is the
file
you and aivi edit, so it never goes under version control; a home that lives
in a git repository starts empty (`{ version: 1 }`) and grows only what you
enable. In this repository `npm run aivi` sets `AIVI_HOME=dev`, a development
home produced by `npm run aivi:cli setup`; add blocks to `dev/config.json` as
you need them — a Discord block makes `serve` ask for `DISCORD_BOT_TOKEN`
from `dev/.env`, and so on.

`config.json` is installation configuration and describes the projects too; a
project's checkout carries nothing of aivi's ([projects](projects.md)).
OpenCode's own files stay in their native locations.
Unknown fields and invalid combinations fail validation; nothing silently falls
back to another project or resource pool.

Two more directories live in the home, owned by the CLI rather than aivi:

- `app/` — the installed packages: one `package.json` and lockfile whose
  dependencies are the server (`@aivi/host`) and the enabled channel plugins.
  `config.json` records what is *desired*; `app/package.json` records what is
  *installed*.
- `runtime/` — a managed Node installation, only when the machine's Node does
  not satisfy the server's requirement.


Paths in installation config and in task files resolve relative to the home.
Project source paths resolve relative to the checkout, `<home>/projects/<id>/source`.
The home is also the OpenCode location: agents live in `<home>/.opencode/agents/`.

## The soul

`<home>/soul.md` says how aivi speaks: voice, standing promises, "I route
rather than do". What aivi is **called** is not in it: the plugin states
`identity.name` as one line, `Your name is aivi.`, ahead of the soul, so the
persona has exactly one place to change. aivi's plugin injects both into
**every** agent's prompt (the installation is a dedicated machine, so every
agent there is an aivi agent) — injected, never copied into agent files, so an
agent-file edit cannot delete it, and an edit to `soul.md` or to
`identity.name` takes effect without a restart. It is injected once per session
as part of the agent definition, so it costs nothing per message. Keep it
short: voice, red lines. Anything specific to one place (how to behave on
Discord, what a Linear refusal means) belongs in that platform's agent file;
facts aivi *learns* belong in memory. The soul is who aivi *says* it is;
knowledge and dreaming carry who aivi *knows*. A soul file that starts
containing facts is the wrong file growing.

## Fields

| Field | Default / purpose |
| --- | --- |
| `version` | Required; `1` |
| `identity.name` | The persona: `aivi`. One name on every platform — the Linear application, the Discord and Slack bot usernames, what colleagues ping. Agent-file and handle names derive from its slug; the display name stays free-form. The plugin says it to every agent (`Your name is aivi.`) ahead of the soul, so `soul.md` never repeats it. aivi cannot set names on the platforms: the operator uses this name in each console |
| `identity.github` | Who a **worker aivi launched** commits as, as a `{user, email}` pair: name the pair or neither, never half. Default: `opencode.coauthor` in the machine's git config, else the aivi app `aivi-agent[bot] <331678708+aivi-agent[bot]@users.noreply.github.com>`. GitHub resolves a bot commit's avatar and link from the email *inside the commit*, never from who pushed, so no token and no app installation is involved ([linear](linear.md)) |
| `identity.github.app` | The GitHub App id. Nothing reads it yet: whoever mints an installation token to act on GitHub as the app signs a JWT issued to this |
| `stateDirectory` | `state` inside the home |
| `host.bind` | `127.0.0.1`. Use a LAN/tailnet address or `0.0.0.0` so remote OpenCode installs can reach the knowledge server |
| `host.port` | `4100` |
| `opencode.url` | Omit to discover the local `opencode service` automatically (recommended). Set only for a server elsewhere; then `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` supply its basic-auth credentials |
| `opencode.lifecycle` | How much of the local service aivi owns. `own` (default): at `aivi serve` startup a running service is replaced by a fresh one (persistent terminals handed off) and a missing one is started, so a new plugin build is live. `ensure`: only start when missing. `discover`: never start or stop (set this in any home tests and smoke checks read, so they never touch a developer's OpenCode). Ignored with `opencode.url` |
| `knowledge` | Core sources, each `{id, path, kind?}`; kinds: `doc` (default), `decision`, `memory`, `conversation`. `<home>/memory` is added as the core `memory` source automatically; that id is reserved |
| `projectDefaults.knowledge` | The repository convention every project gets unless it lists its own; default `docs` (`doc`) and `docs/adr` (`decision`). A file belongs to its most specific source ([projects](projects.md)) |
| `projectDefaults.linear` | The lane convention every Linear project inherits unless it maps the lane itself; `null` marks a lane humans work ([linear](linear.md)) |
| `projects` | Overrides keyed by project id, each `{enabled?, knowledge?, linear?}`. Projects themselves are discovered as the directories of `<home>/projects`; an override for a project that is neither checked out nor remembered fails. `<home>/projects/<id>/memory` is each project's `memory` source |
| `modules.discord` | Presence enables the Discord module; the block is its whole setup, `false` is an explicit off ([discord](discord.md)) |
| `modules.slack` | Presence enables the Slack module; the block is its whole setup, `false` is an explicit off ([slack](slack.md)) |
| `browser` | On by default: aivi launches its own Chrome with a profile in `state/chrome` on first use. `false` disables it; an object selects another mode or limits; see [browser setup](browser.md) |
| `search` | Optional `{provider: "qmd", indexOnStart: true, maxPending: 32}` |
| `scheduler.maxConcurrent` | `1`; counts running and blocked runs |
| `scheduler.resources` | `{"local-model": 1}`; named pool limits |
| `scheduler.agentSchedules` | On by default as `{ "resource": "local-model", "max": 50 }`: any OpenCode agent with the plugin creates jobs through `aivi_jobs`, run in that pool, at most `max` agent jobs (recurring, or one-offs not yet fired) at once. `false` disables the tool; a custom pool set must name one of its pools here or disable |
| `scheduler.misfire.graceSeconds` | `60`. An occurrence found later than this (aivi was not running) is recorded as one `missed` run per job and never executed; see [Jobs, runs, tasks](#jobs-runs-tasks). A large value means "run whenever" |
| `scheduler.retention` | `{ "cron": "0 4 * * *", "timezone": <host>, "olderThanDays": 30, "resource": "local-model" }`: the host seeds a system job `retention` (task `runs.prune`) that deletes finished runs and finished one-off jobs older than that. `resource` defaults to `local-model`, or the first pool when that does not exist. `false` removes the job. The default (its own `maintenance`-style pool) is written out in [operations](operations.md#how-runs-end) |
| `scheduler.projectsSync` | `{ "cron": "0 * * * *", "timezone": <host>, "resource": "local-model" }`: the host seeds a system job `projects-sync` (task `projects.sync`) that fast-forwards every project's `source/` to its upstream and reindexes when something moved, so merges reach what is searched. Same pool rule as retention. `false` removes the job |
| `scheduler.timezone` | Host-wide default for derived schedules (`retention`, `projects-sync`); default the host's own timezone. A schedule's own `timezone` wins over it |
| `jobs` | Empty; job definitions, each `id`, `task`, and either `cron` + `timezone` (recurring) or `at` (an ISO 8601 instant; one-off), with optional `title`, `resource` (`local-model`), `report`, `enabled` (default `true`) and `misfire.graceSeconds` (per-job override). A bare operation name is shorthand for its invocation: `"task": "system.check"` is `{ "kind": "invocation", "name": "system.check" }`; use the explicit shape when the operation takes `args`. The ids `retention` and `projects-sync` are reserved while their `scheduler.*` settings are on |

## Tasks

A task is what a job executes: the payload, never a thing you trigger. You
trigger **jobs**; a **run** is one execution record. A task is one of three
kinds. `shell` and `prompt` are the tasks a person or an agent can author;
`invocation` names a system capability that the host or a module registered,
and exists so such a capability can be *scheduled* like any other job.
`aivi_jobs` accepts only the first two.

| Kind | Fields | Outcome |
| --- | --- | --- |
| `shell` | `command` (argv array, never a shell string), `cwd`, `env` (merged over the inherited environment), `timeoutMs` (10 min) | Exit 0 succeeds, other exits fail, a timeout blocks; stdout/stderr tails are kept. The process inherits the host environment minus aivi's secrets (`DISCORD_BOT_TOKEN`, `SLACK_*_TOKEN`, `OPENCODE_*`, and every key of `<home>/.env`); set a secret in `env` on purpose if a script needs it |
| `prompt` | `agent`, `directory`, `prompt`, `timeoutMs` (30 min), `onPermission` (`reject`/`fail`) | Runs one agent turn to a verified answer; see [OpenCode integration](opencode.md) |
| `invocation` | `name` (the operation to invoke), `args` (opaque to everyone but the operation, which parses them and fails the run when they are wrong) | Runs the operation that *claimed* the name. Each name is claimed exactly once: a second claimant is a fatal configuration error at startup, and a run of an unclaimed name fails with its name in the reason |

### Operations

The host claims its own five like any other claimant; a module claims
`<module>.<thing>` names when it starts (for example `linear.sweep`). Views
(`aivi jobs list`, status, reports) show the operation name where a task kind
would appear.

| Name | Fields (args) | Outcome |
| --- | --- | --- |
| `system.check` | – | Reports whether every knowledge source path exists |
| `knowledge.index` | – | Refreshes the search index |
| `projects.sync` | – | For every project with a checkout: `git fetch`, then fast-forward the checked-out branch to its upstream; skipped (logged `projects.sync.skipped`, listed in the report) when `source/` has local changes, a detached HEAD, no upstream or diverged history, so nothing is ever forced. Reindexes when any project moved. The host seeds one such job from `scheduler.projectsSync` |
| `runs.prune` | `olderThanDays` (≥ 1) | Deletes runs that ended `succeeded`, `failed`, `cancelled` or `missed` before that, with their audit rows, then the `done`/`missed` one-off jobs that have no runs left. Blocked and active runs and recurring jobs are never touched. The host seeds one such job from `scheduler.retention` |
| `dreaming` | `memoryDirectory` (`memory`, the org memory in the home), `agent` (`dreamer`), `directory` (the home), `origins` (`["discord"]`; add `slack` for Slack conversations), `maxSessions`, `timeoutMs` | Reviews conversations since the last run and maintains memory files; paths resolve against the home, and `memoryDirectory` must be inside a core knowledge source. See [dreaming](dreaming.md) |

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
from `scheduler.retention` and `scheduler.projectsSync`, and by each composed module beside
them — a module that leaves the composition loses its jobs), `agent` (created through `aivi_jobs`) or
`operator` (created with `aivi jobs add`). Startup reconciles `config` and
`system` jobs against the settings: unchanged definitions keep their next
occurrence, changed ones cancel their queued run and start from the next
future occurrence, a `config` job that disappeared is paused, a `system` job
that disappeared is removed. Two system job definitions sharing an id are a
fatal configuration error, never a silent overwrite. Agent and operator jobs are never touched by
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
  that produced it ([discord](discord.md#setup)). A shell task file:
  `{ "task": { "kind": "shell", "command": ["node", "--version"], "timeoutMs": 30000 }, "resource": "maintenance" }`.
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

## Linear

Presence of `linear` enables the module ([linear](linear.md)).

```json
{
  "linear": {
    "agent": "aivi",
    "primary": "aivi",
    "apps": { "aivi": {}, "reviewer": {} },
    "logMisroutes": true,
    "listener": false,
    "humanLabel": "needs-human",
    "resource": "local-model",
    "progress": "tools",
    "turnTimeoutMs": 7200000
  }
}
```

| Field | Meaning |
| --- | --- |
| `agent` | The OpenCode agent that answers people on Linear — comment mentions and delegations that no lane claims: the **assistant**. Default: the aivi name |
| `primary` | The app that carries the workspace's data feed, signs the bare `LINEAR_*` secrets and authorises the Linear MCP. Default: the one app; required once several apps are configured |
| `apps.<id>` | A Linear OAuth application acting as an app user. The primary does the receiving; every other app is a **face** — a name and icon in Linear's UI with its own credentials, no routing meaning |
| `logMisroutes` | `true`: log at warn a webhook delivered to the wrong endpoint — a data change on a face's route. It is dropped either way |
| `listener` | `false`: only delegations and mentions made in Linear start a worker. `true`: an issue entering a mapped lane is delegated by aivi (on the primary) and its worker starts |
| `humanLabel` | Issues with this label are never worked automatically; a hand delegation is refused with an explanation in the agent session |
| `resource` | Pool a worker turn takes a slot in (must exist in `scheduler.resources`) |
| `mcp` | On by default: the module serves Linear's hosted MCP on loopback (default port 4101), authorised with the app-actor token, so agents can act in Linear and writes attribute to the app; `false` disables it ([linear](linear.md#the-linear-mcp)) |
| `progress` | `silent`, `status` or `tools`: what the ephemeral activities show while a worker runs |
| `turnTimeoutMs` | A worker turn longer than this is interrupted and ends `stopped` (default two hours) |

The project entry routes by Linear **team** and selects agents by lane (a lane
is a team workflow state, by name):

```json
{
  "projectDefaults": {
    "linear": { "lanes": { "Dev": "dev", "Review": "dev", "Triage": null } }
  },
  "projects": {
    "website": {
      "linear": {
        "teams": ["linear-team-id"],
        "lanes": { "Review": { "agent": "reviewer", "worktree": false }, "Shipped": null }
      }
    }
  }
}
```

A repository may list several teams (one checkout, several teams); a team
belongs to at most one project. Linear *projects* (epics) play no routing
part. `lanes` defaults to empty: the listener delegates nothing until you map
a lane, while hand delegation always works. A lane names an **OpenCode agent**
directly; several lanes may name the same agent; `null` marks a lane humans
work. A lane may be an object `{ agent, worktree: false }`: the agent runs in
the project's clean checkout on main without a worktree — aivi builds no
enforcement there, the agent file's own `edit` deny is the only guard, and the
checkout is never worked in by a lane that does not say so. Lanes merge one
key at a time over `projectDefaults.linear.lanes` (where `knowledge`
replaces: a lane map is a lookup table, not a list), so a project whose site
works `Dev` with `dev` as the convention says, `Review` with `reviewer` in the
checkout because the entry outvotes the convention, and leaves `Triage` and
`Shipped` to people. `teams` is never defaulted: a team belongs to one
project. `workspaceId` is optional and only needed when the installation spans
Linear workspaces; `projectDefaults.linear.workspaceId` supplies it to every
project that omits its own.
`aivi projects add <git-url> --linear PEC` and `aivi projects create` write
`teams` for you, resolving the team key Linear's URLs show to its id;
`--lane "Dev:dev"` (shorthand `--lane "Dev,Review:dev"`) and
`--unlane "Backlog"` write the lanes along with them. The mapped agent is
resolved by OpenCode's ordinary discovery for the session's directory; an
unknown agent file is OpenCode's own error at session start, not a config
error.

Credentials are never in JSON. The **primary** app reads the bare
`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` — the
bare names mean *the one app*. Every other app follows the convention
`LINEAR_<APP>_CLIENT_ID`, `LINEAR_<APP>_CLIENT_SECRET` and
`LINEAR_<APP>_WEBHOOK_SECRET` (`<APP>` is the app id upper-cased with `-` as
`_`, so `dev-app` reads `LINEAR_DEV_APP_CLIENT_ID`). The Linear MCP, when
enabled (`linear.mcp`), is served by the module itself on loopback and
authorised with the primary's app-actor token
([linear](linear.md#the-linear-mcp)).

## Operator commands

`npm run aivi -- --help` lists them; what each does and when to use it is in
[operations](operations.md#jobs-and-runs-from-the-command-line).

## Update channel

`update.channel` picks what `aivi update` resolves. `stable` (the npm `latest`
dist-tag) is the only channel: a nightly would mean releasing from main, which
is not wanted. The enum exists so a future channel is a schema change, not a
redesign. There is no rollback: `aivi update` stops the server, installs,
restarts and probes `/health`; sessions resume because state is SQLite and
OpenCode's own.

## Secrets

Secrets never live in JSON files. They come from the process environment, and
the CLI loads dotenv-style files without overriding variables that are already
set: `<home>/.env`. `fnox exec` works the same way. Variables: `DISCORD_BOT_TOKEN`,
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (Slack's bot and app-level tokens),
`OPENCODE_USERNAME`/`OPENCODE_PASSWORD` (only with `opencode.url`), and for
Linear the bare `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
`LINEAR_WEBHOOK_SECRET` (the primary app) plus `LINEAR_<APP>_…` per extra app
([Linear](#linear)).

The host API itself takes no token: auth is `none`, commands are open. A bearer
token only *identifies* the caller (whose job, whose link, whose memory — a
person token); an unknown or missing one is anonymous and still served. The
host logs a warning when it binds beyond loopback, because anyone who can reach
the address can use the commands. The plugin never receives an API for reading
host secrets. A person's own credentials live in the client config
(`~/.config/aivi.json`), owned by [people](people.md).

The host discovers OpenCode through the SDK's service registration
(`~/.local/state/opencode/service.json`), so the random service port and its
basic-auth password never appear in aivi configuration.

Shell tasks never inherit these secrets: the child process gets the host
environment minus the fixed names above and minus every key defined in
`<home>/.env`. Everything else (PATH, HOME, the operator's shell variables)
passes through, and a task's own `env` map is merged on top.

One JSON schema covers the whole file; it is generated into
`schemas/aivi.schema.json` by `npm run schema`, and `npm run check` fails when
it is stale. Point your editor at it for autocompletion and field
descriptions: `"$schema": "../schemas/aivi.schema.json"` (relative to the
config file) in `config.json`. Runtime validation additionally checks cron
expressions, timezones, uniqueness, that every project override has a
checkout, that every enabled module and system job names an existing resource
pool, and Linear app references.

`aivi serve` is the single application command. See [operations](operations.md)
for ownership and [knowledge search](knowledge.md) for indexing and retrieval.
