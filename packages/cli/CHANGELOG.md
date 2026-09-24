# @aivi/cli

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
