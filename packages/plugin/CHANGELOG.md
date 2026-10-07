# @aivi/plugin

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`955f2d6`](https://github.com/aivi-hq/aivi/commit/955f2d63d04b1ed4b2ad815ae7c02dc6bab45420) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The forge contract.** A new subpath, `@aivi/plugin/forge`, says what a
  repository host answers and does. The line between a forge and aivi is
  **remote, not git**: any git operation that reaches `origin` authenticates to
  it, so it is the forge's — fetch, the sync of a project's clean checkout, and
  the push at turn end. What only touches the local store is aivi's own
  machinery and never appears here. The forge's API is for what git cannot see:
  `repoFor` (which repository this project's remote names, silent when it is
  another forge's), `prForBranch`, `reviewFeedback` — **open threads only**, no
  `since` cursor — and the one write, `resolveThread`, which posts a worker's
  reply saying which worker role it came from, visibly, and resolves the thread.
  A forge parses that signature back into the author fact, so a wake can tell
  its own past comments from a human's.
  
  Cloning is a forge's operation too but is not on this interface: it happens
  once, at project setup, through the plugin's `./setupProject` contributor. By
  the time a `Forge` is speaking to aivi the checkout already exists.
  
  A project having no forge is not a failure: a ticket can be "research X, write
  it up" and complete without aivi ever asking a repository host anything.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`029c8ea`](https://github.com/aivi-hq/aivi/commit/029c8eadbee74e7cd11165535911545a69897c60) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The GitHub forge.** `@aivi/forge-github` answers the `Forge` contract to
  GitHub, as its own app: octokit signs the app's JWT, mints an installation
  token and renews it, so nothing mints per command and nothing is cached by
  hand. The app has to be installed for any of this to work, and aivi speaks
  through exactly one installation — none is an error carrying the install link,
  several is an error naming the grants and saying which to revoke. One part of
  it is usable today: `aivi projects add` asks its `forge`-role contributor which
  repository a project is, proves the app can see it through the grant, and
  clones it as the app.
  
  A transfer authenticates inside its own command's environment and names the
  repository's URL on the command line instead of asking the checkout where its
  `origin` is. So no token is left in a file, the person's stored credential is
  never offered, and an ssh `origin` is left exactly as its owner left it — an
  installation token authenticates HTTPS and nothing else. The tests run the
  transfers against a real git remote on disk and read the checkout's
  `.git/config` afterwards to show aivi left nothing there.
  
  Two facts the build made say themselves. `push` answers the pull request
  standing for the branch afterwards, which is undefined when the branch simply
  moved and no pull request was asked for, and it takes the worker role along
  with the message so the pull request aivi opens says who opened it. And a
  checkout that is already there for the repository the person named counts as
  cloned, so a setup never writes its "no source" note into a real repository.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI stays in its lane: it resolves the one machine fact — a home here, or none — once per run, shows it in the help header (`home: ~/.aivi` / `home: none`), and injects it into every command provider: `registerCommands(program, machine)` and the new `PluginCliContext.machine`. Providers decide membership themselves: a machine without a home registers only what it can do there (`setup`, `upgrade`, `uninstall` — the exit ramp exists wherever the CLI is), and a typed command it does not have is honestly `unknown command`. Nothing is hidden after the fact anymore. The logging options `--log-level`/`--log-format` moved off the root onto `serve`, the command that actually logs, so a provider never pollutes commands that are not its own.

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

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A worker's execution that **fails** on the wire now ends its run at once,
  with the wire's own words as the reason. The watcher knew only an
  execution's start and its success: an unloadable model variant failed the
  drain 3 ms after the prompt (live, 2026-10-06), and the run sat `working`
  forever behind a keep-alive that promised "still working" to a deleted
  audience — no nudge, no failure, no slot back. The ticket stays where the
  person can see it: the worker never got to work on it.

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

- [#39](https://github.com/aivi-hq/aivi/pull/39) [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The pinned `@opencode/*` family moved to 2.0.23. Nothing in aivi changed: the same endpoints under the same discovery rules — the release only added routes (`/api/credential`, `/api/vcs/init`), none moved — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.

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
- Updated dependencies [[`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69), [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4), [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947), [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260), [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4), [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973), [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b), [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0), [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a), [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147), [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c), [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6), [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862), [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464), [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009), [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91), [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b), [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db), [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9), [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72), [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa), [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1), [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f)]:
  - @aivi/core@0.8.0
