# @aivi/cli

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
