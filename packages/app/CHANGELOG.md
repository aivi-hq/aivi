# @aivi/app

## 0.6.1

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.
- Updated dependencies [[`e796858`](https://github.com/aivi-hq/aivi/commit/e796858f6b9dd1e964e37a337e43258e5df94ffa), [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95)]:
  - @aivi/host@0.8.1
  - @aivi/core@0.7.1
  - @aivi/knowledge@0.1.7

## 0.6.0

### Minor Changes

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now a composed module like the channels, not a host resource. It claims its own `aivi_browser` descriptor at the `tools` door at start and releases it at stop, and the host serves that claim to the OpenCode plugin like any other tool. The `/v1/browser` endpoint, the `browser` field on host services and resources, and the `HostClient.browser` method are gone — the host holds no browser concept at all. `aivi install browser` now ends in the same verified truth as any other module: "Browser is running."

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The browser is now an opt-in install, not core. The `browser` block no longer prefaults: a fresh home has no browser and the plugin never sees an `aivi_browser` tool. `aivi install browser` puts `@aivi/browser` into the server home and its `./setup` writes the launch block; a configured block with a missing package names the command that fixes it.

### Patch Changes

- Updated dependencies [[`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca), [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741), [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f), [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502)]:
  - @aivi/core@0.7.0
  - @aivi/host@0.8.0
  - @aivi/knowledge@0.1.6

## 0.5.0

### Minor Changes

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Command output is readable on a terminal and unchanged JSON in a pipe. Core
  gains an output renderer (`OutputBlock`, `renderOutput`, `formatTimestamp`,
  `print`): without a hand-written shape a command's value is shown as colored
  `util.inspect`; a command may pass blocks (log, heading, divider, table, raw
  `json`) instead — `aivi slack manifest` renders raw JSON so it stays
  paste-ready. Help loses its color theme; the wordmark stays.

### Patch Changes

- Updated dependencies [[`08a8079`](https://github.com/aivi-hq/aivi/commit/08a8079fe0755789866adf3cdb158884cc61e757), [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4)]:
  - @aivi/host@0.6.0
  - @aivi/core@0.6.0
  - @aivi/browser@0.1.5
  - @aivi/knowledge@0.1.5

## 0.4.1

### Patch Changes

- Updated dependencies [[`ad2895a`](https://github.com/aivi-hq/aivi/commit/ad2895a635925a5b23208bd34c915f7fca19f4ba)]:
  - @aivi/core@0.5.0
  - @aivi/host@0.5.0
  - @aivi/browser@0.1.4
  - @aivi/knowledge@0.1.4

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

### Patch Changes

- Updated dependencies [[`5d865bf`](https://github.com/aivi-hq/aivi/commit/5d865bfcea07feb096370b4fb0a27d8ea831433c), [`bc1f731`](https://github.com/aivi-hq/aivi/commit/bc1f7318b2a4a68ee514eb0d4f280c32c1acc252)]:
  - @aivi/core@0.4.0
  - @aivi/host@0.4.0
  - @aivi/browser@0.1.3
  - @aivi/knowledge@0.1.3

## 0.3.0

### Minor Changes

- [#13](https://github.com/aivi-hq/aivi/pull/13) [`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi install discord|slack|NPM-SPEC` adds a plugin to the server home and lets it configure itself, replacing the manual config entry for the channels. npm installs the package into `<home>/app` (`--save-exact`, so `aivi update` carries it along), then the plugin's own `./setup` entry runs: it prints how to create the platform app, asks for the tokens (hidden), verifies each against the platform before anything is written — Discord's application id is derived from the bot, Slack's tokens answer `auth.test` and `apps.connections.open` — and writes its `modules.*` block into `config.json` and its secrets into `.env` (0600, never echoed; a write that leaves the config unloadable is restored). Then aivi restarts and the command ends in a verified truth: the module's own state from `/v1/status` ("Discord is running."). An already configured module is never clobbered, a foreground server is never restarted behind the operator's back, and a package without a `./setup` export is still installed, told as having no setup command. The contract is one subpath — any package exporting `./setup` with a default function installs this way; the plumbing (`aivi plugin setup SPEC`, not person-facing) and the write helpers (`writeConfigBlock`, `upsertEnvFile`) live in the app and core packages.

### Patch Changes

- Updated dependencies [[`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2)]:
  - @aivi/core@0.3.0
  - @aivi/browser@0.1.2
  - @aivi/host@0.3.1
  - @aivi/knowledge@0.1.2

## 0.2.2

### Patch Changes

- [#9](https://github.com/aivi-hq/aivi/pull/9) [`83ee281`](https://github.com/aivi-hq/aivi/commit/83ee281de432bae3ed712c41504614d098525c1f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `aivi slack manifest [--prefix PREFIX]` prints the whole Slack app manifest as JSON, ready to paste into Slack's app setup. The prefix comes from `--prefix`, else the configured module's `commandPrefix`, else an interactive prompt (a script without a configured module is told what to pass). The display name is the persona from `identity.name`.
- Updated dependencies [[`07af4cc`](https://github.com/aivi-hq/aivi/commit/07af4ccc8c55de72872c1ea4c37b623b5f9b8827)]:
  - @aivi/host@0.3.0

## 0.2.1

### Patch Changes

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`5ea68da`](https://github.com/aivi-hq/aivi/commit/5ea68da80aaa108a5d43131eb983300496e6c3f4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `server create` becomes the identity step behind `aivi setup` and its output feeds the flow instead of addressing the person: the `next` instructions name commands that exist (`aivi setup`, `aivi serve`). `aivi people create` on a terminal offers to mint the person's token right away — the common reason to create a person.

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`12dd432`](https://github.com/aivi-hq/aivi/commit/12dd432b92d028b0459ffa450707b3d2b0be3831) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Declare `@aivi/browser` as a dependency: `serve` imports it on the default path (skipped only with `browser: false`), so a fresh `npm install @aivi/app` died with `Cannot find package '@aivi/browser'` before the host ever listened. The monorepo's workspace links hid the gap; an installed home does not have them.

## 0.2.0

### Minor Changes

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`9fe5d9e`](https://github.com/aivi-hq/aivi/commit/9fe5d9e167d71c7a1d232452dde4872c9e314a73) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The channel and browser packages are no longer dependencies of `@aivi/app`:
  each module's package loads when its config block enables it, so an
  installation without a channel package runs every other command untouched.
  Linear client resolution moved to `@aivi/linear` (`clientFor`).

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
  - @aivi/host@0.2.0
  - @aivi/core@0.2.0
  - @aivi/knowledge@0.1.1
