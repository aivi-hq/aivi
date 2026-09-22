# @aivi/opencode

## 0.1.2

### Patch Changes

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`dca3b2d`](https://github.com/aivi-hq/aivi/commit/dca3b2d8189a9056b7c0eff759765a3a75c51a46) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The plugin falls back to the client config (`~/.config/aivi.json`) for the host url and the person bearer when its options say nothing, so `aivi setup` can install it as a plain string and client sessions associate with the person without env setup. On a server home the cached bearer is ignored: host-originated sessions associate by their own identity, never the operator's.

## 0.1.1

### Patch Changes

- Updated dependencies [[`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c), [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7)]:
  - @aivi/host@0.2.0
  - @aivi/core@0.2.0
