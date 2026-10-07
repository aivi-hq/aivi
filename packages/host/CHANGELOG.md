# @aivi/host

## 0.9.0

### Minor Changes

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`1b7a209`](https://github.com/aivi-hq/aivi/commit/1b7a2092b65170f4e91e86c37a00f97effc4bb8f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **A person's move wins.** The webhook is the trigger to end a job
  gracefully, and a missed delivery no longer ends as a surprise: the
  adapter now reads Linear's archive as a neutral `archive` change, so
  deleting a ticket interrupts its live run, says the stop in the session,
  and releases only after the run is properly disposed of. Before any
  ending move the orchestrator asks the board `ticketLane` where the ticket
  sits (new `Tracker` member): gone, or anywhere but where the run worked
  or the target, means a person moved it — the owed move is spent, never
  undone, and the log says so. And the `ask` form's options are
  suggestions now (`custom: true`): a person who *types* an answer instead
  of picking one closes the record with their own words — before, a free
  answer to an options question was refused by OpenCode and the form stood
  unsettled (live, 2026-10-02, the riddle ticket).

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`49977a5`](https://github.com/aivi-hq/aivi/commit/49977a51a8186c4fffecd740b41bdd6590b2a653) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **A stop sticks, and cleans up after itself.** A stop from the worker's
  conversation or a delegate removal now puts the human label on the ticket
  **before** the run ends — the ending wakes the walk in the same breath, and
  the unmarked stopped ticket came straight back as fresh work. A stop OpenCode
  would not answer the interrupt for ends carrying `stop-unconfirmed` (new
  `FailureCode`): the run still ends — its lease, its clocks and its worktree
  are aivi's to take back whatever OpenCode says — but the closing says a
  worker may still be running instead of claiming "stopped at your request",
  and marks the ticket for a person. And a stopped run's **worktree is torn
  down**: uncommitted work and local commits go with it (what was pushed
  stays pushed); the native session stays for inspection. The test fake
  learned to mutate labels like Linear does — which exposed one test that had
  pinned the re-claim as intended, and one tail that walked a marked ticket
  back only because the fake lied.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`e2b7730`](https://github.com/aivi-hq/aivi/commit/e2b7730ed2e9b5bc1cb1c577fbd890f518fe101d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **An answer lands in OpenCode before the books move.** The answer's
  delivery was: flip the ledger to `working`, prompt the worker, close the
  form. When the prompt threw — OpenCode down at that instant — the queued
  path's catch had already given the reacquired lease back, leaving a
  `working` run with no lease, no turn and no clock: nothing timed it out,
  and a person's answer bought silence until the next boot. The order is now
  OpenCode first, the books second (ruled 2026-10-03): the prompt goes in,
  and only when it lands does the run flip back to `working` and the form
  close as the record. A refused prompt moves nothing — the run stays parked
  on its open form, the keep-alive re-arms as it stood, the person hears the
  failure in the conversation, and the answer is giveable again. A delivery
  whose ledger guard missed — the other answer of a race won, or a stop
  landed in flight — now says so (`answer.duplicate`) instead of pretending;
  `ledger.resumed` answers `undefined` when its guard misses.

- [#41](https://github.com/aivi-hq/aivi/pull/41) [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The client record moves to `~/.config/aivi/config.json`.** One
  `aivi.json` file among unrelated tools' files became a directory of its
  own, which is also where a plugin's secrets can live out of every
  agent's reach (the forge's .pem placeholder now names it). The path is
  now one fact in core — `clientConfigPath()` — that the host and the
  OpenCode plugin share; the CLI keeps its own computation, because the
  CLI may not import core (the packaging test is that wall). `AIVI_CONFIG`
  and `XDG_CONFIG_HOME` precedence is untouched. No migration: fresh
  homes write the new path and nothing reads the old one.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`69a6c28`](https://github.com/aivi-hq/aivi/commit/69a6c28f3d2cfd25b045d364b02513e802fa2a62) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The dispatcher's clocks are milliseconds at the unit.** `Dispatcher`
  takes `idleMs` and `prepareMs` as numbers — the config load parses the
  duration strings once (`application.ts`), and the waiting itself has
  never needed the strings. A test hands 30 in and watches a clock fire
  in milliseconds instead of paying a real second per test; the duration
  grammar people write (`180m`, `5m`) is untouched. `expire`'s third
  parameter, a `now` the body never read, is gone.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`dc2c16a`](https://github.com/aivi-hq/aivi/commit/dc2c16aa1fa68173d478f5c331bf67f0c56500c9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The exec door: `/exec` as a websocket upgrade on the host's own listener. The version gate, the bearer and the **operator** role are run by hand (node hands upgrades to the door, not through hono), and every arrival — run or refused — writes one diary line: person, argv, source address, exit code or reason. An operator's `aivi <argv>` runs as a child on a PTY with a closed environment carrying `AIVI_OPERATOR_BEARER` (the bearer this very connection presented, so `whoami` and association name the remote human), or as plain pipes when the client's stdout is not a TTY, where stderr rides base64 and JSON stays untouched. A machine whose node-pty cannot load answers exec attempts with `remote exec unavailable on this host` and never takes the host down; the macOS prebuild's missing execute bit is repaired once per process. New server-side dependencies: `ws`, `node-pty`.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d71af5b`](https://github.com/aivi-hq/aivi/commit/d71af5b0a51f80123031c9938a96b723bff7b17e) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The git crossings are injectable now: the orchestrator's git tools take a `git` dep, the worktree machinery a `WorktreeGit`, the project sync a `ProjectGit`, and the GitHub forge a `GitRunner`. Production leaves the real binary; the tests answer these instead, so the tools' decisions — which argv where, which refusal means what — are units, not git simulations. The killed slow tests are back: the CLI mechanism, the exec relay, the forge, the worktree teardown, the project sync, and the git tools, all in well under a second.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`edd4bfc`](https://github.com/aivi-hq/aivi/commit/edd4bfc3a2704c46d445b38697b5d89fbe5eda7d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Interjection is the default; `/steer` died and `/queue` took its place.**
  A message that arrives while the conversation's turn runs now goes **into**
  that turn — `session.prompt` with `delivery: "steer"`, marked
  `metadata.aivi.steer = <the turn's message id>` so the answer verification
  counts it as part of the turn (ruled 2026-10-02: the prompt is delivered
  with steer by default, or queue when requested). A reaction acks it; the
  turn's own answer speaks for it; a steer that fails queues the message
  anyway, logged, never lost. `/queue TEXT` is the explicit way **behind** the
  running turn. Both channels and the shared command table (Slack manifest,
  Discord registration, `/help`) move together.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI stays in its lane: it resolves the one machine fact — a home here, or none — once per run, shows it in the help header (`home: ~/.aivi` / `home: none`), and injects it into every command provider: `registerCommands(program, machine)` and the new `PluginCliContext.machine`. Providers decide membership themselves: a machine without a home registers only what it can do there (`setup`, `upgrade`, `uninstall` — the exit ramp exists wherever the CLI is), and a typed command it does not have is honestly `unknown command`. Nothing is hidden after the fact anymore. The logging options `--log-level`/`--log-format` moved off the root onto `serve`, the command that actually logs, so a provider never pollutes commands that are not its own.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`295ee5f`](https://github.com/aivi-hq/aivi/commit/295ee5f3b34f746cb0588c0c1aa293aab27e41b1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **`turnTimeoutMs` is gone from every platform.** The option existed three
  times: Discord and Slack used it honestly (a chat turn longer than it was
  discarded with a reason), Linear's copy promised — in its own description —
  that "a worker turn longer than this is interrupted and ends stopped", while
  the value only ever bounded the **assistant** turns of the channel engine.
  Worker turns were never bounded by any clock: the dispatcher's idle timeout
  times silence, and every tool event re-arms it. The operator ruled the whole
  option removed (2026-10-03) rather than one more half-true knob: no clock
  bounds a turn now. The bound's right home is the dispatcher, which watches
  every session — the turn-lease design sketches its shape, and
  `docs/plans/orchestrator.md` carries the ticket. Until it lands, a hung
  assistant turn holds one of `maxConcurrent` slots and ends only when it
  ends, with OpenCode's own errors, or with shutdown.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - One `aivi` binary. The `aivi forward` relay — the second bin, the second help tree, and the argv byte-contract that trapped command bodies behind it — is gone: the CLI now mounts the installed server's operator commands **in-process**, a dynamic import of the home install's `./cli` onto its own commander tree, so `aivi --help` shows machine and operator commands together, ctrl+c hits one process instead of a three-process group, and the identity and plugin-setup steps are direct calls into the installed code. Machine commands still never load server code: a half-installed or broken app install shows the machine help with a one-line notice. `@aivi/app` retires into `@aivi/host`, which exports `./cli` — the command surface `serve` composes and the CLI mounts — and is published no more; `aivi serve` finally gets the `state/logs/aivi.log` file its documentation always promised. Setup's server-package flag is `--host-package` (it was `--app-spec` in 0.8.1), and its `--plugin` flag is retired: setup installs the server alone, plugins join afterwards with `aivi add` — which runs each plugin's own setup before listing it, so a package is never listed without its config block — and `aivi add` takes `file:` and directory specs, the way a development home installs its workspace builds. The `aivi-plugins` array in `<home>/app/package.json` is the one place that says which plugins exist: `aivi add` and `aivi remove` write and erase all three facts — the npm package, the list entry, and the `plugins.<id>` block in config.json — and rebuild the editor schema into `<home>/state/cache/schema.json`, which config.json's `$schema` hint points at.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`4d2e509`](https://github.com/aivi-hq/aivi/commit/4d2e5091c0351920c9dbdd6af351cf66f26212b3) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The git tools split, and the push gets smart.** `aivi_push` moves a
  worker's commits to the remote and unstucks them itself: it fetches the
  branch fresh through the forge, fast-forwards when it can, merges the
  remote's real work in when it can (a conflict names the files and leaves
  the merge in progress for the worker to resolve with plain git), and when
  the divergence is only the worker's own rewrite — every remote commit
  patch-equivalent — the force goes through, leased on the sha just fetched
  so a person's newer commit can never burn. `aivi_sync` brings all the
  remote's branches in (pruned, refs only) and answers behind/ahead, plus
  how far the default branch moved. `aivi_pr` is reduced to *opening the
  pull request*: it pushes first if anything is unpushed, answers an open
  pull request instead of doubling it, and opens a fresh one when the last
  merged and new commits came since. On the forge contract, `push` is pure
  transfer now (plain, or `--force-with-lease` on the caller's `lease`),
  opening a pull request is its own member `openPr`, and `fetchRefs` is the
  sync's transfer.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`bf6c5b0`](https://github.com/aivi-hq/aivi/commit/bf6c5b052735c0f6b2331cb972519f08b2d9ed43) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The command sets answer the channel themselves, from the machine fact rather than a blocklist. `MachineStatus` carries two more facts: `remote` (this process is the far end of an exec session — the door stamps `AIVI_EXEC_SESSION` into the child's closed env) and `clientConfig` (the client record's path, which decides `configure`'s membership the day it lands). A driven session refuses the commands that act on the machine you type on (`setup`, `upgrade`) with `this acts on the machine you type on`, refuses to `uninstall` the home it is driving, and refuses to chain a second `-r` hop. Over the channel `serve` refuses too — the server is the thing being driven — and locally it now answers `server already running at <url>` when a host already holds its configured endpoint, instead of trying to boot a second one. Help shows the whole truth either way; a refused command is refused when run, never hidden from the page.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`9d067d3`](https://github.com/aivi-hq/aivi/commit/9d067d398b08ef0a79d839259ecc288ed4b162e4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The dispatcher: the only part that knows how much capacity is left.**
  `host/src/dispatcher/` — durable leases (granted before a session exists,
  attached when one is provided, released, expired) and the state machine
  over them. A **new** session walks the pool's `fallback` chain and is
  created in the first pool with room; a **resume** returns to the pool the
  session was created in and waits there rather than move — running a session
  in another pool would change its model and lose its prefill cache. At
  session create **the pool decides the model**; the agent file's own model
  wins only in a pool that names none, and in unlimited mode — which is what
  no `dispatcher.pools` means: every request granted, capacity not moderated.
  The dispatcher **kills a session before freeing its slot**: an unconfirmed
  kill keeps the slot unavailable rather than double-book capacity that may
  still be spending. At boot, persisted leases are reconciled against
  OpenCode's reality — and a server that does not answer defers the whole
  pass: silence is never proof that work died. Ending a lease never deletes
  the session. Inert until the orchestrator starts asking.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`3c6ee07`](https://github.com/aivi-hq/aivi/commit/3c6ee07b69dfdf3ff084aed1093e6364883106a9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The dispatcher's queue: a full pool says *wait*, not *no*.** A lease
  request that finds no slot is accepted into the pool's in-memory queue —
  one place per service per pool — and when a slot opens the dispatcher
  grants the lease and calls the service's own callback with its request id
  and the lease. A resume waits in its own pool and returns there, never
  into a fallback that happened to have room. Cancellation loses the queue
  place and nothing more; the queue is ephemeral by design, and a restart
  simply lets callers ask again for work that is still relevant. A service
  nobody registered to hear gets the plain refusal — a lease granted to
  nobody is a leak, not a queue.
  
  The orchestrator re-checks the ticket before starting from the queue:
  moved, blocked or claimed in the meantime, and the lease goes straight
  back; a person's move on a queued ticket cancels its request. A queued
  delegation says so to the delegator, keeps its Linear pair while it
  waits, and starts the moment capacity opens — attaching to the very
  session it was delegated in.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`4c126ea`](https://github.com/aivi-hq/aivi/commit/4c126ea8f6f8d75ffe943767a7e86109517ec9d2) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Elicitations hold their slot for a while, then cost nothing.** A worker
  that asks a person a question parks its run in `awaiting_input` — the
  claim and the session stand, and the OpenCode form is the durable record
  of the wait. The slot is held for `orchestrator.elicitationKeepAlive`
  (default 5 minutes); after that the lease is **released, not expired**:
  nobody is killed, and the freed capacity goes to the walk. When the answer
  arrives it reacquires capacity and resumes the same session — the pool it
  was born in, never a fallback — and a full pool queues the reacquisition
  like any other resume: the answer's words wait with the request, the
  person hears that the worker wakes when a slot opens, and a refusal is
  said too. A stop reaches a parked run; a wait that survived a restart
  re-arms its clock from the boot.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`60090e2`](https://github.com/aivi-hq/aivi/commit/60090e289863139770fcbc90d3b8a8127590d60f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The eligibility walk: work is pulled, not pushed.** The orchestrator now
  walks each tracker's board — lanes right to left (work closest to done
  first), tickets top to bottom, a queue lane as the **bottom** of the worker
  lane it feeds — and starts work through the dispatcher: nothing starts
  without a lease, the delegation path included, and a full pool answers the
  delegator in words instead of silence. A queue pickup moves the ticket into
  the worker lane before the worker starts; the claim mirrors the lease, and
  every ending gives the slot back and wakes the walk again. A refusal stops
  the pass for that pool only; other pools walk on.
  
  A person's stop is now a fact the walk respects: the follower remembers it,
  the memory survives restarts, and only the person's next move — a lane move
  or a fresh run — answers it. Picked-up work has no agent session, so its
  ending is said with the installation's own app: closing note and move on
  the ticket, question as a ticket comment; endings that arrived while nobody
  followed are rendered at boot from the orchestrator's own record through
  the follower's watermark.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`1ba4d46`](https://github.com/aivi-hq/aivi/commit/1ba4d46ea25ec79cb28a421fd511f462f70f39d1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The feedback loop.** A run that starts with open review threads on its
  pull request is *told* — the first prompt names each unresolved thread and
  teaches the loop (agree: do the work, aivi_push; disagree: a grounded
  comment; both end with aivi_respond_feedback, which resolves) — and the
  open thread ids of that moment are snapshotted on the run row: the only
  ones the completion gate can ever owe. `aivi_work_complete` with success
  now re-reads the pull request: owed threads still open refuse the
  completion as a tool error listing them, each refusal counts, and at the
  third a person is asked through the same durable form aivi_ask makes —
  never doubled, and an answer to *that* form resets the count. A clean
  start owes nothing (a reviewing agent posts its findings and finishes
  freely), failure completions are exempt, a human resolving is
  authoritative, and plain conversation comments are context only. New
  tools: `aivi_review` (what the gate checks, visible), `aivi_respond_feedback`
  (answer a thread or comment), and `aivi_submit_review` — the review
  agent's inline findings as real review threads; APPROVE is not offered,
  that button stays human. On the forge contract: `PrFacts.mergeable`
  ("main moved, you conflict" arrives in the first prompt),
  `ReviewFacts.comments`, `commentPr` and `submitReview`; the ledger grows
  migration 4 with the loop's `feedback` JSON.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`a253aab`](https://github.com/aivi-hq/aivi/commit/a253aab2d0910e7052f8a3c3727996ea11aa4090) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **`aivi_pr`: the worker's word that the branch is ready, routed to the
  forge.** The worker calls it with the pull-request title and description;
  the orchestrator checks the run, asks the registry who owns the project's
  remote, reads *locally* what there is to push — a detached head, the
  project's default branch and a branch the remote already holds in full are
  each said, not pushed — and hands the transfer over: the forge pushes as
  its own app and opens the pull request only when the branch has none.
  Served always, erroring plainly where the project has no forge. And every
  external boundary is now crossed by using the forge (ruled 2026-10-02):
  the `Forge` interface gains `fetchBranch`, and the worktree machinery took
  out its raw `git fetch origin` — with a forge it receives that fetch
  injected, without one the worktree starts from refs the clone already
  holds.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The redirect hook.** aivi's own plugin now denies boundary git — `git
  push`, `fetch`, `pull`, `clone`, `ls-remote`, `remote`, behind any flags or
  `-c` prefixes — **in aivi's runs only**, and says the way across instead:
  "git push is disabled in aivi runs — use aivi_push (and aivi_sync first if
  the remote moved)". Scoped by sessionID: the plugin asks the host's new
  `GET /run?session=` once per session (answered from the run ledger) and
  caches; a person's sessions never see the deny, and a host that cannot
  answer fails open — the worktree's no-credential mark is the wall, the
  hook is the signpost.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`0ec3f65`](https://github.com/aivi-hq/aivi/commit/0ec3f655de2817fa244d673abe797157282dc3c4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The forge registry: who owns this project's remote?** The kit declares
  a `Forges` contract and `AiviServices` carries it; `forge-github` now
  registers its forge at module start instead of standing by unused. The
  `projects-sync` task asks before it fetches: a checkout whose `origin` a
  registered forge recognises syncs **through that forge**, authenticated as
  its own installation; no forge or an unowned remote stays plain git
  naming no plugin (the configurable path, not the spine). And the
  misplaced git moved: worktree git left the Linear module for
  `@aivi/host`'s orchestrator — a tracker answers tickets — while
  `tracker-linear` stops exporting `ensureWorktree` and friends.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`91c4fe2`](https://github.com/aivi-hq/aivi/commit/91c4fe2e8b4c829394b2ab87072ff69bde60010c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The timeout monitor: one clock per lease, aimed at a known instant.**
  The dispatcher now arms a timer at every grant — the prepare window for a
  lease without a session, the idle window for an attached one — and every
  sign of life re-aims it. A silent worker is killed, the kill is confirmed
  before the slot is freed, and an unconfirmed kill keeps the slot
  unavailable: capacity that may still be working is never double-booked,
  and the next look is a known instant, not a poll. The clocks watch leases
  whether or not pools count them, and after a restart the survivors'
  clocks run from their stored activity — a silence that began before the
  restart is timed from where it began. `setInterval` stays banned.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`8e26ad6`](https://github.com/aivi-hq/aivi/commit/8e26ad6aab5d49460cc54d965a36adfc31e651d8) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The worktree gets its caller.** `initWork` now answers with a
  **work entry** — the summary plus the ticket's **branch name** where the
  platform names one (Linear's `Issue.branchName`). A `worktree: true` lane
  gets its own git worktree on that branch before the session opens: made
  by the orchestrator with the forge's `fetchBranch` **injected** when a
  forge owns the remote (local refs otherwise), and the worker session is
  created **in** it. A lane that wants a worktree whose tracker named no
  branch fails the run visibly — no invented names. The worktree mark gains
  the wall: an empty `credential.helper` and `core.sshCommand=false`, so
  boundary git that slips past the tools has no credential to spend.

### Patch Changes

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A worker's execution that **fails** on the wire now ends its run at once,
  with the wire's own words as the reason. The watcher knew only an
  execution's start and its success: an unloadable model variant failed the
  drain 3 ms after the prompt (live, 2026-10-06), and the run sat `working`
  forever behind a keep-alive that promised "still working" to a deleted
  audience — no nudge, no failure, no slot back. The ticket stays where the
  person can see it: the worker never got to work on it.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`c7ed291`](https://github.com/aivi-hq/aivi/commit/c7ed2915019c3a45d194a87b7c6a0a6bf99546fa) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Three claims now say what is true. The closing note's idempotence marker
  is a trailer aivi controls, read only as a comment's last line — a worker
  quoting its session id in prose no longer silences the closing forever.
  `aivi_jobs` answers an unreadable agent list with an honest 503, never a
  confident "No agent exists". The forge's review read says
  `review.facts.truncated` when GitHub's answer carried more threads or
  comments than the read could hold.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`97071b5`](https://github.com/aivi-hq/aivi/commit/97071b52d993af52a7904f506dc94d0abba533e0) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `/context` now shows what OpenCode has loaded: every plugin beyond OpenCode's built-ins, with version and source target (`aivi (v0.3.1): file:/…`), so a missing or failed aivi plugin is visible from Discord and Slack. The render also moved to three bounded OpenCode calls — the session object, `session.context` (the effective context, the same read the TUI's display makes) and the plugin list — replacing the full-transcript paging walk it used to do on every `/context`; lifetime totals come from the session object, and the message/answer counts, which only the walk could give, are gone.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Dreaming reviews every registered channel by default. `origins` lost its
  hardcoded `["discord"]`: the schema default is now the empty list, and
  the dreaming operation fills it at run start with the channel modules
  actually registered — a Slack-only home reviews Slack without a config
  edit. A home with no channel module and no named origins fails the run
  saying so, instead of confidently reviewing nothing.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`fad218f`](https://github.com/aivi-hq/aivi/commit/fad218fe1bb1a4ff1f88545c16c3ad2ab9627aed) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Two endings told the truth. `runTurn` with the `fail` permission policy
  says a verdict that already stands before arming the wait — a permission
  pending from before the prompt used to hang the turn on the very wait
  that permission holds. `Dispatcher.release()` confirms an in-flight kill
  before freeing the slot: an expiring lease releases through the usual
  door when OpenCode answers that the session is done spending, and stays
  held, expiring, and retrying when it does not.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`fe7eaeb`](https://github.com/aivi-hq/aivi/commit/fe7eaeb00052bca97d17f5ed1bcbccb591523b86) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The exec door takes **one start per connection, even from a client that
  sends two before the pty import lands**: a start now claims the session
  before its first await, so the second frame is answered `start sent twice`
  and spawns nothing. Before this, two frames racing the import built two
  children with the operator's bearer, and only the one the session holds had
  a kill handle — the sibling ran past every stop.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`9b21539`](https://github.com/aivi-hq/aivi/commit/9b215391bfd45a81bdf8967849f80ad2d3d3e2f0) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Every complexity finding in the host fell to a named function: the
  dispatcher's grants and reconciler verdicts, the walk's lane work, the
  boot's report words and ordered shutdown, the plain sync's git rule, the
  project wizard's contributor run, the registry's lazy import and the CLI
  test driver's process swap are each a named function now. No behavior
  moved a word; 521 tests green before and after.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `host.public`: the address others reach aivi at (funnel, tunnel or proxy URL), asked once by `aivi setup` and preferred in every URL aivi prints for someone else to paste — the "another machine" connect lines, `aivi people create`'s token handoff, and `/status`. aivi keeps dialling `host.bind`/`host.port`; nothing is derived, and setup probes the address with nothing: during setup no server runs yet.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`9dc3da0`](https://github.com/aivi-hq/aivi/commit/9dc3da017cfe379ed4f2de108c8fa29771aa0e59) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host went pure: it parses no argv. `@aivi/host/server` is the boot — it loads the modules from the plugin list and runs `runHost`, and launchd/systemd units now point at `dist/server.js` with no `serve` argument; the `serve` command calls the same boot in-process. `@aivi/host/cli` exports `registerCommands` alone: what the host *provides*, while `@aivi/cli` is the one that *collects* — commander lives in exactly one tree, the bin's, on every path. The host's self-boot entry and its `rootBanner` are gone; the banner belongs to the bin alone.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Knowledge search is on by default.** The `search` block now defaults to
  `{provider: "qmd", indexOnStart: true, maxPending: 32}`: an install that
  never mentions it searches, and `search: false` is the only off switch.
  Before this, a missing block meant every `knowledge_search` answered
  "Knowledge search is not enabled" — a silent no-search install, which the
  operator just lived through.

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

- [#37](https://github.com/aivi-hq/aivi/pull/37) [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A project with no repository is a supported state, and the config now says
  so. `projects.<id>.sync` (default `true`) keeps the hourly `projects-sync`
  job away from a project it has no business with; `aivi projects add` writes
  `sync: false` when no forge cloned a checkout. The job used to visit every
  project and answer `skipped: not a git checkout`, which it logged at `warn`
  and printed in its report — a supported configuration announced as an
  anomaly once an hour. A skip is what a person would act on: the four reasons
  that need a decision — local changes, a detached HEAD, no upstream, a
  diverged branch — are reported as they were.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`451412f`](https://github.com/aivi-hq/aivi/commit/451412fc7e7a2dea01feb08f1d754fdddede4de5) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Vocabulary, comments only: there is one CLI. The label a past session invented for `@aivi/cli` — "the thin CLI" — is gone from the sources' comments and the docs; the CLI collects commands (from the host and from plugins, the same way) and the host provides them.

- [#45](https://github.com/aivi-hq/aivi/pull/45) [`85817ad`](https://github.com/aivi-hq/aivi/commit/85817ad0e12563c9dfc79535c8a0a735022f2524) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The `projects add` wizard's last line spaced itself wrong when a forge
  had cloned the checkout: "aivi is set up.Configured for tracker-linear.
   Restart" — one gap swallowed, one doubled. The sentence now reads with
  one space where a sentence should have one.

- [#39](https://github.com/aivi-hq/aivi/pull/39) [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The pinned `@opencode/*` family moved to 2.0.23. Nothing in aivi changed: the same endpoints under the same discovery rules — the release only added routes (`/api/credential`, `/api/vcs/init`), none moved — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Pool models now speak OpenCode's own spelling: `provider/model#variant`,
  parsed by OpenCode's own `Ref.parse` — the same one the agent-file
  frontmatter goes through. The dispatcher had a homegrown parser splitting
  the variant on `@`, a spelling nobody speaks: `provider/model#high` rode
  into the wire with `#high` glued inside the model id, and OpenCode
  answered `Model unavailable` (live, 2026-10-06) while the config looked
  right. The startup gate stays — a pool model that is no model reference
  is said at startup, never at a grant — now spoken by the parser that
  also answers the frontmatter.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`522640b`](https://github.com/aivi-hq/aivi/commit/522640b2c5ccb520ab0c24f303bfe149b1a99104) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `AIVI_OPERATOR_BEARER` joined the fixed secret names a shell task never
  inherits (decision D15): the exec door stamps the remote driver's own bearer
  into the driven session's closed environment, and the name is now scrubbed
  from task scripts' env too, so an operator's credential cannot leak into a
  task script however it entered the host's environment. The scrub test proves
  it at the executor boundary; configuration.md owns the words.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`2cc3cfc`](https://github.com/aivi-hq/aivi/commit/2cc3cfc1186f870df71431f440a79387988b94a1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Shutdown says so: `aivi serve` logs `host.stopping` the moment it takes a stop signal, so the drain that follows no longer reads as a hung terminal, and the Slack SDK's pong warnings are dropped once the module closes the socket on purpose (its errors still travel). The seeded assistant and dreamer agents now deny the `question` tool — no channel client can answer one yet, and a question in an unattended turn only hangs.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d482625`](https://github.com/aivi-hq/aivi/commit/d482625fee48116465ffbfe75ba650443a4c5e4e) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The worker's progress stream.** While a run works, its OpenCode session
  is mirrored into the agent session as **ephemeral** activities: an `action`
  naming the tool being run, a `thought` for the status line. Ephemeral is
  Linear's word for *replaced* — the person sees the worker's current moment,
  never a trail of lines (ruled 2026-10-02: "thoughts and action types,
  marked as ephemeral to prevent spamming"). The stream starts with the pair
  at `ready`, pauses while a question awaits a person, resumes when the
  answer lands, and falls silent before the closing. The `progress` config
  (`silent`/`status`/`tools`, default `tools`) decides what it shows. The kit
  Platform gains an optional `progress(conversation, line)` member —
  transient by contract; platforms without a progress surface leave it
  absent and their workers work in silence.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`27101b1`](https://github.com/aivi-hq/aivi/commit/27101b148fba461649476259b5c9550fa3284fde) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **A host whose OpenCode is unreachable boots anyway.** The boot reconcile
  pass caught a server that did not answer but died building the client when
  discovery found no service at all (`lifecycle: "discover"`, none
  registered) — so `aivi serve` exited at boot instead of serving. That
  silence now defers the pass whole, exactly as a non-answering server
  already did: leases stand, clocks arm, the host serves. `runHost` gained an
  `opencode` injection point, and its tests no longer discover the
  developer's real service through the back door.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`5146981`](https://github.com/aivi-hq/aivi/commit/51469810da8a67fb5299969d560bfba9e76997f8) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The version gate binds the core API surface only. The host applies the client-version negotiation to the endpoints it registers itself — the set fills from the route table as the app is built, so it cannot drift — and everything else passes untouched: a path nobody serves answers its honest 404 or 405 to any caller, so a browser probe or a mispointed webhook sees a missing path, never a refusal naming a version it was never asked about.
- Updated dependencies [[`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9), [`1b7a209`](https://github.com/aivi-hq/aivi/commit/1b7a2092b65170f4e91e86c37a00f97effc4bb8f), [`49977a5`](https://github.com/aivi-hq/aivi/commit/49977a51a8186c4fffecd740b41bdd6590b2a653), [`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69), [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4), [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947), [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260), [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4), [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973), [`955f2d6`](https://github.com/aivi-hq/aivi/commit/955f2d63d04b1ed4b2ad815ae7c02dc6bab45420), [`029c8ea`](https://github.com/aivi-hq/aivi/commit/029c8eadbee74e7cd11165535911545a69897c60), [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b), [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0), [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a), [`69735bd`](https://github.com/aivi-hq/aivi/commit/69735bd7b7842dc4c4e311b49fb7c7ece7f28c3d), [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147), [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6), [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c), [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6), [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862), [`7faf7c5`](https://github.com/aivi-hq/aivi/commit/7faf7c5b130ad0822870b04a7695a9d17ec24a7c), [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288), [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`4d2e509`](https://github.com/aivi-hq/aivi/commit/4d2e5091c0351920c9dbdd6af351cf66f26212b3), [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009), [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91), [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b), [`bf6c5b0`](https://github.com/aivi-hq/aivi/commit/bf6c5b052735c0f6b2331cb972519f08b2d9ed43), [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db), [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9), [`1ba4d46`](https://github.com/aivi-hq/aivi/commit/1ba4d46ea25ec79cb28a421fd511f462f70f39d1), [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72), [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa), [`a253aab`](https://github.com/aivi-hq/aivi/commit/a253aab2d0910e7052f8a3c3727996ea11aa4090), [`d482625`](https://github.com/aivi-hq/aivi/commit/d482625fee48116465ffbfe75ba650443a4c5e4e), [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1), [`0ec3f65`](https://github.com/aivi-hq/aivi/commit/0ec3f655de2817fa244d673abe797157282dc3c4), [`d337a15`](https://github.com/aivi-hq/aivi/commit/d337a15ee5e58fec7b9407db28fe38bbd91a87f9), [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f), [`8e26ad6`](https://github.com/aivi-hq/aivi/commit/8e26ad6aab5d49460cc54d965a36adfc31e651d8), [`3ef9b9a`](https://github.com/aivi-hq/aivi/commit/3ef9b9a19f023da3273a2785b5c417478805769d)]:
  - @aivi/plugin@0.9.0
  - @aivi/core@0.8.0
  - @aivi/knowledge@0.1.8

## 0.8.1

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`e796858`](https://github.com/aivi-hq/aivi/commit/e796858f6b9dd1e964e37a337e43258e5df94ffa) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The pinned `@opencode/*` family moved to 2.0.18. Nothing in aivi changed: the same endpoints under the same discovery rules — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.
- Updated dependencies [[`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95)]:
  - @aivi/core@0.7.1

## 0.8.0

### Minor Changes

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now a composed module like the channels, not a host resource. It claims its own `aivi_browser` descriptor at the `tools` door at start and releases it at stop, and the host serves that claim to the OpenCode plugin like any other tool. The `/v1/browser` endpoint, the `browser` field on host services and resources, and the `HostClient.browser` method are gone — the host holds no browser concept at all. `aivi install browser` now ends in the same verified truth as any other module: "Browser is running."

- [#26](https://github.com/aivi-hq/aivi/pull/26) [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` with its own package version, read from `package.json` at runtime. The major is the contract, the minor is features: a client ahead of its host is refused with 403 `server_version_too_low`, a client behind the host's major with `client_version_unsupported` (`aivi upgrade`); a client behind within the major is served. `GET /version` and `GET /health` answer without the header. This release starts `@aivi/cli` and `@aivi/host` as a changesets `fixed` group, so their versions stay one number from here on. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL.

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The OpenCode plugin JITs its tools: each capability's owner contributes a descriptor, the host serves them at `GET /v1/tools` and dispatches calls at `POST /v1/tools`, and the plugin registers exactly what the host offered at load. The plugin hardcodes no aivi tools; its own `aivi_connection` reports reachability, version and which tools this process loaded.

### Patch Changes

- Updated dependencies [[`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca), [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741), [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f), [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502)]:
  - @aivi/core@0.7.0

## 0.6.0

### Minor Changes

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`08a8079`](https://github.com/aivi-hq/aivi/commit/08a8079fe0755789866adf3cdb158884cc61e757) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Link codes are minted for a named channel the person is not linked in yet:
  `GET /v1/links` lists the running channels with the caller's binding state,
  `POST /v1/links` requires a `channel` and refuses (404, 409) instead of
  minting a code nothing can read or one a person cannot spend — one binding
  per channel per person. `aivi link` picks among the eligible channels
  (prompting when several) and says so without minting when nothing is
  eligible; a terminal gets one sentence, a pipe the JSON record.

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Command output is readable on a terminal and unchanged JSON in a pipe. Core
  gains an output renderer (`OutputBlock`, `renderOutput`, `formatTimestamp`,
  `print`): without a hand-written shape a command's value is shown as colored
  `util.inspect`; a command may pass blocks (log, heading, divider, table, raw
  `json`) instead — `aivi slack manifest` renders raw JSON so it stays
  paste-ready. Help loses its color theme; the wordmark stays.

### Patch Changes

- Updated dependencies [[`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4)]:
  - @aivi/core@0.6.0

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

### Patch Changes

- Updated dependencies [[`ad2895a`](https://github.com/aivi-hq/aivi/commit/ad2895a635925a5b23208bd34c915f7fca19f4ba)]:
  - @aivi/core@0.5.0

## 0.4.0

### Minor Changes

- [#16](https://github.com/aivi-hq/aivi/pull/16) [`bc1f731`](https://github.com/aivi-hq/aivi/commit/bc1f7318b2a4a68ee514eb0d4f280c32c1acc252) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A plugin can extend the operator CLI: where `./setup` is the install-time
  subpath, `./cli` is the runtime one — a package that default-exports a
  `PluginCliCommand` from `./cli` is mounted into the server CLI under Channels
  whenever the package is installed, with parsing and help owned by the app's
  commander and `run` receiving a `PluginCliContext` (loaded config, store
  bracket, the shared JSON stdout, the host poke, one prompt). `aivi discord`,
  `aivi slack` and `aivi linear` now come from their own packages through that
  contract. The brand color moves to `#3B82FF` — the wordmark and the help terms
  in the CLI, and the `aivi·host` log category, share it.

### Patch Changes

- Updated dependencies [[`5d865bf`](https://github.com/aivi-hq/aivi/commit/5d865bfcea07feb096370b4fb0a27d8ea831433c), [`bc1f731`](https://github.com/aivi-hq/aivi/commit/bc1f7318b2a4a68ee514eb0d4f280c32c1acc252)]:
  - @aivi/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2)]:
  - @aivi/core@0.3.0

## 0.3.0

### Minor Changes

- [#9](https://github.com/aivi-hq/aivi/pull/9) [`07af4cc`](https://github.com/aivi-hq/aivi/commit/07af4ccc8c55de72872c1ea4c37b623b5f9b8827) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Link codes and channel identities (schema v10): a person mints a 5-digit, one-time code with `POST /v1/links` (bearer required, one active per person, 15 minutes) and spends it with the new `/link CODE` chat command on any platform; the host binds `{channel, user id} → person` and confirms in its own words. Refusals never consume the code, and an already-bound account is refused outright — there is no unlink yet. Linked accounts speak as their person: the turn prompt carries the person's name and sessions are stamped `metadata.aivi.person`. Retention sweeps expired codes. Modules advertise their redemption wording through the new optional `ChannelModule.linkHint`.

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

### Patch Changes

- Updated dependencies [[`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c), [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7)]:
  - @aivi/core@0.2.0
