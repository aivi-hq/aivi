# Operations

For whoever runs `aivi serve`: what happens at startup and shutdown, how work
is dispatched, how runs end, and what to do when work is blocked. Configuration
fields are in [configuration](configuration.md); the reasons behind the
behaviour are in [architecture](architecture.md).

## Startup

Startup acquires installation ownership, initializes
shared services, reconciles the job definitions it owns (`jobs[]` from
`config.json` and the system jobs `retention` and `projects-sync` seeded from `scheduler.*`;
`Store.syncJobs`), refreshes the search index when configured, opens the API on
`host.bind:host.port`, then starts modules in order and announces readiness
once each has had its first attempt. From then on the loop sleeps until the
next due instant and wakes early when something changes the queue
(`HostServices.wake`, `POST /v1/wake` from the CLI, a run or turn releasing
capacity). Nothing periodic exists; the serving host is the only executor of
work.

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
once at startup and starts a missing one whenever needed, so a new plugin build
is live; `ensure` only starts, `discover` never touches it. aivi never
manages OpenCode's installation. QMD uses its
library API inside aivi, with no QMD server or separate launch command. Only the
configured Discord module loads discord.js, only the configured Slack module
loads the Slack SDK, and only enabled search loads QMD. A configured browser
service is created after installation ownership is acquired; its MCP/Chrome
processes start on first use and stop with the host ([browser](browser.md)).

Logging is LogTape, configured once at startup: every command mirrors its log to
stderr — pretty on a terminal, one JSON object per line when piped, which
`--log-format auto|pretty|json` overrides — and `aivi serve` additionally appends
JSON lines to `<home>/state/logs/aivi.log` (rotated, so the file is capped)
whatever the console shows. In the pretty console the category column is the
activation tree, colored per module: `aivi·host` green, `aivi·host·discord`
purple, `aivi·host·slack` cyan, `aivi·host·linear` indigo, `aivi·host·scheduler`
deep pink, `aivi·knowledge` amber; the CLI root and dreaming keep the muted
gray. Message text uses the terminal's own foreground; the log file stays
colorless JSON.
`--log-level debug` shows job materialization.
stdout is reserved for command output: `aivi serve` writes its raw JSON ready
line to stdout only when stdout is not a terminal (scripts and smoke parse it);
a human on a terminal sees the pretty `host.listening` record instead, which
also lands in the log file.

## Dispatch

