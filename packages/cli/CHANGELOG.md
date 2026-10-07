# @aivi/cli

## 0.9.0

### Minor Changes

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d20d095`](https://github.com/aivi-hq/aivi/commit/d20d095f03d025373412a838944d724b92849a17) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Announce first, then do the disconnecting thing: `aivi service stop` and
  `aivi service restart` print `server stopping…` / `server restarting…` to
  stdout before the host goes down — a session driven over the exec relay
  reads the line before the drop — and both answer `not running as a service`
  where no unit is installed, before touching launchctl. The notice and the
  guard live in the two chokepoint functions, written synchronously so the
  `spawnSync` below cannot strand the bytes. `aivi update` no longer stops the
  host before npm: it installs while the server keeps answering and ends with
  the announced restart, so a remote `aivi -r update` survives its own slow
  part; `add` and `remove` restart through the same announced, atomic restart, which also
  closes the window where a dying host could kill the updater between stop and
  start and leave the service booted out.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`6ee4f1a`](https://github.com/aivi-hq/aivi/commit/6ee4f1a0e7d41e97a89289af15c12bd7034e8fed) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi -r <command>` drives the configured server with the very command you would type there: the relay opens the exec door with this machine's bearer, puts the terminal in raw mode, forwards bytes and window resizes, and restores the terminal on **every** exit path. When stdout is not a TTY (`aivi status | jq` from a laptop) the session asks for plain pipes — stdout untouched, stderr kept apart — and JSON stays JSON. Honest failures only: `no server configured — run aivi configure`, `host unreachable at <url>`, the refusal's own words from the server, or `connection lost`; a remote command never falls back to local execution, and plain commands never touch the network. New dependency: `ws` (the web-standard client swallows refusals; the server's answer is worth one small library).

- [#41](https://github.com/aivi-hq/aivi/pull/41) [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The client record moves to `~/.config/aivi/config.json`.** One
  `aivi.json` file among unrelated tools' files became a directory of its
  own, which is also where a plugin's secrets can live out of every
  agent's reach (the forge's .pem placeholder now names it). The path is
  now one fact in core — `clientConfigPath()` — that the host and the
  OpenCode plugin share; the CLI keeps its own computation, because the
  CLI may not import core (the packaging test is that wall). `AIVI_CONFIG`
  and `XDG_CONFIG_HOME` precedence is untouched. No migration: fresh
  homes write the new path and nothing reads the old one.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d440733`](https://github.com/aivi-hq/aivi/commit/d440733f48eeec27f288ee0d1a875d48ec891954) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi configure` — the client record's second writer, and the machine
  fact's first consumer. `aivi configure` shows the record (host, home, app
  dir, and the signed-in person by name — never by token); with
  `--url/--home/--app-dir` it edits it, refusing anything that is not an
  http(s) URL or an existing directory. It never touches the person: the
  token is audit evidence, and the most a person can become is *disabled*,
  a server-side people decision. It is registered exactly where a client
  record exists — existence, not parseability, because a broken record is
  exactly what the command repairs (a record that does not parse is written
  fresh around the fields that survive; a person block survives only when
  its token does) — and it refuses `--remote` like the rest of the
  client-side set. Along the way the record gained one honest loader:
  commands that take hints from it (Node, app dir, install method) read an
  unloadable file as none instead of dying on the schema dump, so a broken
  record no longer bricks `aivi uninstall`; the exec relay, the one site
  that *signs* with the record, reads the bytes itself and fails by name.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The CLI stays in its lane: it resolves the one machine fact — a home here, or none — once per run, shows it in the help header (`home: ~/.aivi` / `home: none`), and injects it into every command provider: `registerCommands(program, machine)` and the new `PluginCliContext.machine`. Providers decide membership themselves: a machine without a home registers only what it can do there (`setup`, `upgrade`, `uninstall` — the exit ramp exists wherever the CLI is), and a typed command it does not have is honestly `unknown command`. Nothing is hidden after the fact anymore. The logging options `--log-level`/`--log-format` moved off the root onto `serve`, the command that actually logs, so a provider never pollutes commands that are not its own.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - One `aivi` binary. The `aivi forward` relay — the second bin, the second help tree, and the argv byte-contract that trapped command bodies behind it — is gone: the CLI now mounts the installed server's operator commands **in-process**, a dynamic import of the home install's `./cli` onto its own commander tree, so `aivi --help` shows machine and operator commands together, ctrl+c hits one process instead of a three-process group, and the identity and plugin-setup steps are direct calls into the installed code. Machine commands still never load server code: a half-installed or broken app install shows the machine help with a one-line notice. `@aivi/app` retires into `@aivi/host`, which exports `./cli` — the command surface `serve` composes and the CLI mounts — and is published no more; `aivi serve` finally gets the `state/logs/aivi.log` file its documentation always promised. Setup's server-package flag is `--host-package` (it was `--app-spec` in 0.8.1), and its `--plugin` flag is retired: setup installs the server alone, plugins join afterwards with `aivi add` — which runs each plugin's own setup before listing it, so a package is never listed without its config block — and `aivi add` takes `file:` and directory specs, the way a development home installs its workspace builds. The `aivi-plugins` array in `<home>/app/package.json` is the one place that says which plugins exist: `aivi add` and `aivi remove` write and erase all three facts — the npm package, the list entry, and the `plugins.<id>` block in config.json — and rebuild the editor schema into `<home>/state/cache/schema.json`, which config.json's `$schema` hint points at.

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

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`d6fc317`](https://github.com/aivi-hq/aivi/commit/d6fc317e8b81bb3516312178a3e4d749331e3836) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **Template scaffolding — the worker files ship.** `packages/cli/templates/agents/`
  grows `product.md`, `dev.md` and `review.md` beside the assistant and the
  dreamer, and `aivi setup` seeds all five into `<home>/.opencode/agents/`,
  never overwriting what exists. The worker files carry the judgement — voice,
  the returning-work posture line, "Request changes for problems. Comments for
  nits.", and the permission denials an unattended run needs — while the
  mechanics stay in the orchestrator's first prompt, so nothing restates the
  tool contract. Written once, then plain files: editing them is the whole
  configuration.

### Patch Changes

- [#46](https://github.com/aivi-hq/aivi/pull/46) [`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A worker's execution that **fails** on the wire now ends its run at once,
  with the wire's own words as the reason. The watcher knew only an
  execution's start and its success: an unloadable model variant failed the
  drain 3 ms after the prompt (live, 2026-10-06), and the run sat `working`
  forever behind a keep-alive that promised "still working" to a deleted
  audience — no nudge, no failure, no slot back. The ticket stays where the
  person can see it: the worker never got to work on it.

- [#40](https://github.com/aivi-hq/aivi/pull/40) [`a020d28`](https://github.com/aivi-hq/aivi/commit/a020d28870b167393fc84b3ad70a1961c99e9c70) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi add` broke on Saturday's lazy-home change: the flow imported the
  host context's `home`/`configPath` through an `importApp` assertion that
  still called them strings, and handed `pluginSetup` the getter functions —
  `aivi add browser` died with `The "path" argument must be of type string…
  Received function configPath`. The assertion is honest now and the paths
  come from the home `add` was already given: `pluginSetup` receives strings
  derived from `options.home`, the way `remove` always did.

- [#45](https://github.com/aivi-hq/aivi/pull/45) [`b1591a7`](https://github.com/aivi-hq/aivi/commit/b1591a7f119437ff94963cbc1f80ab16d41a5f68) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Worker agent files enforce their permissions again. The `description:`
  frontmatter in `assistant.md`, `dev.md`, `product.md` and `review.md` held
  unquoted text containing `: ` — invalid YAML — and OpenCode enforced none of
  such an agent's permissions (verified 2026-10-06: a product agent whose file
  denied `edit` wrote straight through the deny; quoting the description made
  the deny bite). Descriptions are quoted now. `dreamer.md` was always valid.

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

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `host.public`: the address others reach aivi at (funnel, tunnel or proxy URL), asked once by `aivi setup` and preferred in every URL aivi prints for someone else to paste — the "another machine" connect lines, `aivi people create`'s token handoff, and `/status`. aivi keeps dialling `host.bind`/`host.port`; nothing is derived, and setup probes the address with nothing: during setup no server runs yet.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`9dc3da0`](https://github.com/aivi-hq/aivi/commit/9dc3da017cfe379ed4f2de108c8fa29771aa0e59) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host went pure: it parses no argv. `@aivi/host/server` is the boot — it loads the modules from the plugin list and runs `runHost`, and launchd/systemd units now point at `dist/server.js` with no `serve` argument; the `serve` command calls the same boot in-process. `@aivi/host/cli` exports `registerCommands` alone: what the host *provides*, while `@aivi/cli` is the one that *collects* — commander lives in exactly one tree, the bin's, on every path. The host's self-boot entry and its `rootBanner` are gone; the banner belongs to the bin alone.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi add linear` is a guided install. It starts only when a live aivi answers `GET /health`, walks through creating the Linear app, catches the browser's install round on a loopback listener bound before the instructions print, and proves the wiring before writing anything: one throwaway ticket, waited on twice in sequence — Linear must post its creation to the webhook URL, then delegating it must create an agent session whose event arrives the same way. Each wait owns one live spinner line and settles with a verdict naming the likeliest cause; the installer archives the ticket and ends with its own last line. The Linear worker starts from the delegate mutation's own answer, a delegation no lane can run is un-taken and gets one plain fixed answer, and an archived ticket gets nothing from a session.
  
  The install contract hands the flow the runner's own `@clack/prompts` as `ctx.prompts` and drops the `note`/`log`/`ask` proxies: the slack, discord and browser installers draw their own lines with it, refusing clack's cancel symbol and empty submits as the non-answers they are. After a successful setup the CLI adds nothing — the flow's own outro is the last word; the CLI reports only a restart it performs itself.

- [#34](https://github.com/aivi-hq/aivi/pull/34) [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - One assistant. The seeded home carries a single `assistant.md` — platform-neutral, the same being behind a chat message, an issue mention and a job delivery; what differs is the zoom, not the identity. `librarian.md` is retired and the Linear-seeded `aivi.md` merged into it; `discord.agent`, `slack.agent` and the Linear assistant now default to `assistant` (no persona-name slug), and Linear's module sends only facts (`platform:`, `issue:`, `project:`, `came by:`) — the do-not-do-the-work instructions live in the agent file, the whole boundary an operator can edit.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`451412f`](https://github.com/aivi-hq/aivi/commit/451412fc7e7a2dea01feb08f1d754fdddede4de5) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Vocabulary, comments only: there is one CLI. The label a past session invented for `@aivi/cli` — "the thin CLI" — is gone from the sources' comments and the docs; the CLI collects commands (from the host and from plugins, the same way) and the host provides them.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`f4b4545`](https://github.com/aivi-hq/aivi/commit/f4b454510d800b584f0238fd7c1280d38881bab0) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **`aivi uninstall` no longer hangs on a deaf OpenCode.** With the CLI on
  PATH but no service registered, `opencode plugin list` never exits, and the
  command froze mid-listing — no timeout in the test runner could fire,
  because the frozen spawn blocks the loop that enforces it. The probe now
  carries an OS-enforced 500 ms deadline on the spawn itself, and silence
  fails by name instead of an empty list reading as "no plugins".

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`2cc3cfc`](https://github.com/aivi-hq/aivi/commit/2cc3cfc1186f870df71431f440a79387988b94a1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Shutdown says so: `aivi serve` logs `host.stopping` the moment it takes a stop signal, so the drain that follows no longer reads as a hung terminal, and the Slack SDK's pong warnings are dropped once the module closes the socket on purpose (its errors still travel). The seeded assistant and dreamer agents now deny the `question` tool — no channel client can answer one yet, and a question in an unattended turn only hangs.

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

## 0.8.1

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.

## 0.8.0

### Minor Changes

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now a composed module like the channels, not a host resource. It claims its own `aivi_browser` descriptor at the `tools` door at start and releases it at stop, and the host serves that claim to the OpenCode plugin like any other tool. The `/v1/browser` endpoint, the `browser` field on host services and resources, and the `HostClient.browser` method are gone — the host holds no browser concept at all. `aivi install browser` now ends in the same verified truth as any other module: "Browser is running."

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now an opt-in install, not core. The `browser` block no longer prefaults: a fresh home has no browser and the plugin never sees an `aivi_browser` tool. `aivi install browser` puts `@aivi/browser` into the server home and its `./setup` writes the launch block; a configured block with a missing package names the command that fixes it.

- [#26](https://github.com/aivi-hq/aivi/pull/26) [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` with its own package version, read from `package.json` at runtime. The major is the contract, the minor is features: a client ahead of its host is refused with 403 `server_version_too_low`, a client behind the host's major with `client_version_unsupported` (`aivi upgrade`); a client behind within the major is served. `GET /version` and `GET /health` answer without the header. This release starts `@aivi/cli` and `@aivi/host` as a changesets `fixed` group, so their versions stay one number from here on. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL.

## 0.7.0

### Minor Changes

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`b965a26`](https://github.com/aivi-hq/aivi/commit/b965a265a70b19557cb55c531a72885b114c4063) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The example home is replaced by `dev/`, a real development home produced by
  `npm run aivi:cli setup` against the local build (`file:` specs install
  workspace packages; `AIVI_HOME=dev` and the new `AIVI_CONFIG` — which moves
  the client config file everywhere it is read, thin CLI, app identity, link,
  plugin — keep it separate from any real install). Setup now writes the app
  manifest it installs against, so a home inside another package can never
  anchor npm at that ancestor. Only the dev README is tracked.

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`08a8079`](https://github.com/aivi-hq/aivi/commit/08a8079fe0755789866adf3cdb158884cc61e757) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Link codes are minted for a named channel the person is not linked in yet:
  `GET /v1/links` lists the running channels with the caller's binding state,
  `POST /v1/links` requires a `channel` and refuses (404, 409) instead of
  minting a code nothing can read or one a person cannot spend — one binding
  per channel per person. `aivi link` picks among the eligible channels
  (prompting when several) and says so without minting when nothing is
  eligible; a terminal gets one sentence, a pipe the JSON record.

## 0.6.1

### Patch Changes

- [#18](https://github.com/aivi-hq/aivi/pull/18) [`3898c0e`](https://github.com/aivi-hq/aivi/commit/3898c0ea5cac792c5562efbf4af545968041fa92) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The published `aivi` died on any command: the help banner imported
  `@aivi/core`, which resolves only inside the workspace hoist, never in an
  installed package. The banner now ships inside the thin CLI, a unit test
  refuses any import that is not a declared dependency, and `npm run pack:smoke`
  (now part of `npm run check`) installs the packed tarball alone and runs the
  binary — help, version, and the no-home path — before a release can pass the
  gate.

## 0.6.0

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

## 0.5.0

### Minor Changes

- [#13](https://github.com/aivi-hq/aivi/pull/13) [`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi install discord|slack|NPM-SPEC` adds a plugin to the server home and lets it configure itself, replacing the manual config entry for the channels. npm installs the package into `<home>/app` (`--save-exact`, so `aivi update` carries it along), then the plugin's own `./setup` entry runs: it prints how to create the platform app, asks for the tokens (hidden), verifies each against the platform before anything is written — Discord's application id is derived from the bot, Slack's tokens answer `auth.test` and `apps.connections.open` — and writes its `modules.*` block into `config.json` and its secrets into `.env` (0600, never echoed; a write that leaves the config unloadable is restored). Then aivi restarts and the command ends in a verified truth: the module's own state from `/v1/status` ("Discord is running."). An already configured module is never clobbered, a foreground server is never restarted behind the operator's back, and a package without a `./setup` export is still installed, told as having no setup command. The contract is one subpath — any package exporting `./setup` with a default function installs this way; the plumbing (`aivi plugin setup SPEC`, not person-facing) and the write helpers (`writeConfigBlock`, `upsertEnvFile`) live in the app and core packages.

- [#11](https://github.com/aivi-hq/aivi/pull/11) [`aeb4ffc`](https://github.com/aivi-hq/aivi/commit/aeb4ffc30479bfd879ef2d575bcff2ba509b684c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi uninstall` deletes what aivi created on this machine and then the CLI itself. It is not interactive: it prints the absolute paths it would delete — the home, the client config, the background service, aivi's OpenCode plugin, and this CLI with the install method that answers for it — and deletes nothing until `--confirm`. Only a home with a `config.json` in it is ever deleted, so a wrong `AIVI_HOME` or a stale `home` field deletes nothing. The service goes before the home, `opencode plugin remove @aivi/opencode` goes with it, and `opencode-attribution` stays unless `--with-attribution`. `aivi upgrade` and `aivi uninstall` read one install-method table (npm today), so they can never disagree about what is installed.

## 0.4.0

### Minor Changes

- [#9](https://github.com/aivi-hq/aivi/pull/9) [`9995936`](https://github.com/aivi-hq/aivi/commit/999593665eb48f39c54d791e3075496c221933c1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi link [PLATFORM]` mints a one-time link code over HTTP and prints exactly where to spend it — the command runs on the person's machine and needs only the client config, no installed server. With several channel modules running it asks which hint to show; an unknown platform is refused with the list of running ones.

## 0.3.0

### Minor Changes

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`c8fa161`](https://github.com/aivi-hq/aivi/commit/c8fa1619b646bee229e56db5a7819e67329ec63b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi setup` is the one entry point for client and server; `server create` folds into it and is no longer a person-facing command. Connecting to a host verifies the url and token with `whoami` before anything is written, then installs both OpenCode plugins (`opencode plugin add @aivi/opencode`, `opencode-attribution`). Creating a server now also seeds the home's OpenCode shape (`opencode.jsonc` plus `aivi.md`, `librarian.md` and `dreamer.md` in `.opencode/agents/` — existing files are never overwritten), offers `aivi service install` on the same-machine path, and prints a verified "Signed in as …" instead of an instruction the CLI cannot keep. The client config's `person` gains a display-only `id`/`name`/`roles` cache, written from `whoami`.

## 0.2.1

### Patch Changes

- [#5](https://github.com/aivi-hq/aivi/pull/5) [`e2bff0d`](https://github.com/aivi-hq/aivi/commit/e2bff0d518d0700373d545cd2fdf16be940f821a) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The published `aivi` bin gains its shebang — without it the global command
  could not execute at all (the shell tried to run the JavaScript as a script).

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

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`9fe5d9e`](https://github.com/aivi-hq/aivi/commit/9fe5d9e167d71c7a1d232452dde4872c9e314a73) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - New: the thin `aivi` CLI. `aivi server create` writes the home structure,
  checks Node, installs `@aivi/app` plus chosen `--plugin` packages into
  `<home>/app`, records the installation in `~/.config/aivi.json`, then hands
  identity setup to the installed app's own `server create`. Every other
  command forwards into the installed app with `AIVI_HOME` set; the CLI never
  imports host code. `update` and `upgrade` arrive with the first release.
