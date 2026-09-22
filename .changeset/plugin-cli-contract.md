---
'@aivi/host': minor
'@aivi/app': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/linear': minor
'@aivi/core': minor
---

A plugin can extend the operator CLI: where `./setup` is the install-time
subpath, `./cli` is the runtime one — a package that default-exports a
`PluginCliCommand` from `./cli` is mounted into the server CLI under Channels
whenever the package is installed, with parsing and help owned by the app's
commander and `run` receiving a `PluginCliContext` (loaded config, store
bracket, the shared JSON stdout, the host poke, one prompt). `aivi discord`,
`aivi slack` and `aivi linear` now come from their own packages through that
contract. The brand color moves to `#3B82FF` — the wordmark and the help terms
in the CLI, and the `aivi·host` log category, share it.
