# @aivi/core

## 0.8.0

### Minor Changes

- [#41](https://github.com/aivi-hq/aivi/pull/41) [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The client record moves to `~/.config/aivi/config.json`.** One
  `aivi.json` file among unrelated tools' files became a directory of its
  own, which is also where a plugin's secrets can live out of every
  agent's reach (the forge's .pem placeholder now names it). The path is
  now one fact in core — `clientConfigPath()` — that the host and the
  OpenCode plugin share; the CLI keeps its own computation, because the
  CLI may not import core (the packaging test is that wall). `AIVI_CONFIG`
  and `XDG_CONFIG_HOME` precedence is untouched. No migration: fresh
  homes write the new path and nothing reads the old one.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The dispatcher's numbers get a home at the config root.** `dispatcher.pools`
  — named capacity pools `{model?, capacity, fallback?}` every service draws
  from — with the rule that **no pools means capacity is not moderated**
  (unlimited, the intended default). `dispatcher.timeouts` watches leases:
  `idle` (default `180m`, silence on an attached session before the slot is
  reclaimed) and `prepare` (default `5m`, a lease without a session).
  `orchestrator.elicitationKeepAlive` (default `5m`) is the orchestrator's own
  dial: how long an open in-session elicitation holds its slot. Fallback chains
  are load-checked — they must name pools that exist and must not cycle.
  `parseDuration` now **sums space-separated parts**: `1h 30m` is 90 minutes.
  The dispatcher that reads these numbers arrives with the next steps; naming
  them wrong fails at load already.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Knowledge search is on by default.** The `search` block now defaults to
  `{provider: "qmd", indexOnStart: true, maxPending: 32}`: an install that
  never mentions it searches, and `search: false` is the only off switch.
  Before this, a missing block meant every `knowledge_search` answered
  "Knowledge search is not enabled" — a silent no-search install, which the
  operator just lived through.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Lanes are core's; the orchestrator runs and emits.** `projects.<id>.lanes`
  is now a **core** ordered array (`projectLanesSchema`): each lane names a
  tracker platform's state, may name the `agent` that works it, may say
  `worktree: true`, and may override the success target (`complete`) or the
  failure target (`return`) — neighbours by default, a stop never moves, a
  state named nowhere is silence. Names unique and every override naming a
  lane of the same array are load-time errors; the old plugin-side lane maps
  die with it. `laneOf` is the one question the decision code asks.
  
  The host gains `host/src/orchestrator/`: the run machinery that owns a
  ticket's working session — durable ledger, worker tools (`ask`, `plan`,
  `work_complete`), nudges, lane moves decided from the array — and it **emits
  typed run events** (`started`, `question`, `plan`, `ended`) at subscribers.
  The orchestrator may not know a tracker exists (ruled 2026-10-01): it never
  calls one, never mirrors delivery, holds no conversation column. The event
  vocabulary is declared at `@aivi/plugin/run-events` for followers to type
  against. The project-setup context grows `forgeConfigured` and `agents(id)`
  — lane prompts pick from the OpenCode agents that can work the project's
  checkout, never type.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi add linear` is a guided install. It starts only when a live aivi answers `GET /health`, walks through creating the Linear app, catches the browser's install round on a loopback listener bound before the instructions print, and proves the wiring before writing anything: one throwaway ticket, waited on twice in sequence — Linear must post its creation to the webhook URL, then delegating it must create an agent session whose event arrives the same way. Each wait owns one live spinner line and settles with a verdict naming the likeliest cause; the installer archives the ticket and ends with its own last line. The Linear worker starts from the delegate mutation's own answer, a delegation no lane can run is un-taken and gets one plain fixed answer, and an archived ticket gets nothing from a session.
  
  The install contract hands the flow the runner's own `@clack/prompts` as `ctx.prompts` and drops the `note`/`log`/`ask` proxies: the slack, discord and browser installers draw their own lines with it, refusing clack's cancel symbol and empty submits as the non-answers they are. After a successful setup the CLI adds nothing — the flow's own outro is the last word; the CLI reports only a restart it performs itself.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **A plugin's module id is its package's short name.** Ruled 2026-09-30, the
  channels the day after: the word a person typed into `aivi add` is the word
  they write in `config.json`, so nobody opens a source file to learn what to
  call a plugin. Linear's module id is `tracker-linear`, Discord's
  `channel-discord` and Slack's `channel-slack`, which rename their config
  blocks (`plugins.tracker-linear`, `plugins.channel-discord`,
  `plugins.channel-slack`), Linear's project section (under both `projects.<id>`
  and `projectDefaults`), their `/status` ids and their log categories.
  `@aivi/forge-github` and `@aivi/browser` already read this way. The Linear
  installer reads and writes its block through the same `MODULE_ID` constant
  its declaration exports — no second spelling of the key survives in the
  package.
  
  What keeps the platform's short name is everything naming the **platform**
  rather than the package, and it is unchanged: the SQLite prefixes
  (`<platform>_turns`), the session and message id prefixes (`ses_linear_…`),
  the lease owners, `metadata.aivi.origin`, the webhook URL Linear's dashboard
  holds, and the `aivi linear`/`aivi discord`/`aivi slack` commands. Renaming a
  prefix would leave every conversation already bound in a database pointing at
  a table nobody opens again, and the old tables sitting there for ever; the
  host's channel and module contracts now say so in their own words.
  
  Core loses one GitHub fact it never read: `identity.github.app` and the `app`
  field of `AIVI_AGENT_BOT` are gone, no migration and no alias, because there
  is no installed config to break. The app id belongs to whoever mints a token
  as the app, which is `plugins.forge-github.app`; core keeps the commit pair —
  name and email — and knows no forge.
  
  The host quotes the identifiers it builds from a platform id. Unquoted, an id
  carrying dashes reads to SQLite as `tracker` minus `linear_turns`, and a
  third-party adapter would die at its first `CREATE TABLE`; quoting renames
  nothing, since `"linear_turns"` is the table `linear_turns` was, and the test
  is that dashed id meeting a real database.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The lane vocabulary of the dispatcher era, named before it is wired.**
  The lane overrides are `next` and `previous` (the follower-era `complete`
  and `return` die with this rename), and a lane may carry `queue: true` —
  the workflow's one queue lane, fresh work waiting for the worker lane it
  feeds — and `pool`, the dispatcher pool the lane's work will draw capacity
  from. Both are **inert** until the dispatcher is built; naming them is
  already load-validated: a second queue lane, a queue lane naming an agent,
  or a queue whose next lane (by order or by `next`) works nothing fails at
  config load, loudly. `writeProjectLinear` takes the written lane shape
  (`ProjectLaneInput`), which is what a wizard hands before core's defaults
  land.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The plugin contract is a kit. `@aivi/plugin` carries the setup, CLI and module contracts and the `./api` client, and plugins are plain commander subtrees built by `(ctx) => Command` factories — one command mechanism for the server's own commands and the plugins' alike. A plugin's main entry is `{ moduleId, configSchema, createModule }` with `./cli` and `./setup` subpaths, and its `./config` declares its module id and config shape: core stopped knowing plugin names, and the host composes the closed `config.json` schema from the listed packages at load. The `ask` wrappers are gone — a plugin's command receives the prompt rule as part of its context, and two clacks animating one terminal can no longer mangle each other. `@aivi/linear` is now `@aivi/tracker-linear` (the `linear` alias in `aivi add` is unchanged).

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Plugins can now contribute **project-section schemas**. A plugin's
  `./config` declaration carries optional `projectSchema` and
  `projectDefaultsSchema`; the registry feeds them to
  `composeConfigSchema`, which keys them by module id under every project
  entry and under `projectDefaults` — the same closure the top-level
  `plugins` record already got. A project section no registered plugin
  contributes is an unrecognized key, said by the composed schema and by
  the editor hint alike; a contributing section is validated and filled by
  its own plugin's defaults. Core keeps the core vocabulary of a project
  (`enabled`, `knowledge`) and reads nothing inside a contributed
  section — plugins read their own sections back with a cast, the
  `plugins.<id>` pattern one level down.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Quality gate back on, and green where it counts.** `npm run quality`
  (fallow) runs again at the end of `agentic:verify`, and the sweep it was
  disabled for is done: the dead exports and members it reported are gone
  (`ConversationStore.rebind`, `Dispatcher.idleTimeoutMs`,
  `LeaseStore.bySession`, `RunLinks.release`, the `worktreeHolding` /
  `SECTION` / wizard-helper exports nobody imported), the three copies of
  the wizard's `settled` live once in `@aivi/plugin`, the `ISO_INSTANT`
  regex moved to the time file that actually decides with it (breaking
  core's only import cycle), the ledger's three feedback patches became
  one, and the private types that leaked into exported signatures are
  exported. The plugin declarations' lazy `import('./module.ts')` — the
  design that keeps the CLI's config read cheap — carries a named
  suppression instead of a false alarm, as do the two host modules the CLI
  imports by string path from the installed server. What remains failing:
  22 advisory health targets (file-split suggestions), reported to the
  operator.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The streamed help page says whose tree it is: when a session is driven remotely (the exec door's child), the title carries `(remote)` after the version and the AIVI lettermark draws in caution amber (`#F59E0B`, entered `BRAND` as `remote` in `@aivi/core` and mirrored in the CLI's standalone copy). The machine fact decides the marker — no new state anywhere; the `(remote)` word is plain text so pipes and NO_COLOR terminals still read it when the color drops, as decoration already does.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The core of aivi now knows **systems, not plugins**. Core spells the two
  roles a project setup runs — `projectRoles = ['forge', 'tracker']` — and
  never names who fills them. Everything `linear` lived on moved out of
  core into `@aivi/tracker-linear`, which contributes its project sections
  through the compose mechanism: the lane merge, the one-team-one-project
  check, the section write and the lane-flag parsing are the tracker's now.
  
  Core also **has no clone**: `addProject` and `projectIdFromUrl` are gone,
  and `projects.ts` keeps only the directory operations (`removeProject`,
  `purgeProject`). Cloning carries credentials, so it belongs to a forge —
  the one that will exist as `@aivi/forge-github`.
  
  A plugin can take part through a new subpath, `./setupProject`: a
  contributor `{ role?, setup(ctx) }` that sets a new project up for its
  role and hands back `{ id, section?, cloned? }`. `aivi projects add
  [name]` is the runner: interactive, it walks the roles in order, offers
  the configured candidates per role (none skips, one is used, several are
  asked), runs the roleless contributors after the roles, and writes what
  each hands back through one composed-validated write, reading none of it.
  With no forge configured the project is **repo-less** — memory and
  knowledge, an untracked `source/` that says so plainly. `projects create`
  and the `--linear`/`--app`/`--lane`/`--unlane` flags are gone with it:
  Linear's own contributor asks for teams and lanes instead.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Self-knowledge — the assistant knows the installation and can change it.**
  A fifth knowledge kind, `manual`: core's `loadConfig` reads the `aivi-plugins`
  list in `<home>/app/package.json` and indexes every listed package's `docs/`
  directory as a knowledge source, in place — no copying, so the file keeps its
  one owner and `aivi upgrade` refreshes the words along with the code. A
  disabled plugin's docs still index; the package tag lives in the source id
  (`manual:<package>`). `@aivi/host` ships `configuration.md` in its own docs
  and the Linear and GitHub forge chapters now live with the plugins whose
  schemas they own.
  
  `aivi_config` is the doing side: read the live `config.json` as written,
  write one block validated against the composed closed schema (a refusal
  restores the previous bytes and says why), or remove one. The answer says
  how the change lands. The gate is the claim — `host.agentConfigEdits`, on by
  default; `false` and the tool is simply absent.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The contracts flip: the kit declares, the host follows.** `@aivi/plugin`
  now *declares* the shared vocabulary — `run.ts` (what a run is),
  `tracker.ts` (the `Tracker` stages and the `Platform` adapter), `channel.ts`
  (conversations on chat platforms), `module.ts` (the module contract, with
  `Store`/`Orchestrator`/`ConversationStore`/`Channels`/`PublicRoutes`/
  `TaskClaims`/`ToolClaims`/`SessionEvents` interfaces the host's classes carry
  `implements` clauses against). The kit depends on core, `@opencode/client`
  and `@clack/prompts` and on nothing above it; `@aivi/host` references the kit
  and imports its own vocabulary from it — the direction the references always
  pointed away from. Names that moved or renamed: `PlatformAdapter` →
  `Platform` (the word "platform" is the system aivi talks to over an API —
  channels, forges and trackers all use one), `LinearTracker` →
  `LinearPlatform`, `TrackerQuestion`/`TrackerPlanStep` are gone (the adapter
  renders the orchestrator's own `RunQuestion`/`RunPlan` — one shape, no
  field-by-field twins), and the run shapes, `WorkRequest`, `ChatCommandName`
  and the scheduler shapes (`Lease`, `JobEntry`, `ExecutionContext`,
  `RequestLogEntry`, `ToolCall`) have one home each: the kit for the
  run/tracker/channel/module contract, core for the data shapes. No runtime
  behavior moved: 452 tests, same green.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Editable prompts.** The texts aivi speaks by itself — the worker
  contract, the nudge, the feedback-loop opener, review posture, PR-body
  style, the escalation form, the job-result re-entry line — now have
  built-ins in core **and** editable copies in `<home>/prompts/`. `server
  create` copies them in when the home is born (never overwriting; each copy
  opens with a warning header); every text is **read at use**, so an edit
  lands on the next run and deleting the file is instant restoration. New
  command: `aivi prompts` lists the set and where each one's words come
  from, `aivi prompts install` re-copies what is missing, `aivi prompts show
  <name>` prints what aivi says today. Composition stays code: the owed
  thread list, ticket data and the state machine are never template
  material.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The redirect hook.** aivi's own plugin now denies boundary git — `git
  push`, `fetch`, `pull`, `clone`, `ls-remote`, `remote`, behind any flags or
  `-c` prefixes — **in aivi's runs only**, and says the way across instead:
  "git push is disabled in aivi runs — use aivi_push (and aivi_sync first if
  the remote moved)". Scoped by sessionID: the plugin asks the host's new
  `GET /run?session=` once per session (answered from the run ledger) and
  caches; a person's sessions never see the deny, and a host that cannot
  answer fails open — the worktree's no-credential mark is the wall, the
  hook is the signpost.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The tracker's stages: the interface lands, the events die.** The
  orchestrator and the tracker are now one division of labour said as an
  interface: a tracker module registers ONE `Tracker` — the board the
  eligibility walk reads (`projects`, `tickets`, an idempotent `moveTo`) and
  the stages every run walks through: `initWork` (open the ticket on the
  platform, return its **summary**), `ready`, `startWork?`, `question`,
  `plan?`, `endWork` (the closing words, awaited). The typed run-event bus is
  gone: no subscribing, no emitting; the lifecycle stages are awaited — their
  failure is the run's failure, said visibly — and the renders are
  fire-and-forget, retried by the tracker from its own outbox. The old
  conversation-keyed adapter contract is renamed `PlatformAdapter` and keeps
  its `@aivi/plugin/tracker` subpath.
  
  The ending walks the operator's order: `endWork` speaks first, the
  orchestrator then moves the ticket where its lane order chose — a move that
  misses retries at known instants and from the next boot, the debt living in
  the run's row until it lands — and **lastly** the lease returns. The worker's
  first prompt is the orchestrator's composition: a neutral line naming
  project, lane and checkout, the ticket's summary, and the worker contract.
  
  The walk is the only door for board work, and every run gets a real agent
  session: Linear's `initWork` delegates the ticket to its own app and the
  mutation's answer carries the session, so questions, plans and endings all
  render in the platform's own shapes — the sessionless ceremony, the read
  watermark and the stop-memory are dead. A stop **releases** the ticket back
  to the board; "not that one again" is the HITL label's job alone. A hand
  delegation gets one fixed refusal — work reaches the orchestrator through
  the board, not through a delegation — and the listener's delegation on a
  lane move dies: a lane change is a wake and nothing more. Fulfilment
  re-checks nothing: a person's move on a queued ticket cancels its request
  the moment the webhook lands.
  
  A session that will not die is struck at most `dispatcher.killAttempts`
  times (default 3) and then given up on — **not** on the slot: the capacity
  returns and the ending carries the machine-readable `kill-unconfirmed`
  code, which the tracker says loudly on its platform. And a closing that
  fails does not hold the ticket either: a person hears of it the moment it
  fails (the human label rides the ticket, help is on the way), the move
  lands and the slot comes back anyway, the closing owed to the next wake
  and the next boot. `linear.listener` is gone from the config; the wizard's
  queue question never offers a lane that names an agent.

### Patch Changes

- [#45](https://github.com/aivi-hq/aivi/pull/45) [`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The turn-end nudge lives. It was specified, budgeted and coded since
  2026-10-02 — and had fired exactly zero times, ever: it watched
  `session.idle`, which OpenCode's schema declares deprecated and its server
  never sends (verified against 2.0.23). A worker that ended its turn in plain
  text, after a rejected permission or into silence, just sat there. A turn
  ended is now `session.execution.succeeded` followed by a quiet span — new
  `orchestrator.turnEndDebounce`, default `5s`, cancelled by any new
  execution — with no unanswered question standing. Only true silence earns
  the nudge; the spent budget fails the run visibly. And a worker's permission
  prompt is now answered by aivi at once — reject, with the operator's new
  editable `permission-denied` prompt naming `aivi_ask` — instead of parking
  the worker until the idle clock kills it.

