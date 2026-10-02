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
| task | the payload a job executes: `prompt` or `shell` (the only kinds a person or agent authors), or `invocation` (the `name` of an operation plus opaque `args`); never a thing you trigger — you trigger jobs, and a run is one execution of one |
| operation | a system capability of the host or a module, claimed by name exactly once at composition (a second claimant is fatal; a run of an unclaimed name fails with its name); seeded as `system` jobs by the module that owns it, shown by operation name in every view |
| job | a definition: a task plus *when*, recurring (`cron` + `timezone`) or one-off (`at`), with `id`, `title`, `resource`, `report`, `misfire`, `enabled`; state `active`/`paused`/`done`/`missed`; source `config` (config.json), `system` (seeded by the host: `retention`, `projects-sync`), `agent` (created through `aivi_jobs`) or `operator` (`aivi jobs add`); one outstanding run at a time |
| run | one execution of a job: `queued → running → succeeded / failed / blocked`, or `cancelled`, or `missed`; one row, one audit trail, always a `jobId`; snapshots the task |
| missed | a run recorded for an occurrence found later than its misfire grace; terminal, never executed, reported like a failure |
| turn | one prompt to a verified final answer in one OpenCode session (`runTurn`); a conversation turn is of kind `message` (a person) or `job` (an outcome re-entering) |
| pool / lease | a slot in a named capacity pool; every service that runs model work draws from the same numbers (today `scheduler.resources`; the dispatcher's `dispatcher.pools` are the built target: [orchestrator](docs/orchestrator.md)) |
| blocked | ended without proof that the external side stopped; keeps its capacity until `runs resolve` |
| failed | ended before anything external happened; the next occurrence retries |
| report | where an outcome goes: `{to: "session", session}` (back into that session as a prompt), `{to: "channel", module, channel}` (posted by a channel module), or nothing |
| channel module | a chat platform adapter (`discord`, `slack`) implementing the host's `ChannelModule` contract; the host owns its inbox, bindings, engine and turn runner |
| conversation | what a channel module binds to one OpenCode session: a thread, a DM, or a whole channel |
| source / kind | a configured document path, core or per-project, labelled `doc`, `decision`, `memory`, `conversation`; a file belongs to its most specific source |
| project | what the team works on: one directory `<home>/projects/<id>` holding a checkout (`source/`), its memory (`memory/`) and worker worktrees (`worktrees/`), discovered from that directory (`projects.<id>` in `config.json` only overrides), indexed by the docs convention (`projectDefaults`); channels talk *about* projects, workers (Linear, later) work *in* them; a project with `memory/` but no `source/` is a *removed* project (still listed and searchable until `projects purge --confirm`); a project may be **repo-less** — a forge gives the checkout, so with no forge a project has memory and knowledge but no source |
| forge / tracker | the two **systems** core names (in that order): a **forge** owns repositories (clones a project's checkout, branches, pull requests), a **tracker** owns tickets (lanes, delegation). Core spells the roles, never which plugin fills them; `projectRoles = ['forge', 'tracker']` |
| project contributor | a plugin's `./setupProject` export — `{ role?, setup(ctx) }` — that sets a new project up for its role and hands back the config section core writes at `projects.<id>.<moduleId>`; core computes which are *configured* (a `plugins.<id>` block exists), offers one per role (asks if several), and runs the roleless ones after the roles; the plugin clones/asks, core writes bytes and reads none |
| platform adapter | the translator between aivi and one ticket system, at the `@aivi/plugin/tracker` seam (the interface `Platform`, declared where the tracker stages live): platform events in (`started`/`prompted`/`updated` on a *conversation*, the platform's word for one working session), neutral updates out (`issue`, `assign`/`unassign`, `startSession`, `comment`, `laneStates`, `ask`/`plan`, `resultShown`, `apply`). Linear's adapter is `tracker-linear/src/tracker.ts` |
| tracker | the stages the orchestrator walks every run through, on one `Tracker` interface (declared in `@aivi/plugin/tracker`, followed by the host): the board the eligibility walk reads (`projects`, `tickets`, idempotent `moveTo`, `ticketLane` before any ending move) and the stages `initWork` (open the ticket on the platform, return its summary), `ready`, `startWork?`, `question`, `plan?`, `endWork` (closing words; awaited). The tracker keeps the pair (its session ↔ the OpenCode session ↔ the ticket) in its own namespaced table, posts people's messages into the worker's session itself, and retries its own closings at wake and boot. Lanes, guards and the exit contract stay the machinery's. Linear's tracker is `tracker-linear/src/work.ts` with its stages in `module.ts`; the machinery is `host/src/orchestrator/` |
| forge adapter | the translator between aivi and one repository host, at the `@aivi/plugin/forge` seam: the facts a clone cannot see (which pull request stands for a branch, what its review said) and the operations only it may authenticate — everything that reaches `origin`: clone, the `source/` sync, push. An **installation** is the grant from an account to the app, and aivi speaks through exactly one, as its own app and never as the person at the keyboard; its posts are signed `_worker: aivi · <role>_` in the text a human reads, so a wake can tell them from replies. Local git — worktrees, commits — is not a forge's, and the line is remote, not clone. `forge-github` is the one built; the host-side registry asks "who owns this project's remote?" (built 2026-10-02): forges register at module start, and the `source/` sync is the first question it answers — an owned checkout syncs through its forge, authenticated as the app |
| dreaming | a scheduled agent that turns conversations since its last run into `facts.md` and proposals |
| origin | `metadata.aivi.origin` on every session aivi creates: a channel **platform** id (`discord`, `slack`, `linear` — the platform a
  conversation is on, not the package that speaks for it, which is why
  `@aivi/tracker-linear` writes `linear`), `job`, `dreaming`; on messages also `job-result` |
| progress / placeholder | one message per running conversation turn, edited in place with the agent's phase and tool calls from the host's OpenCode event stream, gone when the answer lands |
| model pin | a conversation's `/model` choice, stored on its session binding and applied to the OpenCode session before each turn until `/new`; without one the agent file's model runs |
| chat command | a slash command on a channel platform (`/new`, `/status`, `/context`, `/search`, `/model`, `/stop`, `/queue`, `/jobs`, `/link`, `/help`): one shared table in the host, each platform only translates. A message arriving mid-turn **interjects** (steers) by default; `/queue` is the way behind |
| attribution | which names a commit carries: the bot as author/co-author from aivi's identity, the human as author from their own git config — a git fact, it never consults whoami ([people](docs/people.md)) |
| association | which person a record belongs to: link codes, job ownership, session stamps, memories — a host fact, taken from the calling bearer, never from what a message claimed ([people](docs/people.md)) |
| link | a channel account bound to a person, minted by `aivi link` and redeemed by `/link`; the binding is also the channel admission — who may talk, while config names only where ([people](docs/people.md)) |
| exec channel / relay | `aivi --remote`: a websocket (`/exec`) on the host's own port carrying terminal bytes — argv and keystrokes go out, the child's terminal comes back; commands are never remapped to JSON operations, the CLI itself is the protocol ([operations](docs/operations.md#running-remotely)) |
| driven session | the far end of an exec channel: the host's child with a closed environment, `(remote)` in its banner, refusing at invocation the commands that act on the machine you type on ([operations](docs/operations.md#running-remotely)) |

## Decisions and why

- **Two queues, one capacity.** Conversation turns are not host runs: they run
  in order per conversation, continue its session, reply into it, and start in
  seconds. Runs are fresh sessions in any order. Both take leases from the
  same pools ([architecture](docs/architecture.md#two-queues-one-capacity)).
- **Definitions and executions are two tables.** A job says what and when; a
  run is one execution and always belongs to a job, so a one-off is a job
  with `at` and not a special run. Operators reason about `jobs …`, inspect
  `runs …` ([configuration](packages/host/docs/configuration.md#jobs-runs-tasks)).
- **It matched or it didn't.** A due occurrence found within
  `misfire.graceSeconds` runs; found later it becomes one `missed` run for the
  whole gap, never executed, reported like a failure, and the job moves on.
  No coalesce-and-run-late, no silent skip; "run whenever" is a large grace
  ([architecture](docs/architecture.md#sqlite-and-croner)).
- **Retention and project sync are system jobs.** `scheduler.retention` seeds
  `retention` (invocation `runs.prune`) and `scheduler.projectsSync` seeds
  `projects-sync` (invocation `projects.sync`, fast-forward only) into the same
  table, so they are listed, pooled, run and reported like everything else
  instead of being hidden timers
  ([operations](docs/operations.md#how-runs-end)).
- **Modules schedule through the host, and the host executes nothing of theirs.**
  A module declares `jobs(config)` (seeded as `system` jobs that vanish with
  the module) and claims operation names in its `start` through a claims door
  scoped to its id; the scheduler fires the `invocation` task and hands the run
  to whoever claimed the name. A name is claimed exactly once — a second
  claimant or two system jobs sharing an id is fatal at startup, an unclaimed
  name fails the run with its name. The host's own five operations are claimed
  into the same registry; only `prompt` and `shell` are tasks an agent can
  author ([configuration](packages/host/docs/configuration.md#tasks)).
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
- **OpenCode discovery per unit of work** (one file read plus one HTTP probe
  per job or turn), no cached client, so `opencode service restart` is picked
  up by the next turn. Discovery is tolerant: a server is alive when it
  answers HTTP on its registered endpoint, whatever its version — the SDK's
  replace-on-version-mismatch machinery never runs against a server aivi
  found, and the server's version is logged once per process. aivi owns the
  local service's lifecycle by default (`opencode.lifecycle:
  'own'`): one restart at `aivi serve` startup so the current plugin build is
  in, a start whenever it is missing, never a stop later.
  `ensure` and `discover` are the smaller degrees; the default for a real
  installation is `own`, and a home used by tests sets `discover` so they
  never touch a developer's OpenCode.
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
  the OpenCode location (`<home>/.opencode/agents/`), so sources inside the
  home need no external rules at all ([opencode.md](docs/opencode.md)).
- **Two browsers, on purpose.** OpenCode's `browser.*` drives the desktop
  app's browser; aivi's `aivi_browser` drives one persistent Chrome for
  unattended sessions and shared logins, and is an opt-in plugin
  (`aivi add browser`) rather than core. The seeded agents deny the
  former so Discord and jobs are never offered a browser that cannot
  connect.
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
  discarded like a shutdown (not blocked) and said so; a message that arrives
  mid-turn interjects — `delivery: "steer"`, marked as part of the running
  turn (ruled 2026-10-02; `/steer` died and `/queue` took its place); a
  `/model` pin is a session property set before each turn and refused while
  one runs; `/agent` is deliberately absent (personalities by configuration)
  ([channels](docs/channels.md#chat-commands)).
- **Memory is files** inside a knowledge source, never system-prompt state.
  `<home>/memory` (org) and `<home>/projects/<id>/memory` are always `memory`
  sources; one dreaming run decides where a fact belongs, because channels
  carry no project and there is one bag of conversations.
- **The repository is a clean checkout; the home describes the project.**
  `projects.<id>` in `config.json`, checkout at `<home>/projects/<id>/source`, a
  company-wide `docs/` convention (`docs` as `doc`, `docs/adr` as `decision`)
  with per-project override, and projects discovered as the directories of
  `<home>/projects`, so **core has no clone** — a forge's `./setupProject`
  clones into `source/` (a repo-less project is created without one), and a
  repository works the same outside aivi. No `aivi.project.json`
  ([projects](docs/projects.md)).
- **Agents create jobs, jobs do not.** Any agent with the plugin may schedule
  through `aivi_jobs` (`POST /jobs`, the one job mutation on the
  API, on by default; `scheduler.agentSchedules: false` turns it off); the host derives agent and
  directory from the calling session and refuses sessions with origin `job` or
  `dreaming`, unless a Discord thread adopted that session. Whoever may talk
  to the agent is the authority; jobs are the admin's responsibility
  ([configuration](packages/host/docs/configuration.md#agent-created-jobs)).
- **Outcomes are conversations, not posts.** The default report of an
  agent-created job is `session`: the outcome re-enters the asking thread as
  a turn and the librarian says what matters. A channel report opens a thread
  that continues the run's own session, so replying never meets an agent that
  does not know what it did ([discord](docs/discord.md)).
- **An optional module never takes the host down**, at startup either: a
  failed `start` is retried with backoff for as long as the host runs and shows
  as `degraded` in status; only a `ConfigurationError` (something the operator
  must change) is fatal ([operations](docs/operations.md#startup)).
- **One config file, and it is yours.** One `plugins` object holds one block
  per plugin, keyed by the plugin's own **module id, which is the package's
  short name** (`plugins.tracker-linear`, `plugins.forge-github`) — the word a
  person typed into `aivi add`, so nobody reads a source file to learn what to
  write in `config.json`. The platform's short name survives only where it names
  the **platform** and not the package: Linear's table prefix and session ids
  stay `linear`, because renaming a prefix orphans every conversation already
  bound to it. What enables a module is the **`aivi-plugins` list** in
  `app/package.json`, which holds npm **package names** — the install fact
  (`aivi add @someone/aivi-cool-plugin`) — while the module id is the config
  key, the logger category and the `/status` id, declared by the package's
  own `./config` entry. The server composes the closed schema from the listed
  plugins, so a block for an unlisted plugin fails and an editor says so; a
  listed plugin with no block takes its own defaults or its own complaint.
  No module points at a separate config file. aivi and the
  operator edit the live `config.json` itself, so it never goes under version
  control; a home in a git repository tracks only a template, which the first
  run copies ([configuration](packages/host/docs/configuration.md#home)).
- **Scripts see a normal shell** minus aivi's own secrets (`.env` keys and the
  fixed token names); an allow-list would break what works from a terminal.
- **One compiled shape, locally and on npm.** Packages compile to `dist/`
  with TypeScript 7 (`npm run build`, incremental). Every `exports` map
  defaults to `dist/` — what consumers, deploys and `pack:smoke` run — and
  adds a `development` condition resolving to `src/`, activated only by the
  test and typecheck commands; nothing is rewritten at publish, and nothing
  ships from a package root. The
  git-checkout installation decision is superseded; packages publish to npm.
- **Capacity becomes the dispatcher's pools.** Ruled 2026-10-02: one
  installation-wide pool set; the orchestrator asks, the dispatcher decides;
  a lease idles out on its own instead of a blocked run holding capacity
  forever ([orchestrator](docs/orchestrator.md); the pre-dispatcher
  `scheduler.resources` and the blocked-holds-capacity rule are the
  interim, superseded by that build).
- **An agent session is a conversation the tracker answers.** The
  orchestrator owns the run: durable record, worker session (the lane's agent
  in the project checkout), worker tools, the first prompt's composition, and
  the target lane its lane order chose; it walks every run through the
  tracker's **stages** and never learns what a ticket platform is (ruled
  2026-10-02). The Linear module answers them — pair in its own table,
  closing words in its own order (result, note, delegate), the orchestrator
  moving the ticket after it speaks and returning the lease last, people's
  messages posted straight into the OpenCode session, the open form the
  discriminator between answer and steer. A hand delegation gets one fixed
  refusal: work reaches the orchestrator through the board. The **assistant**
  still rides the channel machinery; worktrees wait for a forge. Stop means
  stop: the worker is interrupted and the run cancelled, its session kept for
  inspection; the delegate stays sitting so the trail is readable, and the
  ticket goes back to the board — a stop remembers nothing
  ([linear](docs/linear.md); what is left: [plans/linear.md](docs/plans/linear.md)).
- **One Linear app, one persona, lanes pick agents.** The primary app carries
  the workspace's data feed and every agent-session webhook on one route and
  authorises the Linear MCP; extra apps are faces (name and icon, no routing
  meaning). Routing is deterministic: a delegation whose lane maps an agent
  runs it; everything people send directly — mentions, delegations nothing
  claims — lands on the assistant (`linear.agent`), which answers or refuses
  and never does lane work. The soul (`<home>/soul.md`) is aivi's declared
  voice, injected by the plugin into every agent's prompt and hot-reloaded;
  what aivi is *called* is `identity.name`, which the plugin states ahead of
  it, so the name has one owner and a soul edit cannot change it
  ([linear](docs/linear.md), [configuration](packages/host/docs/configuration.md#the-soul)).
- **A repository is a Linear team.** Routing reads the issue's team only
  (`projects.<id>.tracker-linear.teams`, a list: several teams may share one
  checkout); lanes, branch-name format and labels all live per Linear team,
  while a Linear *project* is the humans' epic with a completion date and
  aivi never consults it ([linear](docs/linear.md)).
- **Attribution follows who launched the shell**, never what a prompt said. A
  worker aivi launched is unattended, so it commits as the bot — sole author
  and committer — because the worktree it works in carries `identity.github` as
  its git author plus `agent.autonomous = true`, which is how the commit plugin
  learns to add no trailer. The identity resolves as one pair from the first
  source that answers: `identity.github`, else `opencode.coauthor` in the
  machine's git config, else the aivi app. The project's `source/` is never
  marked, so attended work keeps a human author with the agent as co-author
  ([linear](docs/linear.md), [configuration](packages/host/docs/configuration.md#fields)).
- **Tokens identify, never authorize — except people management.** Auth is
  `none`: commands are open, and a bearer only names the caller for
  association — whose job, whose link, whose memory; unknown or missing stays
  anonymous. Only whoami and link creation reject anonymous callers, because
  their answers must be attached to a person, and managing people requires
  the `operator` role (an open string array on the person; everyone who
  existed when roles arrived is one). The rest is ungated until the ops
  dispatcher enforces roles per operation. A non-loopback bind warns that
  anyone who can reach the address can use the commands
  ([people](docs/people.md)).
- **Config names places; the link admits people.** A channel message reaches
  the agent only when its sender is linked to a person and aivi listens where
  it landed: any DM, or an `access.channels` entry with its trigger. There are
  no user ids in config.json — `access.dm` and per-channel `users` are gone
  (2026-09-22, before any live install). `/link` redeems wherever aivi
  listens, linked or not: redemption is its own proof. An unlinked DM sender
  is answered once per start with the link hint; in channels aivi stays
  silent ([discord](docs/discord.md#behavior)).
- **The lane array *is* the workflow, and it is core's.** Ruled 2026-10-01,
  superseding the `projectDefaults.tracker-linear.lanes` lookup table:
  `projects.<id>.lanes` is an ordered array of `{ name, agent?, worktree? }`
  spelled as the tracker platform spells its workflow states. A lane naming
  an agent is worked; naming none is worked by humans. Success moves a
  ticket to the **next** entry, failure to the **previous** one — the
  neighbours by default, overridden per lane by `next` and `previous`
  (the old `complete`/`return` names die with the dispatcher build); a stop
  moves nothing; a state outside the array is silence. **Closed states are
  never written** — the tracker recognizes them by type. `worktree` defaults
  to false and matters once a forge gives worktrees. The orchestrator decides
  the target lane from the array and performs the move itself
  ([linear](docs/linear.md), [orchestrator](docs/orchestrator.md)).
- **The orchestrator may not know a tracker exists.** Ruled 2026-10-01,
  shaped 2026-10-02: it orchestrates and calls the `Tracker`'s stages — one
  interface, no events, no knowing which platform answers. It never mirrors
  delivery and holds no conversation column — its ledger is aivi's fact about
  the *work* plus the move it owes; the tracker's pair and owed closings live
  in the tracker's own tables, retried in its own time. The row-as-outbox and
  the run-event bus are both superseded ([orchestrator](docs/orchestrator.md#the-trackers-stages)).

## Where each fact lives

| Fact | Owner |
| --- | --- |
| Config fields, task kinds, secrets and `.env` order | [packages/host/docs/configuration.md](packages/host/docs/configuration.md) |
| Startup, shutdown, dispatch, failed/blocked outcomes, resolving blocked work, CLI | [docs/operations.md](docs/operations.md) |
| First run, librarian in OpenCode, first project and channel | [docs/getting-started.md](docs/getting-started.md) |
| Module contract (`AiviServices`, `Store.migrate`, `fail`) | [docs/architecture.md](docs/architecture.md#one-application-contained-modules) |
| Tool ids, plugin loading, permission matching, session driver contract | [docs/opencode.md](docs/opencode.md) |
| Knowledge scope, kinds, refresh | [docs/knowledge.md](docs/knowledge.md) |
| People, person tokens, linking, the client config (`~/.config/aivi.json`) | [docs/people.md](docs/people.md) |
| What a project is, home layout, docs convention, who works in one | [docs/projects.md](docs/projects.md) |
| Dreaming run, memory contract, dreamer boundary | [docs/dreaming.md](docs/dreaming.md) |
| Channel module contract, shared inbox/engine/turn runner, ids, report shape | [docs/channels.md](docs/channels.md) |
| Discord behavior, setup, recovery | [docs/discord.md](docs/discord.md) |
| Slack behavior, app manifest, setup | [docs/slack.md](docs/slack.md) |
| Linear behavior (the tracker's stages, stops and their trails, attribution), setup | [docs/linear.md](docs/linear.md) |
| The work-pull flow (orchestrator and dispatcher: lanes, priority, queue lanes, pools, leases, how work gets picked) | [docs/orchestrator.md](docs/orchestrator.md) |
| The work-pull flow, the tracker's stage contract, worker tools, completion and question contracts, recovery | [docs/orchestrator.md](docs/orchestrator.md) (the design history: [docs/plans/templates/orchestrator.md](docs/plans/templates/orchestrator.md)) |
| Browser service | [docs/browser.md](docs/browser.md) |
| Decisions | [docs/architecture.md](docs/architecture.md) |
| Status per milestone, live gates, next steps | [docs/roadmap.md](docs/roadmap.md) |
| Product requirements | [docs/requirements.md](docs/requirements.md) |
| Unscheduled ideas | `docs/backlog/` (one file per topic) |
| Scheduled work in progress, as checklists that shrink as steps land | `docs/plans/` ([cli-refactor](docs/plans/cli-refactor/index.md), [linear](docs/plans/linear.md), [client-aivi](docs/plans/client-aivi.md), [git workflow](docs/plans/git-workflow.md), [templates](docs/plans/templates/index.md), [orchestrator build](docs/plans/orchestrator.md)) |
| Review findings (not specs; each has a disposition section) | `docs/review/` |

## Where things are

`packages/{core,host,knowledge,plugin,browser,channel-discord,channel-slack,tracker-linear,forge-github,opencode,cli}` with tests in
`packages/*/test/*.test.ts` (`node:test`; real SQLite and QMD, the real v2
client against a mock server). `dist/` is built by `npm run build`
(TypeScript 7, incremental); tests need no build — they run from sources
under Node's type stripping, resolving workspace packages through the
`development` exports condition.
`scripts/` holds the smoke and live checks; the editor schema is generated at
runtime into `<state>/cache/schema.json`, composed from the plugin list. aivi reads one **home** (`~/.aivi`, or
`AIVI_HOME`): `config.json` (the live config, never version-controlled), `.env`,
`app/package.json` (the installed server, and the `aivi-plugins` list that
enables plugins), `projects/<id>/{source,memory,worktrees}` per project,
`memory/` (org), and `state/` with `aivi.sqlite`, the QMD index, the editor
schema cache, and dreaming transcripts.
`dev/` is a real development home, produced by `npm run aivi:cli setup` against
the local build (only its README is tracked; everything else, including the
app manifest setup writes, is generated or git-ignored). `npm run aivi`
runs the server boot (`@aivi/host/server`) directly against it.

## Open threads

- Live gates (2026-09-15): OpenCode, Discord and Slack all passed after the
  jobs/runs split and the channel lift: DMs, mention → thread, `/status`,
  reactions, `aivi_jobs` through the plugin, outcomes re-entering a thread,
  report threads adopting the run's session, the progress placeholder in both
  channels, Slack replies as a `markdown` block. Not yet seen live: dreaming
  writing into a project's memory; Slack's `response_url` answered 500 to a
  `markdown` block for `/…-context` (plain-text fallback added); the
  `/model`, `/stop`, `/queue` (and the default interjection), `/jobs` and `/help` commands on either
  platform (Slack needs the manifest in [slack.md](docs/slack.md#setup)
  re-applied first).
- Next work, in order: [roadmap](docs/roadmap.md#next-in-order-of-intent).
- Client-side aivi — persons, soul, link codes, attribution — is scheduled:
  [plans/client-aivi](docs/plans/client-aivi.md).
