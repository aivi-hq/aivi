# @aivi/host

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
