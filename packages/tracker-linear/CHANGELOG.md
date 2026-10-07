# @aivi/linear

## 0.5.0

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`69735bd`](https://github.com/aivi-hq/aivi/commit/69735bd7b7842dc4c4e311b49fb7c7ece7f28c3d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Linear becomes the follower.** The tracker seam grows `resultShown` (the
  adapter's own word for "the result was rendered"), `apply`, and an optional
  `closingNote`; `tracker-linear` subscribes to the orchestrator's run events
  and pays its ceremony itself — **result → closing note → move → unassign** —
  each step asking Linear's real state first, so a half-landed ceremony says
  nothing twice. Its pairs (agent session ↔ OpenCode session ↔ ticket) live in
  its own `tracker_linear_run_links` table; a delivery failure stays owed in
  memory and the boot pass re-derives the list from its own pairs. The closing
  note puts the ending on the **ticket** as a comment linked to the agent
  session, so a person reads the answer without opening the session.
  
  The listener default flips to **on**, and Linear's plugin section keeps only
  `teams` (and `workspaceId`): lanes moved to core. Two board fixes: the
  client sorts workflow states by **type group, then position** (Linear scopes
  `position` within a group — sorting by it alone interleaved Done and Canceled
  before a late `started` lane), and the setup wizard **never writes closed
  states** into the lanes array; a run ending in the last configured lane
  moves nowhere and a person closes the ticket.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`7faf7c5`](https://github.com/aivi-hq/aivi/commit/7faf7c5b130ad0822870b04a7695a9d17ec24a7c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **A delegated ticket is not eligible, and early deaths are visible.**
  The walk now leaves out tickets that already have a delegate (ruled
  2026-10-02): someone already speaks for them, and re-delegating to the
  user a ticket already has is a mutation no-op — Linear makes no session
  for it. That silence was seven failed runs on one ticket. When a run
  dies before its session exists, `Platform.notify` — a new required
  member — leaves a plain comment on the ticket itself before the run
  fails. And closings compose the rule: **every** ending releases the
  delegate (the delegate means *an app is working this issue*; a finished
  run works it no more — leaving it sitting would blacklist the ticket,
  which "endings release" forbids). While a closing is owed, the ticket
  waits; when it is paid, failed work is work again.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The plugin contract is a kit. `@aivi/plugin` carries the setup, CLI and module contracts and the `./api` client, and plugins are plain commander subtrees built by `(ctx) => Command` factories — one command mechanism for the server's own commands and the plugins' alike. A plugin's main entry is `{ moduleId, configSchema, createModule }` with `./cli` and `./setup` subpaths, and its `./config` declares its module id and config shape: core stopped knowing plugin names, and the host composes the closed `config.json` schema from the listed packages at load. The `ask` wrappers are gone — a plugin's command receives the prompt rule as part of its context, and two clacks animating one terminal can no longer mangle each other. `@aivi/linear` is now `@aivi/tracker-linear` (the `linear` alias in `aivi add` is unchanged).

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`7b674b1`](https://github.com/aivi-hq/aivi/commit/7b674b1dd7732af9d79dd524d022d1704e77b67c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The human label rides in production.** `LinearPlatform.apply` handled
  `comment` and `move` and threw "cannot apply label yet" for everything
  else — while the module had asked it for a `label` update on every stop,
  every failed closing, and every unconfirmed stop since the stop-sticks
  ruling. The throw was caught, warned as `help.label.failed`, and the
  ticket stayed unmarked: the walk read the stopped ticket straight back.
  Only the test fake had learned to mutate labels; the real adapter had
  never applied one. The client now resolves a label name against the
  team's labels (the team's own wins over the workspace's, and a name none
  carries is created on the team — no settings visit needed to make
  `needs-human` applicable) and performs `issueAddLabel` /
  `issueRemoveLabel`. The quality scan's dead-code report exposed it: the
  `apply` doc comment claimed "nothing on today's path asks for one" while
  three paths did.

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

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`d337a15`](https://github.com/aivi-hq/aivi/commit/d337a15ee5e58fec7b9407db28fe38bbd91a87f9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The ticket desk: eight tools — `aivi_ticket_read`, `_comments`, `_labels`,
  `_edit`, `_comment`, `_create`, `_add_label`, `_remove_label` — a worker's
  hand on the ticket itself. Read the ticket and its trail, rewrite its
  words, comment, label it, and open a new ticket for work the current one
  should not carry — the escape hatch, landing in `createLane` (project,
  then defaults, then the first configured lane) and waking the walk itself.
  Permission is OpenCode's: `aivi setup` seeds a single `aivi_ticket_*`
  **deny** to every agent — a denied action hides the tool from the model —
  and the agent file that works tickets allows the desk; `product.md` ships
  with it. The desk answers only the ticket the ledger says the calling run
  works; no call names a ticket. An agent needing more of Linear upgrades to
  the MCP in its own file — the base kit stays small on purpose.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`89d07fb`](https://github.com/aivi-hq/aivi/commit/89d07fb962b51efe6ca324c8262deebd3169f895) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The wizard asks about the queue once.** After every lane has been
  configured comes a single question — which lane waits with work while the
  working lanes are full — with `-- None --` among the options, never a
  per-lane ask. The options are only the lanes that could legally hold the
  queue (one whose next works nobody would write a config that refuses to
  load), and picking a lane that just chose an agent gives that agent up
  out loud: the queue answer is the later word.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`3ef9b9a`](https://github.com/aivi-hq/aivi/commit/3ef9b9a19f023da3273a2785b5c417478805769d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The tracker seam.** A new subpath, `@aivi/plugin/tracker`, is the contract
  between aivi's ticket machinery and one ticket system. An adapter is a
  translator and nothing else: it turns the platform's events into neutral
  ones — `started`, `prompted`, `updated` on a *conversation*, which is what a
  tracker calls one working session — and aivi's neutral asks back into the
  platform's mutations: `issue`, `laneStates`, `assign`/`unassign`,
  `startSession`, and `comment` in four kinds (`answer`, `progress`, `note`,
  `outcome`) that each platform renders its own way. `idFor` and `parts` carry
  a conversation across the border in both directions, so nothing outside the
  adapter ever parses one. `createStates`, `candidates` and `apply` are
  declared optional and unimplemented: they arrive with the dispatch work,
  when the machinery starts asking pull-shaped questions.
  
  `@aivi/tracker-linear` now splits along that line. `tracker.ts` is Linear's
  translator — the apps and their credentials, the webhook endpoints and their
  signatures, the GraphQL reads and mutations, the agent-session activity
  types — and the only file where a Linear field name survives. `module.ts`
  holds aivi's own machinery, the routing decisions, the delegate guards, the
  listener's pickup and the worktree a lane's agent works in, and it speaks
  only the `Tracker` contract. That machinery is the orchestrator waiting to be
  extracted, and the worktree code moves with it.
  
  Two things the seam made visible, both fixed. A ticket's data change arrives
  before that ticket has a session of its own, so a conversation may be the
  app's own feed and the adapter says so rather than demanding a session; and a
  comment into a conversation that names no session is an error naming itself,
  not an activity posted at an empty id.

### Patch Changes

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A deleted ticket stops haunting the log. Deleting an issue takes its agent
  session with it, and Linear then answers every later call with
  `Entity not found` (HTTP 200): the owed closing failed, the help-on-the-way
  comment failed on the same grave, and the boot pass re-owed and re-failed
  it on **every** boot (live, 2026-10-06). The tracker now knows Linear's
  gone-answer: the debt drops and the pair retires from the tracker's own
  table — asked once, said once, never asked again. A missing issue reads as
  deleted, not a crash, wherever the ending asks where the ticket sits.

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`968dee7`](https://github.com/aivi-hq/aivi/commit/968dee70e2936bd2af8c26ebae43387eed47c3fe) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A landed closing now **settles its pair**. The boot pass used to re-owe
  every terminal run ever — two Linear queries and a delegate-write per pair,
  per boot, forever, growing with the history (live, 2026-10-06). Landed pairs
  are stamped in the tracker's own table and boot reads only the owed ones,
  through a partial index that stays tiny while the history grows. The stamp
  records that the asking happened and never replaces it: an owed pair is
  still reconciled against Linear's real state, so a home from before the
  stamp asks once and settles.

- [#45](https://github.com/aivi-hq/aivi/pull/45) [`3f92cdd`](https://github.com/aivi-hq/aivi/commit/3f92cddac679728253d2e80d990c3cbadb093be5) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A ticket born on the board now wakes the walk. Linear's Triage is where
  issues are created, but a create carries no changed fields, and only
  changed fields woke the eligibility walk — so a ticket created straight
  into Triage (a lane with an agent) sat unseen until a person moved it by
  hand. A create now reports its state as changed: the front door wakes the
  walk like any move into it.

- [#45](https://github.com/aivi-hq/aivi/pull/45) [`c623e44`](https://github.com/aivi-hq/aivi/commit/c623e448743ca328b749b768e2778c72b6ee1773) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Wizard fixes from the operator's live `projects add`. The forge asks
  the app what it was granted before asking the person anything: the
  repository prompt is now a search-as-you-type pick-list of the
  installation's real repositories, with the typed prompt kept for when the
  list cannot be fetched. And the lane wizard stopped asking "does this
  lane write files" to decide on a worktree — the worktree belongs to the
  branch, not to writing: a review lane changes nothing yet must read the
  pull request's branch, which lives nowhere but a worktree. The question
  is now "does work happen on the ticket's branch". And the project-id
  prompt takes its suggested name as a real default: Enter now shows what
  was chosen, instead of an answered prompt that renders empty.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`a48334e`](https://github.com/aivi-hq/aivi/commit/a48334e84f3dbe5d81609db4fc8dfafc00543eef) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The board query speaks Linear's id types.** `issuesIn` declared its
  `$teamId`/`$stateId` as `String!` where Linear's id **filters** are typed
  `ID` and answer a String variable with a 400 — the eligibility walk died
  on the first real board read (live, 2026-10-02). The fake board could
  never catch it; direct id arguments accept String, filter comparisons do
  not.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`c7ed291`](https://github.com/aivi-hq/aivi/commit/c7ed2915019c3a45d194a87b7c6a0a6bf99546fa) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Three claims now say what is true. The closing note's idempotence marker
  is a trailer aivi controls, read only as a comment's last line — a worker
  quoting its session id in prose no longer silences the closing forever.
  `aivi_jobs` answers an unreadable agent list with an honest 503, never a
  confident "No agent exists". The forge's review read says
  `review.facts.truncated` when GitHub's answer carried more threads or
  comments than the read could hold.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`6063be5`](https://github.com/aivi-hq/aivi/commit/6063be5fd45984710d18ca4073019eff9107c3c6) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The installer's first wait never spoke to the client it destructured;
  the name is gone.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d8b6a82`](https://github.com/aivi-hq/aivi/commit/d8b6a8202d0b130b9a22b03e385b26c5f619ec0a) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The Linear module's functions do one thing each now: the wizard's steps, the closing's unconfirmed-kill notice, the prompted-message branches, the webhook's session translation, the board's walkability filter and the installer's two waits are named functions, and the test double routes by a per-route handler table. No behavior moved a word; the wizard itself is under test for the first time.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - One assistant. The seeded home carries a single `assistant.md` — platform-neutral, the same being behind a chat message, an issue mention and a job delivery; what differs is the zoom, not the identity. `librarian.md` is retired and the Linear-seeded `aivi.md` merged into it; `discord.agent`, `slack.agent` and the Linear assistant now default to `assistant` (no persona-name slug), and Linear's module sends only facts (`platform:`, `issue:`, `project:`, `came by:`) — the do-not-do-the-work instructions live in the agent file, the whole boundary an operator can edit.

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
- Updated dependencies [[`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9), [`1b7a209`](https://github.com/aivi-hq/aivi/commit/1b7a2092b65170f4e91e86c37a00f97effc4bb8f), [`49977a5`](https://github.com/aivi-hq/aivi/commit/49977a51a8186c4fffecd740b41bdd6590b2a653), [`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69), [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4), [`e2b7730`](https://github.com/aivi-hq/aivi/commit/e2b7730ed2e9b5bc1cb1c577fbd890f518fe101d), [`c7ed291`](https://github.com/aivi-hq/aivi/commit/c7ed2915019c3a45d194a87b7c6a0a6bf99546fa), [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947), [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260), [`69a6c28`](https://github.com/aivi-hq/aivi/commit/69a6c28f3d2cfd25b045d364b02513e802fa2a62), [`97071b5`](https://github.com/aivi-hq/aivi/commit/97071b52d993af52a7904f506dc94d0abba533e0), [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4), [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973), [`fad218f`](https://github.com/aivi-hq/aivi/commit/fad218fe1bb1a4ff1f88545c16c3ad2ab9627aed), [`dc2c16a`](https://github.com/aivi-hq/aivi/commit/dc2c16aa1fa68173d478f5c331bf67f0c56500c9), [`fe7eaeb`](https://github.com/aivi-hq/aivi/commit/fe7eaeb00052bca97d17f5ed1bcbccb591523b86), [`955f2d6`](https://github.com/aivi-hq/aivi/commit/955f2d63d04b1ed4b2ad815ae7c02dc6bab45420), [`d71af5b`](https://github.com/aivi-hq/aivi/commit/d71af5b0a51f80123031c9938a96b723bff7b17e), [`029c8ea`](https://github.com/aivi-hq/aivi/commit/029c8eadbee74e7cd11165535911545a69897c60), [`9b21539`](https://github.com/aivi-hq/aivi/commit/9b215391bfd45a81bdf8967849f80ad2d3d3e2f0), [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b), [`9dc3da0`](https://github.com/aivi-hq/aivi/commit/9dc3da017cfe379ed4f2de108c8fa29771aa0e59), [`edd4bfc`](https://github.com/aivi-hq/aivi/commit/edd4bfc3a2704c46d445b38697b5d89fbe5eda7d), [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0), [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a), [`69735bd`](https://github.com/aivi-hq/aivi/commit/69735bd7b7842dc4c4e311b49fb7c7ece7f28c3d), [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147), [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6), [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c), [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6), [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862), [`7faf7c5`](https://github.com/aivi-hq/aivi/commit/7faf7c5b130ad0822870b04a7695a9d17ec24a7c), [`295ee5f`](https://github.com/aivi-hq/aivi/commit/295ee5f3b34f746cb0588c0c1aa293aab27e41b1), [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464), [`451412f`](https://github.com/aivi-hq/aivi/commit/451412fc7e7a2dea01feb08f1d754fdddede4de5), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`85817ad`](https://github.com/aivi-hq/aivi/commit/85817ad0e12563c9dfc79535c8a0a735022f2524), [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288), [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485), [`522640b`](https://github.com/aivi-hq/aivi/commit/522640b2c5ccb520ab0c24f303bfe149b1a99104), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`4d2e509`](https://github.com/aivi-hq/aivi/commit/4d2e5091c0351920c9dbdd6af351cf66f26212b3), [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009), [`2cc3cfc`](https://github.com/aivi-hq/aivi/commit/2cc3cfc1186f870df71431f440a79387988b94a1), [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91), [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b), [`bf6c5b0`](https://github.com/aivi-hq/aivi/commit/bf6c5b052735c0f6b2331cb972519f08b2d9ed43), [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db), [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9), [`9d067d3`](https://github.com/aivi-hq/aivi/commit/9d067d398b08ef0a79d839259ecc288ed4b162e4), [`3c6ee07`](https://github.com/aivi-hq/aivi/commit/3c6ee07b69dfdf3ff084aed1093e6364883106a9), [`4c126ea`](https://github.com/aivi-hq/aivi/commit/4c126ea8f6f8d75ffe943767a7e86109517ec9d2), [`60090e2`](https://github.com/aivi-hq/aivi/commit/60090e289863139770fcbc90d3b8a8127590d60f), [`1ba4d46`](https://github.com/aivi-hq/aivi/commit/1ba4d46ea25ec79cb28a421fd511f462f70f39d1), [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72), [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa), [`a253aab`](https://github.com/aivi-hq/aivi/commit/a253aab2d0910e7052f8a3c3727996ea11aa4090), [`d482625`](https://github.com/aivi-hq/aivi/commit/d482625fee48116465ffbfe75ba650443a4c5e4e), [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1), [`0ec3f65`](https://github.com/aivi-hq/aivi/commit/0ec3f655de2817fa244d673abe797157282dc3c4), [`d337a15`](https://github.com/aivi-hq/aivi/commit/d337a15ee5e58fec7b9407db28fe38bbd91a87f9), [`91c4fe2`](https://github.com/aivi-hq/aivi/commit/91c4fe2e8b4c829394b2ab87072ff69bde60010c), [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f), [`8e26ad6`](https://github.com/aivi-hq/aivi/commit/8e26ad6aab5d49460cc54d965a36adfc31e651d8), [`3ef9b9a`](https://github.com/aivi-hq/aivi/commit/3ef9b9a19f023da3273a2785b5c417478805769d), [`27101b1`](https://github.com/aivi-hq/aivi/commit/27101b148fba461649476259b5c9550fa3284fde), [`5146981`](https://github.com/aivi-hq/aivi/commit/51469810da8a67fb5299969d560bfba9e76997f8)]:
  - @aivi/host@0.9.0
  - @aivi/plugin@0.9.0
  - @aivi/core@0.8.0

## 0.4.1

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.
- Updated dependencies [[`e796858`](https://github.com/aivi-hq/aivi/commit/e796858f6b9dd1e964e37a337e43258e5df94ffa), [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95)]:
  - @aivi/host@0.8.1
  - @aivi/core@0.7.1

## 0.4.0

### Minor Changes

- [#26](https://github.com/aivi-hq/aivi/pull/26) [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` with its own package version, read from `package.json` at runtime. The major is the contract, the minor is features: a client ahead of its host is refused with 403 `server_version_too_low`, a client behind the host's major with `client_version_unsupported` (`aivi upgrade`); a client behind within the major is served. `GET /version` and `GET /health` answer without the header. This release starts `@aivi/cli` and `@aivi/host` as a changesets `fixed` group, so their versions stay one number from here on. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL.

### Patch Changes

- Updated dependencies [[`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca), [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741), [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f), [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502)]:
  - @aivi/core@0.7.0
  - @aivi/host@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`08a8079`](https://github.com/aivi-hq/aivi/commit/08a8079fe0755789866adf3cdb158884cc61e757), [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4)]:
  - @aivi/host@0.6.0
  - @aivi/core@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`ad2895a`](https://github.com/aivi-hq/aivi/commit/ad2895a635925a5b23208bd34c915f7fca19f4ba)]:
  - @aivi/core@0.5.0
  - @aivi/host@0.5.0

## 0.3.0

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
  - @aivi/host@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2)]:
  - @aivi/core@0.3.0
  - @aivi/host@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [[`07af4cc`](https://github.com/aivi-hq/aivi/commit/07af4ccc8c55de72872c1ea4c37b623b5f9b8827)]:
  - @aivi/host@0.3.0

## 0.2.0

### Minor Changes

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI can run the server in the background and update it. `aivi service
  install|uninstall|start|stop|restart|status|logs` wrap a per-user LaunchAgent
  (macOS) or systemd user unit (Linux). `aivi update` resolves the channel from
  `config.json` (`update.channel`, default stable), provisions `runtime/` Node
  when the target demands it, stops the server, installs via npm — whose peer
  resolution pins a plugin at "disabled: no compatible release" when its range
  excludes the new host — restarts and probes `/health`. `aivi upgrade` updates
  the CLI through npm. Channel plugins now declare `@aivi/host` as a
  peerDependency, making npm the compatibility resolver.

### Patch Changes

- Updated dependencies [[`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c), [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7)]:
  - @aivi/host@0.2.0
  - @aivi/core@0.2.0