Each wake first materializes due job occurrences into runs. An occurrence
found later than its misfire grace (`scheduler.misfire.graceSeconds`, per-job
`misfire`) is recorded as one `missed` run for the whole gap and reported like
a failure; nothing is executed for it and the job moves to its next future
occurrence ([configuration](configuration.md#jobs-runs-tasks)). Then it claims
queued runs within capacity and executes them.

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
the job at the next startup. `projects-sync` (task `projects.sync`) is the
other system job: it keeps every project's `source/` at its upstream by
fast-forward only, reports what it updated and what it skipped and why, and
reindexes when something moved ([projects](projects.md)).

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

## First run: `aivi setup`

`aivi setup` is the one entry point for client and server. On a machine with
no sign-in it asks what the machine should be:

- **Connect to an existing aivi host** — a person is minted on the host
  (`aivi people create NAME`, which offers to mint the token right away;
  `aivi people token PERSON` mints another bearer). Setup asks for the host
  url and the token, verifies both (`/health`, then `whoami` — a typo never
  persists), writes `~/.config/aivi.json` (0600) and installs both OpenCode
  plugins with `opencode plugin add`. The last line is a verified truth:
  "Signed in as …".
- **Create a new aivi server here** — installs the server into
  `<home>/app` with npm and seeds the home's OpenCode shape
  (`opencode.jsonc`, `.opencode/agents/` with `aivi.md`, `librarian.md`,
  `dreamer.md` — files that exist are never overwritten). Then it asks
  whether *this machine* signs in too or this is a *headless server*:
  this-machine mints the operator person and token (the secret is printed
  once, only its hash is kept), installs the plugins, offers
  `aivi service install` (declined: `aivi serve` in the foreground) and
  verifies the sign-in with `whoami`; headless prints the url and token to
  take to `aivi setup` on the client, choosing "Connect to an existing
  aivi host". In a script pass `--use this-machine|another` and
  `--name TEXT` (or `--connect --url URL --token TOKEN`) to skip the
  prompts. A re-run on a home that has people refuses identity minting;
  re-running `aivi setup` signed-in just verifies and refreshes the cached
  person. `server create` still works as the identity step behind setup and
  is not a person-facing command.

People, tokens and the client config are owned by [people](people.md).

## Plugins: `aivi install`

`aivi install discord` (or `slack`, or any npm package name) adds a plugin to
the server home and lets the plugin configure itself. Three steps, in order:

1. The package is npm-installed into `<home>/app` with `--save-exact`, so
   `aivi update` carries it along; an already-installed package is not
   fetched again.
2. The plugin's own `./setup` entry runs. Everything platform-specific lives
   in the plugin: it prints how to create the platform app, asks for the
   secrets (hidden), verifies each against the platform before anything is
   written, and writes its `modules.*` block into `config.json` and its
   tokens into `<home>/.env` (0600, never echoed). A write that leaves
   `config.json` unloadable is restored to the old bytes; an already
   configured module is never clobbered. Behind the command sits
   `aivi plugin setup SPEC`, not a person-facing command, and it needs an
   interactive terminal.
3. Aivi is restarted (when it runs as a service) and the command ends only
   in a verified truth: the module's own state — "Discord is running." A
   degraded module fails the command with the retry going on; without the
   service the command says how aivi comes back, and never restarts a
   foreground server itself.

The contract is one subpath: a package that exports `./setup` with a
default function is installable this way, whatever its publisher. A package
without one is still installed, and the command says it has no setup.

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
configured and system ones are edited in `config.json`. `jobs run ID` queues one
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

## Running as a service

`aivi service install` writes a per-user LaunchAgent (macOS,
`~/Library/LaunchAgents/ai.aivi.server.plist`, `ProcessType=Interactive`,
`KeepAlive`, logs under `<home>/state/logs/`) or a systemd user unit (Linux,
`~/.config/systemd/user/aivi.service`), then starts it. The unit runs the same
command as foreground `aivi serve`, so nothing about the server changes —
`aivi service start|stop|restart|status` control it, `service logs` follows the
log, `service uninstall` removes it. A headless Linux machine needs
`loginctl enable-linger` or the service stops with the session.

## Updates

`aivi update` brings the installed server and plugins to their newest releases.
The channel comes from `config.json` (`update.channel`, default `stable`). The
command resolves the target version, checks its Node requirement (provisioning
`<home>/runtime/` first when the machine's Node is unsuitable), stops the
server, installs with npm, restarts and probes `/health` before calling it
done. npm is the compatibility resolver: a plugin whose `@aivi/host` peer range
excludes the new host fails the install, is pinned at its current version —
logged as **disabled: no compatible release** — and is re-checked on every
future update. There is no rollback; sessions resume because state is SQLite
and OpenCode's own. `aivi upgrade` updates the CLI itself through its install
method (npm today) — the same install-method table `aivi uninstall` reads, so
the two can never disagree about what is installed.

## Uninstall

`aivi uninstall` deletes what aivi created on the machine and then the CLI
itself. It is not interactive: it prints the absolute paths it would delete —
the home, the client config, the background service, the OpenCode plugin entry,
and this CLI with the install method that answers for it — and stops without
deleting anything, exit non-zero, until `--confirm`. It deletes only a home with
a `config.json` in it, so a wrong `AIVI_HOME` or a stale `home` field in the
client config deletes nothing.

The order is the one that cannot leave a mess. The service unit goes first: a
unit whose server is gone gets relaunched forever. Then
`opencode plugin remove @aivi/opencode`, because OpenCode keeps its plugins in
its own global config, which the home never takes with it —
`opencode-attribution` is not aivi's, so it stays unless `--with-attribution`.
Then the home and the client config. The CLI goes last, because after that
spawn it can neither say nor read anything more. A server running in the
foreground is refused, as with `aivi update`: it is the person's own process to
stop. When no install method aivi knows answers, the files are gone and the
message says to remove the CLI the way it was installed.

## Projects

`aivi projects list|add|remove|purge` manage the checkouts under
`<home>/projects` ([projects](projects.md#adding-listing-renaming-removing)).
The host reads that directory at startup, so restart `aivi serve` after adding
or removing one.
