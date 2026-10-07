# @aivi/channel-discord

## 0.6.0

### Minor Changes

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

### Patch Changes

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi add linear` is a guided install. It starts only when a live aivi answers `GET /health`, walks through creating the Linear app, catches the browser's install round on a loopback listener bound before the instructions print, and proves the wiring before writing anything: one throwaway ticket, waited on twice in sequence — Linear must post its creation to the webhook URL, then delegating it must create an agent session whose event arrives the same way. Each wait owns one live spinner line and settles with a verdict naming the likeliest cause; the installer archives the ticket and ends with its own last line. The Linear worker starts from the delegate mutation's own answer, a delegation no lane can run is un-taken and gets one plain fixed answer, and an archived ticket gets nothing from a session.
  
  The install contract hands the flow the runner's own `@clack/prompts` as `ctx.prompts` and drops the `note`/`log`/`ask` proxies: the slack, discord and browser installers draw their own lines with it, refusing clack's cancel symbol and empty submits as the non-answers they are. After a successful setup the CLI adds nothing — the flow's own outro is the last word; the CLI reports only a restart it performs itself.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`28ea174`](https://github.com/aivi-hq/aivi/commit/28ea174de19798b081b2e3fde5b07431092e0171) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Documentation of the built thing: operations.md gained *Running remotely*
  (the `/exec` transport, the closed child env, the visibility table of who
  refuses `--remote` and with which words, the `(remote)` banner, the
  announce-before-drop); people.md's auth section tells the `operator` gate in
  present tense; CONTEXT.md adds the words *exec channel / relay* and *driven
  session*; the CLI README's command table gained `--remote`, the per-state
  membership note, and a fix of the stale `aivi install` rows (here and in the
  channel READMEs — the command is `aivi add`). The relay's
  `no server configured` answer now names `aivi setup`, the command that
  exists today.

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
- Updated dependencies [[`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9), [`1b7a209`](https://github.com/aivi-hq/aivi/commit/1b7a2092b65170f4e91e86c37a00f97effc4bb8f), [`49977a5`](https://github.com/aivi-hq/aivi/commit/49977a51a8186c4fffecd740b41bdd6590b2a653), [`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69), [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4), [`e2b7730`](https://github.com/aivi-hq/aivi/commit/e2b7730ed2e9b5bc1cb1c577fbd890f518fe101d), [`c7ed291`](https://github.com/aivi-hq/aivi/commit/c7ed2915019c3a45d194a87b7c6a0a6bf99546fa), [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947), [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260), [`69a6c28`](https://github.com/aivi-hq/aivi/commit/69a6c28f3d2cfd25b045d364b02513e802fa2a62), [`97071b5`](https://github.com/aivi-hq/aivi/commit/97071b52d993af52a7904f506dc94d0abba533e0), [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4), [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973), [`fad218f`](https://github.com/aivi-hq/aivi/commit/fad218fe1bb1a4ff1f88545c16c3ad2ab9627aed), [`dc2c16a`](https://github.com/aivi-hq/aivi/commit/dc2c16aa1fa68173d478f5c331bf67f0c56500c9), [`fe7eaeb`](https://github.com/aivi-hq/aivi/commit/fe7eaeb00052bca97d17f5ed1bcbccb591523b86), [`955f2d6`](https://github.com/aivi-hq/aivi/commit/955f2d63d04b1ed4b2ad815ae7c02dc6bab45420), [`d71af5b`](https://github.com/aivi-hq/aivi/commit/d71af5b0a51f80123031c9938a96b723bff7b17e), [`029c8ea`](https://github.com/aivi-hq/aivi/commit/029c8eadbee74e7cd11165535911545a69897c60), [`9b21539`](https://github.com/aivi-hq/aivi/commit/9b215391bfd45a81bdf8967849f80ad2d3d3e2f0), [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b), [`9dc3da0`](https://github.com/aivi-hq/aivi/commit/9dc3da017cfe379ed4f2de108c8fa29771aa0e59), [`edd4bfc`](https://github.com/aivi-hq/aivi/commit/edd4bfc3a2704c46d445b38697b5d89fbe5eda7d), [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0), [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a), [`69735bd`](https://github.com/aivi-hq/aivi/commit/69735bd7b7842dc4c4e311b49fb7c7ece7f28c3d), [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147), [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6), [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c), [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6), [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862), [`7faf7c5`](https://github.com/aivi-hq/aivi/commit/7faf7c5b130ad0822870b04a7695a9d17ec24a7c), [`295ee5f`](https://github.com/aivi-hq/aivi/commit/295ee5f3b34f746cb0588c0c1aa293aab27e41b1), [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464), [`451412f`](https://github.com/aivi-hq/aivi/commit/451412fc7e7a2dea01feb08f1d754fdddede4de5), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`85817ad`](https://github.com/aivi-hq/aivi/commit/85817ad0e12563c9dfc79535c8a0a735022f2524), [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288), [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485), [`522640b`](https://github.com/aivi-hq/aivi/commit/522640b2c5ccb520ab0c24f303bfe149b1a99104), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`4d2e509`](https://github.com/aivi-hq/aivi/commit/4d2e5091c0351920c9dbdd6af351cf66f26212b3), [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009), [`2cc3cfc`](https://github.com/aivi-hq/aivi/commit/2cc3cfc1186f870df71431f440a79387988b94a1), [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91), [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b), [`bf6c5b0`](https://github.com/aivi-hq/aivi/commit/bf6c5b052735c0f6b2331cb972519f08b2d9ed43), [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db), [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9), [`9d067d3`](https://github.com/aivi-hq/aivi/commit/9d067d398b08ef0a79d839259ecc288ed4b162e4), [`3c6ee07`](https://github.com/aivi-hq/aivi/commit/3c6ee07b69dfdf3ff084aed1093e6364883106a9), [`4c126ea`](https://github.com/aivi-hq/aivi/commit/4c126ea8f6f8d75ffe943767a7e86109517ec9d2), [`60090e2`](https://github.com/aivi-hq/aivi/commit/60090e289863139770fcbc90d3b8a8127590d60f), [`1ba4d46`](https://github.com/aivi-hq/aivi/commit/1ba4d46ea25ec79cb28a421fd511f462f70f39d1), [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72), [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa), [`a253aab`](https://github.com/aivi-hq/aivi/commit/a253aab2d0910e7052f8a3c3727996ea11aa4090), [`d482625`](https://github.com/aivi-hq/aivi/commit/d482625fee48116465ffbfe75ba650443a4c5e4e), [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1), [`0ec3f65`](https://github.com/aivi-hq/aivi/commit/0ec3f655de2817fa244d673abe797157282dc3c4), [`d337a15`](https://github.com/aivi-hq/aivi/commit/d337a15ee5e58fec7b9407db28fe38bbd91a87f9), [`91c4fe2`](https://github.com/aivi-hq/aivi/commit/91c4fe2e8b4c829394b2ab87072ff69bde60010c), [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f), [`8e26ad6`](https://github.com/aivi-hq/aivi/commit/8e26ad6aab5d49460cc54d965a36adfc31e651d8), [`3ef9b9a`](https://github.com/aivi-hq/aivi/commit/3ef9b9a19f023da3273a2785b5c417478805769d), [`27101b1`](https://github.com/aivi-hq/aivi/commit/27101b148fba461649476259b5c9550fa3284fde), [`5146981`](https://github.com/aivi-hq/aivi/commit/51469810da8a67fb5299969d560bfba9e76997f8)]:
  - @aivi/host@0.9.0
  - @aivi/plugin@0.9.0
  - @aivi/core@0.8.0

## 0.5.3

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.
- Updated dependencies [[`e796858`](https://github.com/aivi-hq/aivi/commit/e796858f6b9dd1e964e37a337e43258e5df94ffa), [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95)]:
  - @aivi/host@0.8.1
  - @aivi/core@0.7.1

## 0.5.2

### Patch Changes

- Updated dependencies [[`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca), [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741), [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f), [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502)]:
  - @aivi/core@0.7.0
  - @aivi/host@0.8.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`08a8079`](https://github.com/aivi-hq/aivi/commit/08a8079fe0755789866adf3cdb158884cc61e757), [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4)]:
  - @aivi/host@0.6.0
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
  - @aivi/host@0.5.0

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
  - @aivi/host@0.4.0

## 0.3.0

### Minor Changes

- [#13](https://github.com/aivi-hq/aivi/pull/13) [`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi install discord|slack|NPM-SPEC` adds a plugin to the server home and lets it configure itself, replacing the manual config entry for the channels. npm installs the package into `<home>/app` (`--save-exact`, so `aivi update` carries it along), then the plugin's own `./setup` entry runs: it prints how to create the platform app, asks for the tokens (hidden), verifies each against the platform before anything is written — Discord's application id is derived from the bot, Slack's tokens answer `auth.test` and `apps.connections.open` — and writes its `modules.*` block into `config.json` and its secrets into `.env` (0600, never echoed; a write that leaves the config unloadable is restored). Then aivi restarts and the command ends in a verified truth: the module's own state from `/v1/status` ("Discord is running."). An already configured module is never clobbered, a foreground server is never restarted behind the operator's back, and a package without a `./setup` export is still installed, told as having no setup command. The contract is one subpath — any package exporting `./setup` with a default function installs this way; the plumbing (`aivi plugin setup SPEC`, not person-facing) and the write helpers (`writeConfigBlock`, `upsertEnvFile`) live in the app and core packages.

### Patch Changes

- Updated dependencies [[`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2)]:
  - @aivi/core@0.3.0
  - @aivi/host@0.3.1

## 0.2.1

### Patch Changes

- [#9](https://github.com/aivi-hq/aivi/pull/9) [`6a86056`](https://github.com/aivi-hq/aivi/commit/6a86056cfef62ec76801080170e2dabc9950420b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The shared `/link` command works on Discord: it consumes the one-time code from `aivi link` and binds the Discord account to the person, with the host-authored confirmation or refusal. The module describes its redemption in `linkHint` so `aivi link` shows it.
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
