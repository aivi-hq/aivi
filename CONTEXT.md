# aivi in one page

Read this at the start of a session. It holds what is not written anywhere
else: the shape of the system, the decisions and their reasons, and which
document owns which fact. Details live behind the links.

## What it is

An always-on teammate around OpenCode v2. OpenCode stays the runtime (agents,
sessions, providers, tools, permissions). aivi adds a shared knowledge server,
scheduled work, and channels such as Discord and Slack, all started by one
`aivi serve`.
Ordinary OpenCode installs reach the knowledge server through a small plugin.
Principles: simplicity in architecture and use, and a focus on performance.

Packages and their responsibilities: [README](README.md#packages). Everything
runs in one process; adapters are optional modules with a start/stop contract.

## Vocabulary

| Word | Meaning |
| --- | --- |
| task | what to do: `kind` + parameters (`system.check`, `knowledge.index`, `runs.prune`, `shell`, `opencode.prompt`, `dreaming`) |
| job | a definition: a task plus *when*, recurring (`cron` + `timezone`) or one-off (`at`), with `id`, `title`, `resource`, `report`, `misfire`, `enabled`; state `active`/`paused`/`done`/`missed`; source `config` (aivi.json), `system` (seeded by the host: `retention`), `agent` (created through `aivi_jobs`) or `operator` (`aivi jobs add`); one outstanding run at a time |
| run | one execution of a job: `queued → running → succeeded / failed / blocked`, or `cancelled`, or `missed`; one row, one audit trail, always a `jobId`; snapshots the task |
| missed | a run recorded for an occurrence found later than its misfire grace; terminal, never executed, reported like a failure |
| turn | one prompt to a verified final answer in one OpenCode session (`runTurn`); a conversation turn is of kind `message` (a person) or `job` (an outcome re-entering) |
| pool / lease | named capacity (`local-model`, `maintenance`); runs and conversation turns take leases from the same pools |
| blocked | ended without proof that the external side stopped; keeps its capacity until `runs resolve` |
| failed | ended before anything external happened; the next occurrence retries |
| report | where an outcome goes: `{to: "session", session}` (back into that session as a prompt), `{to: "channel", module, channel}` (posted by a channel module), or nothing |
| channel module | a chat platform adapter (`discord`, `slack`) implementing the host's `ChannelModule` contract; the host owns its inbox, bindings, engine and turn runner |
| conversation | what a channel module binds to one OpenCode session: a thread, a DM, or a whole channel |
| source / kind | a configured document path, core or per-project, labelled `doc`, `decision`, `memory`, `conversation`; a file belongs to its most specific source |
| project | a repository the team works on: a clean git checkout at `<home>/projects/<id>`, discovered from that directory (`projects.<id>` in `aivi.json` only overrides), indexed by the docs convention (`projectDefaults`), with its memory at `<home>/memory/<id>`; channels talk *about* projects, workers (Linear, later) work *in* them; a memory home without a checkout is a *removed* project (still listed and searchable until `projects purge --confirm`) |
| dreaming | a scheduled agent that turns conversations since its last run into `facts.md` and proposals |
| origin | `metadata.aivi.origin` on every session aivi creates: a channel module id (`discord`, `slack`), `job`, `dreaming`; on messages also `job-result` |
| progress / placeholder | one message per running conversation turn, edited in place with the agent's phase and tool calls from the host's OpenCode event stream, gone when the answer lands |
| model pin | a conversation's `/model` choice, stored on its session binding and applied to the OpenCode session before each turn until `/new`; without one the agent file's model runs |
| chat command | a slash command on a channel platform (`/new`, `/status`, `/context`, `/search`, `/model`, `/stop`, `/steer`, `/jobs`, `/help`): one shared table in the host, each platform only translates |

## Decisions and why

- **Two queues, one capacity.** Conversation turns are not host runs: they run
  in order per conversation, continue its session, reply into it, and start in
  seconds. Runs are fresh sessions in any order. Both take leases from the
  same pools ([architecture](docs/architecture.md#two-queues-one-capacity)).
- **Definitions and executions are two tables.** A job says what and when; a
  run is one execution and always belongs to a job, so a one-off is a job
  with `at` and not a special run. Operators reason about `jobs …`, inspect
  `runs …` ([configuration](docs/configuration.md#jobs-runs-tasks)).
- **It matched or it didn't.** A due occurrence found within
  `misfire.graceSeconds` runs; found later it becomes one `missed` run for the
  whole gap, never executed, reported like a failure, and the job moves on.
  No coalesce-and-run-late, no silent skip; "run whenever" is a large grace
  ([architecture](docs/architecture.md#sqlite-and-croner)).
- **Retention is a system job.** `scheduler.retention` seeds `retention`
  (task `runs.prune`) into the same table, so it is listed, pooled, run and
  reported like everything else instead of being a hidden timer
  ([operations](docs/operations.md#how-runs-end)).
- **Failed vs blocked** is decided by one thing: was the prompt accepted?
  `TurnNotStarted` before it → `failed`; anything unverifiable after it →
  `blocked`, capacity kept, human resolves. Exception: a conversation turn
  interrupted by a *shutdown or restart* is discarded and the person told,
  because its only external effect is the reply; conversations with queued
  messages hear that aivi is going offline and that they will be answered
  after; jobs still block. A `/stop` discards the same way, with its own
  notice.
- **Verified final answer**, never idleness: `finalAnswer` reads the native
  context (`user → assistant(finish: stop) → idle(succeeded)`, no unfinished
  tools).
- **OpenCode discovery per unit of work** (one file read per job or turn), no
  cached client, so `opencode service restart` is picked up by the next turn.
  aivi owns the local service's lifecycle by default (`opencode.lifecycle:
  own`): one restart at `aivi serve` startup so the current plugin build and
  `AIVI_TOKEN` are in, a start whenever it is missing, never a stop later.
  `ensure` and `discover` are the smaller degrees; the example home uses
  `discover` so tests never touch a developer's OpenCode.
- **No polling, no periodic timers.** The loop sleeps until `Store.nextDue()`
  and is woken by whatever changed the queue; channel engines tick on the same
  wake; turns take permission prompts (`permission.asked`) and channels take
  progress from the one OpenCode event stream. SQLite is the single truth, so
  restarts reconcile nothing.
- **Shutdown aborts** running runs; they end `blocked`. A grace period is a
  design choice not yet made ([shutdown-hooks](docs/backlog/shutdown-hooks.md)).
- **The agent file is the boundary.** Discord, jobs and dreaming run the
  configured OpenCode agent as defined, including its model (OpenCode's API
  does not substitute it the way the TUI does; aivi sets it on the session
  every turn); aivi adds only what the file cannot
  know (`external_directory` for configured sources; dreaming's two `edit`
  targets) and never a deny. Restrict an agent in its own file. The home is
  the OpenCode location (`<home>/.opencode/agents/`), so example sources need
  no external rules at all ([opencode.md](docs/opencode.md)).
- **Two browsers, on purpose.** OpenCode's `browser.*` drives the desktop
  app's browser; aivi's `aivi_browser` drives one persistent Chrome for
  unattended sessions and shared logins. The example agents deny the former
  so Discord and jobs are never offered a browser that cannot connect.
- **A second chat platform is glue.** The host owns the inbox, the
  claim-with-lease transaction, conversation↔session bindings with adoption and
  seeds, restart recovery, the verified-turn driver and reply splitting; a
  channel module registers one `ChannelModule` and keeps only its gateway,
  routing, sending and commands ([channels](docs/channels.md)).
- **Progress is one edited message, never a flood.** While a turn runs, one
  placeholder in the conversation says what the agent is doing (fed by the
  host's single OpenCode event stream, edited at most every 2 s) and is
  deleted when the answer is posted or edited into the failure notice, so a
  conversation ends with the answer only. Per channel: `progress: silent |
  status | tools` ([channels](docs/channels.md#progress-while-a-turn-runs)).
- **Commands are adapter UI over host operations.** One command table in the
  host feeds Discord's registration, Slack's manifest and `/help`; a module
  translates, never decides. A `/stop` is the person's choice, so the turn is
  discarded like a shutdown (not blocked) and said so; a `/steer` goes into
  the running turn with `delivery: "steer"` and is marked as its own; a
  `/model` pin is a session property set before each turn and refused while
  one runs; `/agent` is deliberately absent (personalities by configuration)
  ([channels](docs/channels.md#chat-commands)).
- **Memory is files** inside a knowledge source, never system-prompt state.
  `<home>/memory` (org) and `<home>/memory/<project>` are always `memory`
  sources; one dreaming run decides where a fact belongs, because channels
  carry no project and there is one bag of conversations.
- **The repository is a clean checkout; the home describes the project.**
  `projects.<id>` in `aivi.json`, checkout at `<home>/projects/<id>`, a
  company-wide `docs/` convention (`docs` as `doc`, `docs/adr` as `decision`)
  with per-project override, and projects discovered as the directories of
  `<home>/projects`, so adding a project is a `git clone` and a repository
  works the same outside aivi. No `aivi.project.json`
  ([projects](docs/projects.md)).
- **Agents create jobs, jobs do not.** Any agent with the plugin may schedule
  through `aivi_jobs` (`POST /v1/jobs`, the one job mutation on the
  API, on by default; `scheduler.agentSchedules: false` turns it off); the host derives agent and
  directory from the calling session and refuses sessions with origin `job` or
  `dreaming`, unless a Discord thread adopted that session. Whoever may talk
  to the agent is the authority; jobs are the admin's responsibility
  ([configuration](docs/configuration.md#agent-created-jobs)).
- **Outcomes are conversations, not posts.** The default report of an
  agent-created job is `session`: the outcome re-enters the asking thread as
  a turn and the librarian says what matters. A channel report opens a thread
  that continues the run's own session, so replying never meets an agent that
  does not know what it did ([discord](docs/discord.md)).
- **An optional module never takes the host down**, at startup either: a
  failed `start` is retried with backoff for as long as the host runs and shows
  as `degraded` in status; only a `ConfigurationError` (something the operator
  must change) is fatal ([operations](docs/operations.md#startup)).
- **Scripts see a normal shell** minus aivi's own secrets (`.env` keys and the
  fixed token names); an allow-list would break what works from a terminal.
- **No build step.** Packages run from `src/*.ts` via Node's type stripping;
  `tsc --noEmit` checks. This commits the installation to a git checkout in
  `~/.aivi` with a `~/.local/bin` symlink, never `npm install -g` (Node does
  not strip types under `node_modules`)
  ([installation](docs/backlog/installation.md#decision-2026-09-15-the-installation-is-a-git-checkout)).
- **Blocked runs hold global capacity** on purpose until per-project pools
  exist ([projects-and-capacity](docs/backlog/projects-and-capacity.md)).
- **Linear config exists ahead of the module** to record the lane → app →
  agent invariant; nothing reads it yet.

## Where each fact lives

| Fact | Owner |
| --- | --- |
| Config fields, task kinds, secrets and `.env` order | [docs/configuration.md](docs/configuration.md) |
| Startup, shutdown, `tick`, failed/blocked outcomes, resolving blocked work, CLI | [docs/operations.md](docs/operations.md) |
| First run, librarian in OpenCode, first project and channel | [docs/getting-started.md](docs/getting-started.md) |
| Module contract (`HostServices`, `Store.migrate`, `fail`) | [docs/architecture.md](docs/architecture.md#one-application-contained-modules) |
| Tool ids, plugin loading, permission matching, session driver contract | [docs/opencode.md](docs/opencode.md) |
| Knowledge scope, kinds, refresh | [docs/knowledge.md](docs/knowledge.md) |
| What a project is, home layout, docs convention, who works in one | [docs/projects.md](docs/projects.md) |
| Dreaming run, memory contract, dreamer boundary | [docs/dreaming.md](docs/dreaming.md) |
| Channel module contract, shared inbox/engine/turn runner, ids, report shape | [docs/channels.md](docs/channels.md) |
| Discord behavior, setup, recovery | [docs/discord.md](docs/discord.md) |
| Slack behavior, app manifest, setup | [docs/slack.md](docs/slack.md) |
| Browser service | [docs/browser.md](docs/browser.md) |
| Decisions | [docs/architecture.md](docs/architecture.md) |
| Status per milestone, live gates, next steps | [docs/roadmap.md](docs/roadmap.md) |
| Frozen product requirements | [docs/requirements.md](docs/requirements.md) |
| Unscheduled ideas | `docs/backlog/` (one file per topic) |
| Review findings (not specs; each has a disposition section) | `docs/review/` |

## Where things are

`packages/{core,host,knowledge,browser,channel-discord,channel-slack,opencode,app}` with tests in
`packages/*/test/*.test.ts` (`node:test`; real SQLite and QMD, the real v2
client against a mock server). No `dist/`: sources run as they are.
`scripts/` holds the smoke, schema, and live checks; `schemas/` is generated. aivi reads one **home** (`~/.aivi`, or
`AIVI_HOME`): `aivi.json` (or a git-ignored `aivi.local.json`), `.env`,
`projects/<id>/` checkouts, `memory/` (org, and `memory/<id>/` per project), and
`state/` with `aivi.sqlite`, the QMD index, and dreaming transcripts.
`example/` is a home with everything enabled (`npm run aivi` points there);
the tests load it.

## Open threads

- Live gates (2026-09-15): OpenCode, Discord and Slack all passed after the
  jobs/runs split and the channel lift: DMs, mention → thread, `/status`,
  reactions, `aivi_jobs` through the plugin, outcomes re-entering a thread,
  report threads adopting the run's session, the progress placeholder in both
  channels, Slack replies as a `markdown` block. Not yet seen live: dreaming
  writing into a project's memory; Slack's `response_url` answered 500 to a
  `markdown` block for `/…-context` (plain-text fallback added); the
  `/model`, `/stop`, `/steer`, `/jobs` and `/help` commands on either
  platform (Slack needs the manifest in [slack.md](docs/slack.md#setup)
  re-applied first).
- Next work, in order: [roadmap](docs/roadmap.md#next-in-order-of-intent).
- The docs restructure proposed in `docs/review/docs-consistency.md` §3 landed
  2026-09-15 (`getting-started.md`, `operations.md`; `application.md` folded
  into `architecture.md`).
