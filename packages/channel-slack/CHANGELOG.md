# @aivi/channel-slack

## 0.3.0

### Minor Changes

- [#9](https://github.com/aivi-hq/aivi/pull/9) [`5db5a01`](https://github.com/aivi-hq/aivi/commit/5db5a0190f091b28f35511358e95ea646be97c2b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `slackManifest(prefix, info)` generates the whole Slack app manifest as JSON from the shared command table — paste-ready for Slack's app setup, with the persona name as the app and bot display name. The existing YAML snippet stays, and a test keeps both spellings equal.

### Patch Changes

- [#9](https://github.com/aivi-hq/aivi/pull/9) [`d755407`](https://github.com/aivi-hq/aivi/commit/d7554075b5eb78b7fc4a6054fe6e0f340742149a) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The shared `/link` command works on Slack (`/{prefix}-link CODE`): it consumes the one-time code from `aivi link` and binds the Slack account to the person, with the host-authored confirmation or refusal. The manifest in docs/slack.md gains the command, kept current by its test.
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
