# Configuration

## Home

aivi reads one directory, the **home**: `~/.aivi` by default, or `AIVI_HOME`
(leading over the `home` field in the client config; `AIVI_CONFIG` moves that
file itself, which is how the development home stays separate). It holds
`config.json`, `.env`, `app/package.json` (the installed server and the
`aivi-plugins` list), and `state/` (SQLite, the search index, the editor
schema cache, dreaming transcripts). The live
`config.json` is the
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
  dependencies are the server (`@aivi/host`) and the installed plugins. Its
  `aivi-plugins` array is the enablement fact: package names, a
  `[name, false]` tuple for a plugin that stands down. `aivi add` and
  `aivi remove` write it, and the server composes `config.json`'s closed
  schema from exactly those packages. `config.json` records what each plugin
  is *configured as*; `app/package.json` records which plugins *exist and run*.
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
| `identity.name` | The persona: `aivi`. One name on every platform — the Linear application, the Discord and Slack bot usernames, what colleagues ping. Nothing derives agent names from it (the assistant is `assistant` unless a module says otherwise); the display name stays free-form. The plugin says it to every agent (`Your name is aivi.`) ahead of the soul, so `soul.md` never repeats it. aivi cannot set names on the platforms: the operator uses this name in each console |
| `identity.github` | Who a **worker aivi launched** commits as, as a `{user, email}` pair: name the pair or neither, never half. Default: `opencode.coauthor` in the machine's git config, else the aivi app `aivi-agent[bot] <331678708+aivi-agent[bot]@users.noreply.github.com>`. GitHub resolves a bot commit's avatar and link from the email *inside the commit*, never from who pushed, so no token and no app installation is involved ([linear](linear.md)) |
| `stateDirectory` | `state` inside the home |
| `host.bind` | `127.0.0.1`. Use a LAN/tailnet address or `0.0.0.0` so remote OpenCode installs can reach the knowledge server |
| `host.port` | `4100` |
| `host.public` | Where aivi is *reached from outside*: the funnel, tunnel or reverse-proxy URL (`https://you.tailscale.ts.net`, a path is allowed, no trailing slash). Never derived, never called — aivi dials `bind`/`port` — but every URL aivi prints for someone else to paste is composed from it. `aivi setup` asks for it; changing it later is editing this file |
| `opencode.url` | Omit to discover the local `opencode service` automatically (recommended). Set only for a server elsewhere; then `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` supply its basic-auth credentials |
| `opencode.lifecycle` | How much of the local service aivi owns. `own` (default): at `aivi serve` startup a running service is replaced by a fresh one (persistent terminals handed off) and a missing one is started, so a new plugin build is live. `ensure`: only start when missing. `discover`: never start or stop (set this in any home tests and smoke checks read, so they never touch a developer's OpenCode). Ignored with `opencode.url` |
| `knowledge` | Core sources, each `{id, path, kind?}`; kinds: `doc` (default), `decision`, `memory`, `conversation`. `<home>/memory` is added as the core `memory` source automatically; that id is reserved |
| `projectDefaults.knowledge` | The repository convention every project gets unless it lists its own; default `docs` (`doc`) and `docs/adr` (`decision`). A file belongs to its most specific source ([projects](projects.md)) |
| `projectDefaults.tracker-linear` | The lane convention every Linear project inherits unless it maps the lane itself; `null` marks a lane humans work ([linear](linear.md)) |
| `projects` | Overrides keyed by project id, each `{enabled?, knowledge?, linear?}`. Projects themselves are discovered as the directories of `<home>/projects`; an override for a project that is neither checked out nor remembered fails. `<home>/projects/<id>/memory` is each project's `memory` source |
| `plugins` | One block per plugin, keyed by the plugin's own **module id**, which is the package's short name: `plugins.channel-discord`, `plugins.channel-slack`, `plugins.tracker-linear`, `plugins.forge-github`, `plugins.browser`. A person writes the word they typed into `aivi add`, never one they have to find in a source file — the rule holds for every plugin that can be installed (ruled 2026-09-30). What stays the platform's short name is anything naming the platform rather than the package — the table prefixes and session ids (`discord_turns`, `ses_linear_…`) and the `aivi discord`/`aivi linear` commands — because renaming a prefix orphans the conversations already bound to it. The block is the plugin's whole setup and is validated by the plugin's own schema; what *enables* a module is the `aivi-plugins` list in `app/package.json`, not the block — a listed plugin with no block takes its defaults or its own clear complaint, and a block for a plugin nobody listed fails validation. Each plugin's doc owns its block: [discord](discord.md), [slack](slack.md), [linear](linear.md), [browser](browser.md) |
| `search` | On by default: `{provider: "qmd", indexOnStart: true, maxPending: 32}`; `false` disables search entirely |
| `scheduler.maxConcurrent` | `1`; counts running and blocked runs |
| `scheduler.resources` | `{"local-model": 1}`; named pool limits |
| `scheduler.agentSchedules` | On by default as `{ "resource": "local-model", "max": 50 }`: any OpenCode agent with the plugin creates jobs through `aivi_jobs`, run in that pool, at most `max` agent jobs (recurring, or one-offs not yet fired) at once. `false` disables the tool; a custom pool set must name one of its pools here or disable |
| `scheduler.misfire.graceSeconds` | `60`. An occurrence found later than this (aivi was not running) is recorded as one `missed` run per job and never executed; see [Jobs, runs, tasks](#jobs-runs-tasks). A large value means "run whenever" |
| `scheduler.retention` | `{ "cron": "0 4 * * *", "timezone": <host>, "olderThanDays": 30, "resource": "local-model" }`: the host seeds a system job `retention` (task `runs.prune`) that deletes finished runs and finished one-off jobs older than that. `resource` defaults to `local-model`, or the first pool when that does not exist. `false` removes the job. The default (its own `maintenance`-style pool) is written out in [operations](operations.md#how-runs-end) |
| `scheduler.projectsSync` | `{ "cron": "0 * * * *", "timezone": <host>, "resource": "local-model" }`: the host seeds a system job `projects-sync` (task `projects.sync`) that brings every project's `source/` up to its upstream — through the forge that owns the remote when one does, plain git otherwise — and reindexes when something moved, so merges reach what is searched. Same pool rule as retention. `false` removes the job |
| `scheduler.timezone` | Host-wide default for derived schedules (`retention`, `projects-sync`); default the host's own timezone. A schedule's own `timezone` wins over it |
| `dispatcher.pools` | Absent: **unlimited** — capacity is not moderated, today's behavior (the intended default). Present: named pools of `{model?, capacity, fallback?}` every service draws from — the orchestrator, chat turns, jobs, the dreamer — configured once for the installation, never per project. The pool decides the model at session create; a lane's `pool` names one. Fallback grants are for new sessions only and chains must exist and end. [orchestrator](orchestrator.md) owns the design |
| `dispatcher.timeouts` | `{ idle: "180m", prepare: "5m" }`: silence on an attached session before the dispatcher reclaims the slot (kill, confirm, free; an unconfirmed kill keeps the slot unavailable until a strike confirms or the cap gives up); and how long a lease without a session may take to be provided one. Durations add by spaces (`1h 30m`) |
| `dispatcher.killAttempts` | `3`: how many kill strikes an unconfirmed session gets before the dispatcher gives up on it — **not** on the slot: the capacity returns and the ending carries the `kill-unconfirmed` code, which the tracker says loudly on its platform ([orchestrator](orchestrator.md#ending-a-lease)) |
| `orchestrator.elicitationKeepAlive` | `5m`: how long an open in-session elicitation (a worker waiting on a person, like Linear elicitation) holds its slot. After it the lease releases; the answer reacquires capacity and resumes the same session — fallback never applies to a resume |
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
| `projects.sync` | – | For every project with a checkout: asks the forge registry who owns the remote — an owned checkout syncs through that forge (fetch authenticates; the credentials are the forge's), anything else runs plain git — then fast-forwards the checked-out branch to its upstream; skipped (logged `projects.sync.skipped`, listed in the report) when `source/` has local changes, a detached HEAD, no upstream or diverged history, so nothing is ever forced. Reindexes when any project moved. The host seeds one such job from `scheduler.projectsSync` |
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

The `plugins.tracker-linear` block is the Linear module's whole setup; the
module runs when `@aivi/tracker-linear` stands in the `aivi-plugins` list
([linear](linear.md)). The key is the package name; the database's prefix, the
webhook URL Linear's dashboard holds and the `aivi linear` command keep the
platform's short name, since those say who a conversation is on rather than
which package speaks for it.

```json
{
  "plugins": {
    "tracker-linear": {
      "agent": "aivi",
      "primary": "aivi",
      "apps": { "aivi": {}, "reviewer": {} },
      "logMisroutes": true,
      "humanLabel": "needs-human",
      "resource": "local-model",
      "progress": "tools",
      "turnTimeoutMs": 7200000
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `agent` | The OpenCode agent that answers people on Linear — comment mentions above all: the **assistant**. A hand delegation is never its to answer: those get the fixed refusal. Default: `assistant` |
| `primary` | The app that carries the workspace's data feed, signs the bare `LINEAR_*` secrets and authorises the Linear MCP. Default: the one app; required once several apps are configured |
| `apps.<id>` | A Linear OAuth application acting as an app user. The primary does the receiving; every other app is a **face** — a name and icon in Linear's UI with its own credentials, no routing meaning |
| `logMisroutes` | `true`: log at warn a webhook delivered to the wrong endpoint — a data change on a face's route. It is dropped either way |
| `humanLabel` | Issues with this label are never worked automatically — the only "not that one again" there is (a stop remembers nothing); a session created on one is refused with an explanation, and a failed closing or an unkillable worker marks the ticket with it |
| `resource` | Pool a worker turn takes a slot in (must exist in `scheduler.resources`) |
| `mcp` | On by default: the module serves Linear's hosted MCP on loopback (default port 4101), authorised with the app-actor token, so agents can act in Linear and writes attribute to the app; `false` disables it ([linear](linear.md#the-linear-mcp)) |
| `progress` | `silent`, `status` or `tools`: what the ephemeral activities show while a worker runs |
| `turnTimeoutMs` | A worker turn longer than this is interrupted and ends `stopped` (default two hours) |

The project entry routes by Linear **team** (a repository may list several
teams — one checkout, several teams; a team belongs to at most one project;
Linear *projects* (epics) play no routing part). The workflow itself is not a
Linear field: it is **core's** lane array on the project,
`projects.<id>.lanes` — left to right, the order **is** the priority:

```json
{
  "projects": {
    "website": {
      "tracker-linear": { "teams": ["linear-team-id"] },
      "lanes": [
        { "name": "Todo", "queue": true },
        { "name": "In Progress", "agent": "dev", "pool": "worker", "worktree": true },
        { "name": "Review", "agent": "reviewer" },
        { "name": "Release" }
      ]
    }
  }
}
```

A lane naming an `agent` is worked; one naming none is worked by humans; a
tracker state named nowhere in the array is silence. `next` and `previous`
override where a success and a failure move the ticket — neighbours by
default, and a stop never moves. `queue: true` marks the workflow's **one**
queue lane: fresh work waiting for capacity, an extension of the worker lane
it feeds; the load says so loudly for two queue lanes, a queue lane naming
an agent, or a queue whose next lane (by order or by `next`) works nothing.
`pool` names the dispatcher pool the lane's work draws capacity from — inert
until the dispatcher is built; lanes naming none draw from the default pool.
`worktree: true` gives the worker its own git worktree; default false works
the project checkout itself, where the agent file's own `edit` deny is the
only guard. **Closed states (Done, Canceled, Duplicate) are never written**:
the tracker recognizes them by type, and a run ending in the last configured
lane moves nowhere. [orchestrator.md](orchestrator.md) owns the vocabulary.
`aivi projects add` writes the array for you — names, agents, worktrees; the
wizard's queue-lane question lands with the dispatcher build. `teams` is
never defaulted. `workspaceId` is optional and only needed when the
installation spans Linear workspaces;
`projectDefaults.tracker-linear.workspaceId` supplies it to every project
that omits its own. The mapped agent is resolved by OpenCode's ordinary
discovery for the session's directory; an unknown agent file is OpenCode's own
error at session start, not a config error.

Credentials are never in JSON. The **primary** app reads the bare
`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` — the
bare names mean *the one app*. Every other app follows the convention
`LINEAR_<APP>_CLIENT_ID`, `LINEAR_<APP>_CLIENT_SECRET` and
`LINEAR_<APP>_WEBHOOK_SECRET` (`<APP>` is the app id upper-cased with `-` as
`_`, so `dev-app` reads `LINEAR_DEV_APP_CLIENT_ID`). The Linear MCP, when
enabled (`linear.mcp`), is served by the module itself on loopback and
authorised with the primary's app-actor token
([linear](linear.md#the-linear-mcp)).

## GitHub forge

`plugins.forge-github` is the GitHub forge's whole setup, and it is one number:
the app's id — the `App ID` on the app's settings page, not its name. The
module runs when `@aivi/forge-github` stands in the `aivi-plugins` list
([the forge](plans/forge-github.md)).

```json
{ "plugins": { "forge-github": { "app": 12345 } } }
```

The private key is a secret and so is not here: `GITHUB_APP_PRIVATE_KEY` in
`<home>/.env`, the PEM file GitHub handed out when the app was created. The
app must also be **installed** — an installation is the grant from the account
holding the repositories to the app — and aivi speaks through exactly one:
none is an error carrying the install link, several is an error naming the
grants and saying which to revoke.

Nothing in this block names a repository. Which repository a project is comes
from that project's own `origin`, and a checkout whose remote is not a GitHub
repository simply has no forge: no error, and no pull-request facts. Likewise
there is no per-project forge section — a forge is asked about a checkout it
did not create and reads the answer off the checkout. What asks it today is
the `projects-sync` job (a checkout this forge recognises syncs **through**
the forge, authenticated as its own installation; the rest stays plain git)
and the worker's `aivi_pr` call (the forge pushes as its own app and opens
the pull request when the branch has none). A project with no forge gets
neither, and `aivi_pr` says so plainly when it is called anyway.

## Operator commands

`npm run aivi -- --help` lists them; what each does and when to use it is in
[operations](operations.md#jobs-and-runs-from-the-command-line).

## Update channel

`update.channel` picks what `aivi update` resolves. `stable` (the npm `latest`
dist-tag) is the only channel: a nightly would mean releasing from main, which
is not wanted. The enum exists so a future channel is a schema change, not a
redesign. There is no rollback: `aivi update` installs while the server
answers, then makes one announced restart and probes `/health`; sessions
resume because state is SQLite and OpenCode's own.

## Secrets

Secrets never live in JSON files. They come from the process environment, and
the CLI loads dotenv-style files without overriding variables that are already
set: `<home>/.env`. `fnox exec` works the same way. Variables: `DISCORD_BOT_TOKEN`,
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (Slack's bot and app-level tokens),
`OPENCODE_USERNAME`/`OPENCODE_PASSWORD` (only with `opencode.url`), for
Linear the bare `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
`LINEAR_WEBHOOK_SECRET` (the primary app) plus `LINEAR_<APP>_…` per extra app
([Linear](#linear)), and `GITHUB_APP_PRIVATE_KEY` — the GitHub App's PEM
private key, which is many lines, so the setup writes it as one quoted line and
Node's loader gives it back with its newlines
([the forge](plans/forge-github.md)). `AIVI_OPERATOR_BEARER` is the one name in that list no
one sets: the exec door stamps it with the bearer this connection presented
into a driven session's closed child environment, so commands typed
remotely attribute to the human who typed them, not to the server's own
token.

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
`<home>/.env` — `AIVI_OPERATOR_BEARER` among the fixed names, so a driven
operator's credential cannot leak into a task script however it entered the
environment. Everything else (PATH, HOME, the operator's shell variables)
passes through, and a task's own `env` map is merged on top.

One JSON schema covers the whole file, composed at runtime: core's fields
plus the block of every plugin in the home's `aivi-plugins` list. The CLI
writes it to `<state>/cache/schema.json` and points config.json's
`"$schema"` at it after `setup`, `add`, `remove` and `update` — the events
that change what is valid — so your editor has autocompletion and field descriptions with
nothing to generate by hand. The cache is disposable; the list and the plugin
packages are the truth. Runtime validation additionally checks cron
expressions, timezones, uniqueness, that every project override has a
checkout, that every plugin block and system job names an existing resource
pool, and Linear app references.

`aivi serve` is the single application command. See [operations](operations.md)
for ownership and [knowledge search](knowledge.md) for indexing and retrieval.
