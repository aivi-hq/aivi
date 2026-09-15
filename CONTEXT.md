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
| source / kind | a configured document path, core or per-project, labelled `doc`, `decision`, `memory`, `conversation` |
| dreaming | a scheduled agent that turns conversations since its last run into `facts.md` and proposals |
| origin | `metadata.aivi.origin` on every session aivi creates: a channel module id (`discord`, `slack`), `job`, `dreaming`; on messages also `job-result` |

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
  ([application](docs/application.md)).
- **Failed vs blocked** is decided by one thing: was the prompt accepted?
  `TurnNotStarted` before it → `failed`; anything unverifiable after it →
  `blocked`, capacity kept, human resolves. Exception: a conversation turn
  interrupted by a *restart* is discarded and the person told, because its
  only external effect is the reply; jobs still block.
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
- **No timers hold state.** The loop sleeps until `Store.nextDue()` and is
  woken by whatever changed the queue; `pollMs` (30 s) is only a safety net.
  SQLite is the single truth, so restarts reconcile nothing.
- **Shutdown aborts** running runs; they end `blocked`. A grace period is a
  design choice not yet made ([shutdown-hooks](docs/backlog/shutdown-hooks.md)).
- **The agent file is the boundary.** Discord, jobs and dreaming run the
  configured OpenCode agent as defined; aivi adds only what the file cannot
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
- **Memory is files** inside a knowledge source, never system-prompt state.
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
- **Scripts see a normal shell** minus aivi's own secrets (`.env` keys and the
  fixed token names); an allow-list would break what works from a terminal.
- **Blocked runs hold global capacity** on purpose until per-project pools
  exist ([projects-and-capacity](docs/backlog/projects-and-capacity.md)).
- **Linear config exists ahead of the module** to record the lane → app →
  agent invariant; nothing reads it yet.

## Where each fact lives

| Fact | Owner |
| --- | --- |
| Config fields, task kinds, secrets and `.env` order | [docs/configuration.md](docs/configuration.md) |
| Startup, shutdown, `tick`, failed/blocked outcomes | [docs/application.md](docs/application.md) |
| Tool ids, plugin loading, permission matching, session driver contract | [docs/opencode.md](docs/opencode.md) |
| Knowledge scope, kinds, refresh | [docs/knowledge.md](docs/knowledge.md) |
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
client against a mock server). `scripts/` holds the smoke, schema, and live
checks; `schemas/` is generated. aivi reads one **home** (`~/.aivi`, or
`AIVI_HOME`): `aivi.json` (or a git-ignored `aivi.local.json`), `.env`, and
`state/` with `aivi.sqlite`, the QMD index, and dreaming transcripts.
`example/` is a home with everything enabled (`npm run aivi` points there);
the tests load it.

## Open threads

- Live gates: OpenCode passed 2026-09-15 with the schedule handler (session
  lookup, `agent.list` validation, create/refuse); the tool has since been
  renamed to `aivi_jobs` and the route to `/v1/jobs`, so that gate needs a
  re-run after `opencode service restart`. Discord still to re-check after
  today's changes (the lift into the host, the report union, `{ run }` in the
  delivery context): librarian directory, feedback messages, job outcomes
  re-entering threads, report threads adopting run sessions, `/status` lists.
  Slack passed live on 2026-09-15 after the jobs/runs split: DM, mention →
  thread, `/spider-status`, reactions, outcomes re-entering a thread, report
  threads adopting the run's session, `aivi_jobs` through the plugin.
- Next work, in order: [roadmap](docs/roadmap.md#next-in-order-of-intent).
- The docs restructure proposed in `docs/review/docs-consistency.md` §3 is
  deferred until the projects work settles.
