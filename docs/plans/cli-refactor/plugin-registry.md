# 3 · The plugin registry

Status: **landed 2026-09-28** on `refactor/single-cli-command`. Depends on:
[plugin-contract.md](plugin-contract.md) (landed). Unlocks:
[remote-exec.md](remote-exec.md) (visibility wants the list) and
knowledge-as-optional-plugin.
What landed, with the deviations; what is left, with its owner.

## What landed

The list is [`packages/host/src/cli/registry.ts`](../../../packages/host/src/cli/registry.ts):
read `<home>/app/package.json`'s `aivi-plugins` → import each listed
package's light `./config` subpath → compose the closed config schema
([`composeConfigSchema`](../../../packages/core/src/config.ts)) → parse
`config.json` against it. `serve` builds modules by looping the list
(`buildModules`); the CLI mounts every listed package's `./cli` regardless of
enabled; the editor schema is
[`schema-cache.ts`](../../../packages/host/src/cli/schema-cache.ts), called by
the CLI after the events that change what is valid. The three config
schemas live in their plugins; core knows no module names. The checked-in
schema, `scripts/schema.mjs` and the `schema:check` step are deleted; the
editor shape is `<state>/cache/schema.json`, and `config.json`'s `$schema`
points at it.

## Deviations from the sketch

- **The commands renamed while this landed:** `aivi add` / `aivi remove`
  (not `install`); `aivi uninstall` keeps exactly one meaning — whole-machine
  teardown. A plugin's own `./uninstall` subpath hook (like `./setup`) is the
  follow-up below.
- **All listed plugins contribute their schema, disabled ones included:**
  the sketch composed "the enabled plugins' schemas." The list entry is
  existence and validity; only `serve` honors *enabled*. A plugin on standby
  keeps its block valid and its commands mounted, so toggling the tuple
  needs no config edit.
- **`./config`, not the main entry:** the sketch imported each package's
  main entry. The registry imports the package's `./config` subpath — schema,
  module id and a `createModule` that imports the module code lazily — so
  `aivi status` never pulls discord.js or @slack/*. `createModule(config,
  home)` absolutizes its own path fields with core's `absolutePath`.
- **The list entry lands last, not together:** the sketch wrote the three
  facts together. `aivi add` writes npm dependency → the plugin's own setup
  (block + secrets) → the list entry → the cache rebuild → restart. A stopped
  flow leaves the package installed but inert (no entry, no block); nothing
  needs rolling back. `aivi remove` asks the module id from `./config` while
  the package is still installed, drops the block, the entry, the package,
  the cache, then restarts.
- **Core's schema is open on purpose** (`configShape.catchall(z.unknown())`):
  `writeConfigBlock` and `deleteConfigBlock` validate with it, which is what
  lets a removal write its steps in order. The *composed* schema is closed
  and strict, and it is what every host command and the editor parse
  against — the strictness promise stands on the serve path.
- **Enablement moved out of core's cross-field rules entirely:** core keeps
  only the generic `pluginPoolsAreNamed` (a block naming a `resource` must
  name a scheduler pool); Linear's primary-soundness rule sits in
  `linearSchema`'s own `superRefine`. No "enabled but unconfigured" check
  stands in core: the plugin's own schema demands what no default answers,
  and `buildModules` wraps that complaint naming the package.
- **The CLI edits the list as plain JSON** (`manifest.ts`): it carries
  no zod and no core; the host validates. `MODULE_BY_SPEC` is gone — the
  module id comes back from the setup flow (`PluginSetupResult.module`).
- **Cache events are `setup`, `add`, `remove`, `update`** — not `upgrade`,
  which updates the CLI binary and changes nothing in the home.
- **Package name vs module id, out loud:** the list holds npm **package
  names** (the install fact); each package's `./config` declares its **module
  id** (the `plugins.<id>` key, logger category, `/status` id). Third-party
  plugins fit with no new mechanism. Recorded in
  [CONTEXT.md](../../../CONTEXT.md)'s amended decision.

## Follow-ups

- **A plugin's own `./uninstall` subpath hook** (like `./setup`): today
  `aivi remove` covers the standard leaving through core's
  `deleteConfigBlock`; a plugin with parting work of its own (cleaning a
  platform webhook, say) has no entry to say it. The plumbing would mirror
  `plugin-setup.ts`.
- **Knowledge as an optional plugin.** The machinery already exists and
  already hardcodes nothing: modules claim tool *descriptors* on the
  `ToolRegistry` at `start` (claimed exactly once, second claimant fatal —
  [tools.ts](../../../packages/host/src/tools.ts)), `GET /tools` serves and
  `POST /tools` dispatches, and the OpenCode plugin "registers exactly what
  the list says at its load"
  ([opencode/src/index.ts](../../../packages/opencode/src/index.ts)) — no
  aivi tool is hardcoded there. So the move is: knowledge module claims its
  tools and jobs, `@aivi/knowledge` joins the list, `serve`'s loop imports
  it like any other. Mid-process re-registration stays out (prompt-cache
  rule; recovery is an OpenCode reload).
- The `dashboard` and `editor-mode` backlog pages sit downstream of this
  registry; neither blocks it.

## Checklist

- [x] `aivi-plugins` read + validation (array, string-or-tuple entries) from
      `<home>/app/package.json`; boot order: manifest → compose → parse.
- [x] Move the three config schemas into their plugins as `plugin.configSchema`;
      compose with the core envelope; both error directions produce the new
      messages.
- [x] `serve`: delete the hardcoded if-chain; loop the list.
- [x] `state/cache/schema.json` generation on setup/add/remove/update;
      `$schema` line written into `config.json`.
- [x] Delete `schemas/`, `scripts/schema.mjs`, the `schema:check` script and
      its `check` step; update AGENTS.md and configuration docs in the same
      commit.
- [x] `aivi add`/`remove` write/remove all three facts; lifecycle tests
      at the manifest and config boundaries.
- [x] Docs: [configuration.md](../../configuration.md) (enablement, cache
      file), [CONTEXT.md](../../../CONTEXT.md) (amended decision line),
      [operations.md](../../operations.md) (plugins section),
      [architecture.md](../../architecture.md) (`./cli` mount facts).
- [x] Changesets (fixed group) — landed 2026-09-28 in `53e55f4`
      (`.changeset/one-cli.md`: cli, host and plugin minor, all at 0.9.0).
      The D22 dev-home nuke stays parked with the operator.
