# @aivi/opencode

## 0.3.0

### Minor Changes

- [#24](https://github.com/aivi-hq/aivi/pull/24) [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The OpenCode plugin JITs its tools: each capability's owner contributes a descriptor, the host serves them at `GET /v1/tools` and dispatches calls at `POST /v1/tools`, and the plugin registers exactly what the host offered at load. The plugin hardcodes no aivi tools; its own `aivi_connection` reports reachability, version and which tools this process loaded.

### Patch Changes

- [#26](https://github.com/aivi-hq/aivi/pull/26) [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` with its own package version, read from `package.json` at runtime. The major is the contract, the minor is features: a client ahead of its host is refused with 403 `server_version_too_low`, a client behind the host's major with `client_version_unsupported` (`aivi upgrade`); a client behind within the major is served. `GET /version` and `GET /health` answer without the header. This release starts `@aivi/cli` and `@aivi/host` as a changesets `fixed` group, so their versions stay one number from here on. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL.
- Updated dependencies [[`74b7e19`](https://github.com/aivi-hq/aivi/commit/74b7e19c0960f9e4fcd1345f58bb305e61fba8ca), [`b5ad28e`](https://github.com/aivi-hq/aivi/commit/b5ad28e063946feb0c80173f78e61d9b2767b741), [`d2b144c`](https://github.com/aivi-hq/aivi/commit/d2b144c9d713e97f32b0e3ab6c1921f5efc37e7f), [`197f811`](https://github.com/aivi-hq/aivi/commit/197f811234d5258f76607c02818593d4c1a6a502)]:
  - @aivi/core@0.7.0
  - @aivi/host@0.8.0

## 0.2.0

### Minor Changes

- [#22](https://github.com/aivi-hq/aivi/pull/22) [`b965a26`](https://github.com/aivi-hq/aivi/commit/b965a265a70b19557cb55c531a72885b114c4063) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The example home is replaced by `dev/`, a real development home produced by
  `npm run aivi:cli setup` against the local build (`file:` specs install
  workspace packages; `AIVI_HOME=dev` and the new `AIVI_CONFIG` — which moves
  the client config file everywhere it is read, thin CLI, app identity, link,
  plugin — keep it separate from any real install). Setup now writes the app
  manifest it installs against, so a home inside another package can never
  anchor npm at that ancestor. Only the dev README is tracked.

### Patch Changes

- Updated dependencies [[`08a8079`](https://github.com/aivi-hq/aivi/commit/08a8079fe0755789866adf3cdb158884cc61e757), [`214869d`](https://github.com/aivi-hq/aivi/commit/214869ddfa23280f5649793ccb9bf8c0fbe97fc4)]:
  - @aivi/host@0.6.0
  - @aivi/core@0.6.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`ad2895a`](https://github.com/aivi-hq/aivi/commit/ad2895a635925a5b23208bd34c915f7fca19f4ba)]:
  - @aivi/core@0.5.0
  - @aivi/host@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`5d865bf`](https://github.com/aivi-hq/aivi/commit/5d865bfcea07feb096370b4fb0a27d8ea831433c), [`bc1f731`](https://github.com/aivi-hq/aivi/commit/bc1f7318b2a4a68ee514eb0d4f280c32c1acc252)]:
  - @aivi/core@0.4.0
  - @aivi/host@0.4.0

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
