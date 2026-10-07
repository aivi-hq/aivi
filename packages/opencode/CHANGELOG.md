# @aivi/opencode

## 0.4.0

### Minor Changes

- [#41](https://github.com/aivi-hq/aivi/pull/41) [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The client record moves to `~/.config/aivi/config.json`.** One
  `aivi.json` file among unrelated tools' files became a directory of its
  own, which is also where a plugin's secrets can live out of every
  agent's reach (the forge's .pem placeholder now names it). The path is
  now one fact in core — `clientConfigPath()` — that the host and the
  OpenCode plugin share; the CLI keeps its own computation, because the
  CLI may not import core (the packaging test is that wall). `AIVI_CONFIG`
  and `XDG_CONFIG_HOME` precedence is untouched. No migration: fresh
  homes write the new path and nothing reads the old one.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - **The redirect hook.** aivi's own plugin now denies boundary git — `git
  push`, `fetch`, `pull`, `clone`, `ls-remote`, `remote`, behind any flags or
  `-c` prefixes — **in aivi's runs only**, and says the way across instead:
  "git push is disabled in aivi runs — use aivi_push (and aivi_sync first if
  the remote moved)". Scoped by sessionID: the plugin asks the host's new
  `GET /run?session=` once per session (answered from the run ledger) and
  caches; a person's sessions never see the deny, and a host that cannot
  answer fails open — the worktree's no-credential mark is the wall, the
  hook is the signpost.

### Patch Changes

- [#39](https://github.com/aivi-hq/aivi/pull/39) [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The pinned `@opencode/*` family moved to 2.0.23. Nothing in aivi changed: the same endpoints under the same discovery rules — the release only added routes (`/api/credential`, `/api/vcs/init`), none moved — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The OpenCode-side plugin takes its host client from `@aivi/plugin/api` (was `@aivi/host/client`); the tools it registers and the way it talks to the host are unchanged.

- [#36](https://github.com/aivi-hq/aivi/pull/36) [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The small honest fixes from the code sweep. `ToolError` and
  `ConfigurationError` are defined in the kit's module contract and
  re-exported by the host, so plugin packages no longer import them from
  `@aivi/host`. Every durable write lands whole or not at all — temp next
  door, rename over; `.env`'s temp is created 0600 so a secret never sits
  world-readable. `manualSources` tells an absent install record from a
  corrupt one, naming the file like the host's registry reader already did.
  An interjection neither steered nor queued is said in the conversation,
  never a log line alone. A lane that lost its worker while a run waited
  releases its slot and says `lane-workless` instead of writing an
  `undefined` agent into a run row. The redirect hook reads `git remote`
  by the sub-verb: the name list and `get-url` cross nothing and pass;
  rewriting them stays refused. `aivi_config read` of a corrupt
  config.json names itself instead of a shapeless "Internal error". The
  Linear MCP proxy caps its body at 1 MiB like every other reader. The
  dreaming transcript says a *channel* names its speaker — the prefix is
  the shared engine's, not one platform's. The dead `--lane`/`--unlane`
  flag readers are gone; the wizard asks per lane now.
- Updated dependencies [[`fdeb03d`](https://github.com/aivi-hq/aivi/commit/fdeb03d3f85ec650f6628e15c5fcd3b0c47c41c9), [`1b7a209`](https://github.com/aivi-hq/aivi/commit/1b7a2092b65170f4e91e86c37a00f97effc4bb8f), [`49977a5`](https://github.com/aivi-hq/aivi/commit/49977a51a8186c4fffecd740b41bdd6590b2a653), [`9a68ba8`](https://github.com/aivi-hq/aivi/commit/9a68ba8be05b321f8558d7bd79073ab3bcdacc69), [`059eff9`](https://github.com/aivi-hq/aivi/commit/059eff9fcb90e85bde1c9a3f8d303085f0ed8ad4), [`3a1f320`](https://github.com/aivi-hq/aivi/commit/3a1f320833924e764c098fbd0ad915f8adfd9947), [`782bd72`](https://github.com/aivi-hq/aivi/commit/782bd72a9dfa5296edcb67607c301ee62a9da260), [`5db22c0`](https://github.com/aivi-hq/aivi/commit/5db22c0967918e90e7f4283349dd947dfdcffab4), [`5aadd11`](https://github.com/aivi-hq/aivi/commit/5aadd11c933366a995ceecad3610925cc3578973), [`955f2d6`](https://github.com/aivi-hq/aivi/commit/955f2d63d04b1ed4b2ad815ae7c02dc6bab45420), [`029c8ea`](https://github.com/aivi-hq/aivi/commit/029c8eadbee74e7cd11165535911545a69897c60), [`b45e357`](https://github.com/aivi-hq/aivi/commit/b45e35767ad5d77d3c4e9cc5672e596b46defb2b), [`77bbf5e`](https://github.com/aivi-hq/aivi/commit/77bbf5efd67f3868a9076c69c31444f67a64e5f0), [`5b7a113`](https://github.com/aivi-hq/aivi/commit/5b7a113ee23d3cc1c88b81fc7ffd9dd9fd52ce6a), [`69735bd`](https://github.com/aivi-hq/aivi/commit/69735bd7b7842dc4c4e311b49fb7c7ece7f28c3d), [`5eb13d2`](https://github.com/aivi-hq/aivi/commit/5eb13d21bb5df7ac0e738929c50a5e9400207147), [`be7ae66`](https://github.com/aivi-hq/aivi/commit/be7ae661699b53cd508c48d70059e51a489289c6), [`3d5fcfe`](https://github.com/aivi-hq/aivi/commit/3d5fcfef39f642e66117948c2a6cdb620a76487c), [`e506772`](https://github.com/aivi-hq/aivi/commit/e50677218b2f3fa546323eca77f1cb71599ef2b6), [`e768f5f`](https://github.com/aivi-hq/aivi/commit/e768f5fec26490bceaf94d0e2824ff06f81fa862), [`7faf7c5`](https://github.com/aivi-hq/aivi/commit/7faf7c5b130ad0822870b04a7695a9d17ec24a7c), [`551d893`](https://github.com/aivi-hq/aivi/commit/551d893fa140af07b00f5a9253334f0d346dd464), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`c2cce34`](https://github.com/aivi-hq/aivi/commit/c2cce34995e27779eb1f20cd2c855eff98a0c288), [`853e799`](https://github.com/aivi-hq/aivi/commit/853e799f4722a52931f9eaf4da0e5ea8ee63b485), [`53e55f4`](https://github.com/aivi-hq/aivi/commit/53e55f42307eff1f4c8ebb7197215eb368c9298d), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`4d2e509`](https://github.com/aivi-hq/aivi/commit/4d2e5091c0351920c9dbdd6af351cf66f26212b3), [`8948624`](https://github.com/aivi-hq/aivi/commit/894862421ad6b648d4a5b9950a24f9336cda2009), [`3ef4d17`](https://github.com/aivi-hq/aivi/commit/3ef4d170bbd3e9490e960a13d75822e402a88a91), [`84de686`](https://github.com/aivi-hq/aivi/commit/84de68697cc0956859093432517b43392cec66ae), [`fca4e0c`](https://github.com/aivi-hq/aivi/commit/fca4e0ca8ec58a0d7608981396042d0263696fef), [`06883a4`](https://github.com/aivi-hq/aivi/commit/06883a48e5b5e9805bbafd86edbd4d2628bd4f3b), [`bf6c5b0`](https://github.com/aivi-hq/aivi/commit/bf6c5b052735c0f6b2331cb972519f08b2d9ed43), [`692c39f`](https://github.com/aivi-hq/aivi/commit/692c39fac85003287b92a568a185b9197b2210db), [`925b96d`](https://github.com/aivi-hq/aivi/commit/925b96d2a91faf5e77c21944aaa369ecd2681ba9), [`1ba4d46`](https://github.com/aivi-hq/aivi/commit/1ba4d46ea25ec79cb28a421fd511f462f70f39d1), [`7299b43`](https://github.com/aivi-hq/aivi/commit/7299b43853c16ec348eff3e6aaf42d7324585c72), [`7b061e2`](https://github.com/aivi-hq/aivi/commit/7b061e291808863fea1c152853f3f79faa6248aa), [`a253aab`](https://github.com/aivi-hq/aivi/commit/a253aab2d0910e7052f8a3c3727996ea11aa4090), [`d482625`](https://github.com/aivi-hq/aivi/commit/d482625fee48116465ffbfe75ba650443a4c5e4e), [`e2307ae`](https://github.com/aivi-hq/aivi/commit/e2307ae85150791de09967e164b5dfb6020651a1), [`0ec3f65`](https://github.com/aivi-hq/aivi/commit/0ec3f655de2817fa244d673abe797157282dc3c4), [`d337a15`](https://github.com/aivi-hq/aivi/commit/d337a15ee5e58fec7b9407db28fe38bbd91a87f9), [`343d0f8`](https://github.com/aivi-hq/aivi/commit/343d0f8f5d22e5319071d7bfa4d6189edd51736f), [`8e26ad6`](https://github.com/aivi-hq/aivi/commit/8e26ad6aab5d49460cc54d965a36adfc31e651d8), [`3ef9b9a`](https://github.com/aivi-hq/aivi/commit/3ef9b9a19f023da3273a2785b5c417478805769d)]:
  - @aivi/plugin@0.9.0
  - @aivi/core@0.8.0

## 0.3.1

### Patch Changes

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`e796858`](https://github.com/aivi-hq/aivi/commit/e796858f6b9dd1e964e37a337e43258e5df94ffa) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The pinned `@opencode/*` family moved to 2.0.18. Nothing in aivi changed: the same endpoints under the same discovery rules — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.

- [#30](https://github.com/aivi-hq/aivi/pull/30) [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - A quality pass with no behavior change (PR [#28](https://github.com/aivi-hq/aivi/issues/28), merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.
- Updated dependencies [[`e796858`](https://github.com/aivi-hq/aivi/commit/e796858f6b9dd1e964e37a337e43258e5df94ffa), [`7643e48`](https://github.com/aivi-hq/aivi/commit/7643e48dce0f9676dfb4febabd7be43341d22d95)]:
  - @aivi/host@0.8.1
  - @aivi/core@0.7.1

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
