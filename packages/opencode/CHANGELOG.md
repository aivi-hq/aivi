# @aivi/opencode

## 0.1.4

### Patch Changes

- [#13](https://github.com/aivi-hq/aivi/pull/13) [`1a1859b`](https://github.com/aivi-hq/aivi/commit/1a1859b39a3c21685f1dba33e4e448c9dd88f9ff) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The plugin loads again from npm. 0.1.3 shipped a root `server.js` that re-exported `./src/index.ts`, while `files` publishes only `dist` — so every install failed with "Cannot find module './src/index.ts'" and registered no aivi tools. Nothing ships from the package root now: `exports["."]` is the only export, and OpenCode's loader reaches it through its fallback candidate. The example home names the build it runs, `../packages/opencode/dist/index.js`, so a fresh clone runs `npm run build` before OpenCode loads the plugin.
- Updated dependencies [[`9f4d557`](https://github.com/aivi-hq/aivi/commit/9f4d557467d1efc928d211ab8f9d5ad19a094fc2)]:
  - @aivi/core@0.3.0
  - @aivi/host@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [[`07af4cc`](https://github.com/aivi-hq/aivi/commit/07af4ccc8c55de72872c1ea4c37b623b5f9b8827)]:
  - @aivi/host@0.3.0

## 0.1.2

### Patch Changes

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`dca3b2d`](https://github.com/aivi-hq/aivi/commit/dca3b2d8189a9056b7c0eff759765a3a75c51a46) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The plugin falls back to the client config (`~/.config/aivi.json`) for the host url and the person bearer when its options say nothing, so `aivi setup` can install it as a plain string and client sessions associate with the person without env setup. On a server home the cached bearer is ignored: host-originated sessions associate by their own identity, never the operator's.

## 0.1.1

### Patch Changes

- Updated dependencies [[`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c), [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7)]:
  - @aivi/host@0.2.0
  - @aivi/core@0.2.0
