# @aivi/host

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
