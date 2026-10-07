# @aivi/forge-github

## 0.1.0

### Minor Changes

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`82d8467`](https://github.com/aivi-hq/aivi/commit/82d84673afb93cf717d2b6f615c86c30a17a325c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The GitHub client answers rate limits when they arrive; nothing paces
  writes any more.** The umbrella `octokit` package bolted its throttling
  plugin onto every client, and that plugin's Bottleneck held **every**
  write call for a fixed second — against a real GitHub and against a
  scripted in-memory one alike: a person's `aivi pr` paid one second per
  write, and every test in the package paid seconds for a rate limit
  nobody had hit. The client is now assembled from the parts aivi uses:
  `@octokit/core`, the REST endpoint methods, and the retry plugin, which
  re-sends what actually failed (429 and the server errors, with backoff).
  aivi is one installation making a handful of writes per ticket; a 403
  secondary-limit is answered by the honest error the person can read,
  not a pre-scheduled wait nobody asked for.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d71af5b`](https://github.com/aivi-hq/aivi/commit/d71af5b0a51f80123031c9938a96b723bff7b17e) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The git crossings are injectable now: the orchestrator's git tools take a `git` dep, the worktree machinery a `WorktreeGit`, the project sync a `ProjectGit`, and the GitHub forge a `GitRunner`. Production leaves the real binary; the tests answer these instead, so the tools' decisions — which argv where, which refusal means what — are units, not git simulations. The killed slow tests are back: the CLI mechanism, the exec relay, the forge, the worktree teardown, the project sync, and the git tools, all in well under a second.

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

### Patch Changes

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`c7ed291`](https://github.com/aivi-hq/aivi/commit/c7ed2915019c3a45d194a87b7c6a0a6bf99546fa) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Three claims now say what is true. The closing note's idempotence marker
  is a trailer aivi controls, read only as a comment's last line — a worker
  quoting its session id in prose no longer silences the closing forever.
  `aivi_jobs` answers an unreadable agent list with an honest 503, never a
  confident "No agent exists". The forge's review read says
  `review.facts.truncated` when GitHub's answer carried more threads or
  comments than the read could hold.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI's `main` is a table of contents now: the remote flag, the
  client-side set, the home commands, the exit ramp, the service verbs and
  the app-command mount are each a named function, and `add`'s setup and
  schema steps have their own names. Core's lane rules are four named
  checks instead of one refinement. The GitHub test double reads a call's
  shape in named parts. No behavior moved a word; 521 tests green before
  and after.

- [#41](https://github.com/aivi-hq/aivi/pull/41) [`2d3359d`](https://github.com/aivi-hq/aivi/commit/2d3359dad1d726da038fde7e38b7eca8604d6799) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The setup says where everything is.** `aivi add @aivi/forge-github` asked
  for an App ID and a key path as bare prompts — where do those come from? The
  flow now prints the whole of what a person does on GitHub before asking
  anything: the app-creation URL, the repository permissions the forge spends
  (Contents and Pull requests read & write, Issues for a future tracker),
  where the App ID sits on the app page, where the .pem download comes from,
  and the install step with "Only select repositories" — plus the line about
  approving pending access on an already-installed app. The key prompt says
  its file is read once and the key saved in the home's `.env`, because a
  path a tool never remembers is not a path to curate.

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

- [#45](https://github.com/aivi-hq/aivi/pull/45) [`ec9871e`](https://github.com/aivi-hq/aivi/commit/ec9871ed83520f06e4a11ffa40d70f345fe4a10e) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `projects add` accepts the shorthand it promises. The forge's repository
  prompt says "owner/repo, or its URL", but the parse behind it read only
  full URLs — a bare `owner/repo` has no scheme to parse, so the answer the
  prompt asked for was rejected as wrong. A two-segment name now means a
  repository on github.com, exactly like the URL form; relative paths and
  three-segment answers still name no repository.
- Updated dependencies [[`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9), [`1b7a209`](https://github.com/aivi-hq/aivi/commit/1b7a2092b65170f4e91e86c37a00f97effc4bb8f), [`49977a5`](https://github.com/aivi-hq/aivi/commit/49977a51a8186c4fffecd740b41bdd6590b2a653), [`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69), [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4), [`e2b7730`](https://github.com/aivi-hq/aivi/commit/e2b7730ed2e9b5bc1cb1c577fbd890f518fe101d), [`c7ed291`](https://github.com/aivi-hq/aivi/commit/c7ed2915019c3a45d194a87b7c6a0a6bf99546fa), [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947), [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260), [`69a6c28`](https://github.com/aivi-hq/aivi/commit/69a6c28f3d2cfd25b045d364b02513e802fa2a62), [`97071b5`](https://github.com/aivi-hq/aivi/commit/97071b52d993af52a7904f506dc94d0abba533e0), [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4), [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973), [`fad218f`](https://github.com/aivi-hq/aivi/commit/fad218fe1bb1a4ff1f88545c16c3ad2ab9627aed), [`dc2c16a`](https://github.com/aivi-hq/aivi/commit/dc2c16aa1fa68173d478f5c331bf67f0c56500c9), [`fe7eaeb`](https://github.com/aivi-hq/aivi/commit/fe7eaeb00052bca97d17f5ed1bcbccb591523b86), [`955f2d6`](https://github.com/aivi-hq/aivi/commit/955f2d63d04b1ed4b2ad815ae7c02dc6bab45420), [`d71af5b`](https://github.com/aivi-hq/aivi/commit/d71af5b0a51f80123031c9938a96b723bff7b17e), [`029c8ea`](https://github.com/aivi-hq/aivi/commit/029c8eadbee74e7cd11165535911545a69897c60), [`9b21539`](https://github.com/aivi-hq/aivi/commit/9b215391bfd45a81bdf8967849f80ad2d3d3e2f0), [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b), [`9dc3da0`](https://github.com/aivi-hq/aivi/commit/9dc3da017cfe379ed4f2de108c8fa29771aa0e59), [`edd4bfc`](https://github.com/aivi-hq/aivi/commit/edd4bfc3a2704c46d445b38697b5d89fbe5eda7d), [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0), [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a), [`69735bd`](https://github.com/aivi-hq/aivi/commit/69735bd7b7842dc4c4e311b49fb7c7ece7f28c3d), [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147), [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6), [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c), [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6), [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862), [`7faf7c5`](https://github.com/aivi-hq/aivi/commit/7faf7c5b130ad0822870b04a7695a9d17ec24a7c), [`295ee5f`](https://github.com/aivi-hq/aivi/commit/295ee5f3b34f746cb0588c0c1aa293aab27e41b1), [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464), [`451412f`](https://github.com/aivi-hq/aivi/commit/451412fc7e7a2dea01feb08f1d754fdddede4de5), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`85817ad`](https://github.com/aivi-hq/aivi/commit/85817ad0e12563c9dfc79535c8a0a735022f2524), [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288), [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485), [`522640b`](https://github.com/aivi-hq/aivi/commit/522640b2c5ccb520ab0c24f303bfe149b1a99104), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`4d2e509`](https://github.com/aivi-hq/aivi/commit/4d2e5091c0351920c9dbdd6af351cf66f26212b3), [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009), [`2cc3cfc`](https://github.com/aivi-hq/aivi/commit/2cc3cfc1186f870df71431f440a79387988b94a1), [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91), [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b), [`bf6c5b0`](https://github.com/aivi-hq/aivi/commit/bf6c5b052735c0f6b2331cb972519f08b2d9ed43), [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db), [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9), [`9d067d3`](https://github.com/aivi-hq/aivi/commit/9d067d398b08ef0a79d839259ecc288ed4b162e4), [`3c6ee07`](https://github.com/aivi-hq/aivi/commit/3c6ee07b69dfdf3ff084aed1093e6364883106a9), [`4c126ea`](https://github.com/aivi-hq/aivi/commit/4c126ea8f6f8d75ffe943767a7e86109517ec9d2), [`60090e2`](https://github.com/aivi-hq/aivi/commit/60090e289863139770fcbc90d3b8a8127590d60f), [`1ba4d46`](https://github.com/aivi-hq/aivi/commit/1ba4d46ea25ec79cb28a421fd511f462f70f39d1), [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72), [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa), [`a253aab`](https://github.com/aivi-hq/aivi/commit/a253aab2d0910e7052f8a3c3727996ea11aa4090), [`d482625`](https://github.com/aivi-hq/aivi/commit/d482625fee48116465ffbfe75ba650443a4c5e4e), [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1), [`0ec3f65`](https://github.com/aivi-hq/aivi/commit/0ec3f655de2817fa244d673abe797157282dc3c4), [`d337a15`](https://github.com/aivi-hq/aivi/commit/d337a15ee5e58fec7b9407db28fe38bbd91a87f9), [`91c4fe2`](https://github.com/aivi-hq/aivi/commit/91c4fe2e8b4c829394b2ab87072ff69bde60010c), [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f), [`8e26ad6`](https://github.com/aivi-hq/aivi/commit/8e26ad6aab5d49460cc54d965a36adfc31e651d8), [`3ef9b9a`](https://github.com/aivi-hq/aivi/commit/3ef9b9a19f023da3273a2785b5c417478805769d), [`27101b1`](https://github.com/aivi-hq/aivi/commit/27101b148fba461649476259b5c9550fa3284fde), [`5146981`](https://github.com/aivi-hq/aivi/commit/51469810da8a67fb5299969d560bfba9e76997f8)]:
  - @aivi/host@0.9.0
  - @aivi/plugin@0.9.0
  - @aivi/core@0.8.0