- [#42](https://github.com/aivi-hq/aivi/pull/42) [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Preparing the self-project. `AGENTS.md` was rewritten from the ground up:
  principles, decisions-by-precedent, the escape hatch, and the timer bans,
  with the shared vocabulary kept and the rest moved to the docs that own
  them — plugin seam words to `@aivi/plugin`'s new `docs/vocabulary.md`,
  channel words to `docs/channels.md`, exec words to `docs/operations.md`.
  `CONTEXT.md` is absorbed and gone. The shipped worker templates (dev,
  product, review) and the dreamer now deny `aivi_jobs`: scheduling belongs
  to the assistant, and a lane that gives itself work was never the design.
  The repository carries its own `.opencode/agents/` overrides with the
  graft workflow and the verify gate spelled out. The lane schema dropped
  its "inert until the dispatcher is built" descriptions — the dispatcher
  is built.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI's `main` is a table of contents now: the remote flag, the
  client-side set, the home commands, the exit ramp, the service verbs and
  the app-command mount are each a named function, and `add`'s setup and
  schema steps have their own names. Core's lane rules are four named
  checks instead of one refinement. The GitHub test double reads a call's
  shape in named parts. No behavior moved a word; 521 tests green before
  and after.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Dreaming reviews every registered channel by default. `origins` lost its
  hardcoded `["discord"]`: the schema default is now the empty list, and
  the dreaming operation fills it at run start with the channel modules
  actually registered — a Slack-only home reviews Slack without a config
  edit. A home with no channel module and no named origins fails the run
  saying so, instead of confidently reviewing nothing.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `host.public`: the address others reach aivi at (funnel, tunnel or proxy URL), asked once by `aivi setup` and preferred in every URL aivi prints for someone else to paste — the "another machine" connect lines, `aivi people create`'s token handoff, and `/status`. aivi keeps dialling `host.bind`/`host.port`; nothing is derived, and setup probes the address with nothing: during setup no server runs yet.

- [#37](https://github.com/aivi-hq/aivi/pull/37) [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A project with no repository is a supported state, and the config now says
  so. `projects.<id>.sync` (default `true`) keeps the hourly `projects-sync`
  job away from a project it has no business with; `aivi projects add` writes
  `sync: false` when no forge cloned a checkout. The job used to visit every
  project and answer `skipped: not a git checkout`, which it logged at `warn`
  and printed in its report — a supported configuration announced as an
  anomaly once an hour. A skip is what a person would act on: the four reasons
  that need a decision — local changes, a detached HEAD, no upstream, a
  diverged branch — are reported as they were.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - One assistant. The seeded home carries a single `assistant.md` — platform-neutral, the same being behind a chat message, an issue mention and a job delivery; what differs is the zoom, not the identity. `librarian.md` is retired and the Linear-seeded `aivi.md` merged into it; `discord.agent`, `slack.agent` and the Linear assistant now default to `assistant` (no persona-name slug), and Linear's module sends only facts (`platform:`, `issue:`, `project:`, `came by:`) — the do-not-do-the-work instructions live in the agent file, the whole boundary an operator can edit.

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Pool models now speak OpenCode's own spelling: `provider/model#variant`,
  parsed by OpenCode's own `Ref.parse` — the same one the agent-file
  frontmatter goes through. The dispatcher had a homegrown parser splitting
  the variant on `@`, a spelling nobody speaks: `provider/model#high` rode
  into the wire with `#high` glued inside the model id, and OpenCode
  answered `Model unavailable` (live, 2026-10-06) while the config looked
  right. The startup gate stays — a pool model that is no model reference
  is said at startup, never at a grant — now spoken by the parser that
  also answers the frontmatter.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The request diary: the host journals every arriving request — method, path, answer, time, headers, and the body's first 8 KiB — before any routing, so a refused bearer, an unowned path and a throwing handler are all visible. Credential headers are recorded as `[present]`, never as their value, and bodies are read from a clone so webhook signature verification still gets every byte. `aivi host clear-logs --older-than 30d` retires the old rows.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The small honest fixes from the code sweep. `ToolError` and
  `ConfigurationError` are defined in the kit's module contract and
  re-exported by the host, so plugin packages no longer import them from
  `@aivi/host`. Every durable write lands whole or not at all — temp next
  door, rename over; `.env`'s temp is created 0600 so a secret never sits
  world-readable. `manualSources` tells an absent install record from a
  corrupt one, naming the file like the host's registry reader already did.
  An interjection neither steered nor queued is said in the conversation,
  never a log line alone. A lane that lost its worker while a run waited
  releases its slot and says `lane-workless` instead of writing an
  `undefined` agent into a run row. The redirect hook reads `git remote`
  by the sub-verb: the name list and `get-url` cross nothing and pass;
  rewriting them stays refused. `aivi_config read` of a corrupt
  config.json names itself instead of a shapeless "Internal error". The
  Linear MCP proxy caps its body at 1 MiB like every other reader. The
  dreaming transcript says a *channel* names its speaker — the prefix is
  the shared engine's, not one platform's. The dead `--lane`/`--unlane`
  flag readers are gone; the wizard asks per lane now.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The last biome diagnostics are cleared.** The leftovers of the
  dead-code sweep (unused imports and bindings, `['aivi-plugins']` written
  as a computed key, string concatenation where a template belongs,
  `!x || x.state !== …` where `x?.state !== …` says it) are fixed, and
  `biome check .` reports nothing. The `ProjectEntry` alias, the write-only
  `config`/`clients` members on `LinearPlatform`, the unread `lane` in the
  webhook handler, and the unused `expire` argument were dead weight; the
  `aivi configure` output is byte-identical.

## 0.7.1

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.

## 0.7.0

### Minor Changes

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now a composed module like the channels, not a host resource. It claims its own `aivi_browser` descriptor at the `tools` door at start and releases it at stop, and the host serves that claim to the OpenCode plugin like any other tool. The `/v1/browser` endpoint, the `browser` field on host services and resources, and the `HostClient.browser` method are gone — the host holds no browser concept at all. `aivi install browser` now ends in the same verified truth as any other module: "Browser is running."

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now an opt-in install, not core. The `browser` block no longer prefaults: a fresh home has no browser and the plugin never sees an `aivi_browser` tool. `aivi install browser` puts `@aivi/browser` into the server home and its `./setup` writes the launch block; a configured block with a missing package names the command that fixes it.

- [#26](https://github.com/aivi-hq/aivi/pull/26) [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` with its own package version, read from `package.json` at runtime. The major is the contract, the minor is features: a client ahead of its host is refused with 403 `server_version_too_low`, a client behind the host's major with `client_version_unsupported` (`aivi upgrade`); a client behind within the major is served. `GET /version` and `GET /health` answer without the header. This release starts `@aivi/cli` and `@aivi/host` as a changesets `fixed` group, so their versions stay one number from here on. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL.

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The OpenCode plugin JITs its tools: each capability's owner contributes a descriptor, the host serves them at `GET /v1/tools` and dispatches calls at `POST /v1/tools`, and the plugin registers exactly what the host offered at load. The plugin hardcodes no aivi tools; its own `aivi_connection` reports reachability, version and which tools this process loaded.

## 0.6.0

### Minor Changes

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Command output is readable on a terminal and unchanged JSON in a pipe. Core
  gains an output renderer (`OutputBlock`, `renderOutput`, `formatTimestamp`,
  `print`): without a hand-written shape a command's value is shown as colored
  `util.inspect`; a command may pass blocks (log, heading, divider, table, raw
  `json`) instead — `aivi slack manifest` renders raw JSON so it stays
  paste-ready. Help loses its color theme; the wordmark stays.

## 0.5.0

### Minor Changes

- [#20](https://github.com/aivi-hq/aivi/pull/20) [`ad2895a`](https://github.com/aivi-hq/aivi/commit/ad2895a635925a5b23208bd34c915f7fca19f4ba) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Who may talk is no longer config's job: `access.dm` and the per-channel
  `users` lists are gone, and a person's link is the only admission. A linked
  account may DM aivi and is heard wherever aivi listens; an unlinked account
  is ignored in channels, and in a DM it can only redeem a code, answered at
  most once per start with the link hint. `/link` redeems wherever aivi
  listens, linked or not. The installers no longer ask for anyone's user id,
  and `/steer` now speaks as the person and stamps `metadata.aivi.person`, so
  a session knows who steered it. Breaking, before any live install: configs
  carrying `access.dm` or `users` fail validation.

## 0.4.0

### Minor Changes

- [#16](https://github.com/aivi-hq/aivi/pull/16) [`5d865bf`](https://github.com/aivi-hq/aivi/commit/5d865bfcea07feb096370b4fb0a27d8ea831433c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI's face: both CLIs (the thin client and the server app) move onto
  commander for parsing, routing and help. Help is grouped by kind and themed in
  the brand colors, every command answers `aivi <command> --help` for itself,
  flags are declared per command (an unknown flag in the wrong place is an
  error), and a typo'd command is answered with the nearest real one. The
  wordmark banner prints on a terminal; pipes and `NO_COLOR` keep plain text, so
  stdout stays a machine contract. Colors come from Node's built-in
  `util.styleText` in the same hex palette the logs use; the Node floor moves to
  26.1.0 for its hex support. Command bodies are extracted into
  `packages/app/src/commands/` grouped by category.

- [#16](https://github.com/aivi-hq/aivi/pull/16) [`bc1f731`](https://github.com/aivi-hq/aivi/commit/bc1f7318b2a4a68ee514eb0d4f280c32c1acc252) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A plugin can extend the operator CLI: where `./setup` is the install-time
  subpath, `./cli` is the runtime one — a package that default-exports a
  `PluginCliCommand` from `./cli` is mounted into the server CLI under Channels
  whenever the package is installed, with parsing and help owned by the app's
  commander and `run` receiving a `PluginCliContext` (loaded config, store
  bracket, the shared JSON stdout, the host poke, one prompt). `aivi discord`,
  `aivi slack` and `aivi linear` now come from their own packages through that
  contract. The brand color moves to `#3B82FF` — the wordmark and the help terms
  in the CLI, and the `aivi·host` log category, share it.

## 0.3.0

### Minor Changes

- [#13](https://github.com/aivi-hq/aivi/pull/13) [`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi install discord|slack|NPM-SPEC` adds a plugin to the server home and lets it configure itself, replacing the manual config entry for the channels. npm installs the package into `<home>/app` (`--save-exact`, so `aivi update` carries it along), then the plugin's own `./setup` entry runs: it prints how to create the platform app, asks for the tokens (hidden), verifies each against the platform before anything is written — Discord's application id is derived from the bot, Slack's tokens answer `auth.test` and `apps.connections.open` — and writes its `modules.*` block into `config.json` and its secrets into `.env` (0600, never echoed; a write that leaves the config unloadable is restored). Then aivi restarts and the command ends in a verified truth: the module's own state from `/v1/status` ("Discord is running."). An already configured module is never clobbered, a foreground server is never restarted behind the operator's back, and a package without a `./setup` export is still installed, told as having no setup command. The contract is one subpath — any package exporting `./setup` with a default function installs this way; the plumbing (`aivi plugin setup SPEC`, not person-facing) and the write helpers (`writeConfigBlock`, `upsertEnvFile`) live in the app and core packages.

## 0.2.0

### Minor Changes

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Roles arrive: a person carries an open string array of roles (`operator`
  manages people and maintenance; new people default `member`), the store
  migration grants `operator` to everyone who existed, and `whoami` answers the
  real roles instead of the hardcoded stub. People management over the API —
  listing, creating (optionally with roles: `aivi people create NAME --role
  operator`) and minting tokens for — now requires an operator bearer; the
  store-direct path on the server itself stays the operator at the console.
  Wider per-operation enforcement lands with the ops dispatcher
  (docs/plans/operator-api.md).

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI can run the server in the background and update it. `aivi service
  install|uninstall|start|stop|restart|status|logs` wrap a per-user LaunchAgent
  (macOS) or systemd user unit (Linux). `aivi update` resolves the channel from
  `config.json` (`update.channel`, default stable), provisions `runtime/` Node
  when the target demands it, stops the server, installs via npm — whose peer
  resolution pins a plugin at "disabled: no compatible release" when its range
  excludes the new host — restarts and probes `/health`. `aivi upgrade` updates
  the CLI through npm. Channel plugins now declare `@aivi/host` as a
  peerDependency, making npm the compatibility resolver.
