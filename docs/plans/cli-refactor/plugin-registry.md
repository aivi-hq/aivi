# 3 · The plugin registry

Status: planned. Depends on: [plugin-contract.md](plugin-contract.md).
Unlocks: [remote-exec.md](remote-exec.md) (visibility wants the list) and
knowledge-as-optional-plugin.
Goal: one stated place says which plugins exist and which are enabled; every
plugin validates its own config block; the hardcoded plugin knowledge leaves
`serve` and core.

## The list

```json
{
  "name": "aivi-home",
  "dependencies": { "@aivi/host": "…", "@aivi/browser": "…", "@aivi/channel-discord": "…" },
  "aivi-plugins": ["@aivi/browser", ["@aivi/channel-discord", false]]
}
```

- **Why package.json and not config.json:** `config.json` must validate
  against a *closed, complete* schema — and the list is what defines
  completeness. A list inside config.json makes the file describe its own
  schema (envelope → list → compose → re-parse). `<home>/app/package.json` is
  owned by aivi (setup writes it, `aivi install` npm-edits it) and is already
  the install record; the list is the enablement record. npm tolerates unknown
  fields.
- **Array shape, disable by tuple:** the 99% case (nothing disabled) never
  writes `: true`; disabling a plugin is a debug operation. Entry present, or
  tuple with `true` → enabled. Tuple with `false` → present but disabled.
- Boot order, no chicken-and-egg: **1.** read `package.json` (plain JSON, no
  zod) → **2.** compose the `configSchema`s of enabled plugins → **3.** parse
  `config.json` against the closed result.

## Enablement

Today: *"Presence of a validated block enables its module"* — and `serve`
hardcodes each plugin by name
([server.ts:23-30](../../../packages/app/src/commands/server.ts)):
four `if (config.<block>) modules.push(await import(<package>))` lines. After:

```ts
for (const entry of manifest.aiviPlugins) {
  const [pkg, enabled] = typeof entry === 'string' ? [entry, true] : entry;
  if (!enabled) continue;
  const { plugin } = await import(pkg); // main entry only: no commander in serve
  modules.push(plugin.createModule(loaded.config[plugin.moduleId]));
}
```

- Listed and not `false` → enabled. The config **block stops enabling**.
- Listed without a block → the plugin's own schema decides (defaults, or a
  clear "enabled but unconfigured" error).
- Block without the list → a new error naming the plugin: configured, not
  registered. Strict composition makes this an editor-visible invalidity too.
- `aivi install <plugin>` writes the three facts together — npm dependency
  (already does), list entry (new), config block (its `./setup` already does);
  uninstall removes them.
- [CONTEXT.md](../../../CONTEXT.md) "One config file, and it is yours" is
  amended in the landing commit: the list enables; a block is configuration
  only.

## Per-plugin config schemas (decision D7)

`discordConfigSchema` (`core/src/config.ts:480`), `linearSchema`, and
`browserConfigSchema` move into their plugins and are exposed as
`plugin.configSchema` (zod composes; zod stays a core dep). Core's schema
keeps core fields and treats module blocks as an open record for composition;
it stops knowing module names entirely.

## Editor schema

Composition moved to the home, so the editor schema is composed **there**:

- `<home>/state/cache/schema.json` — composed from the enabled plugins'
  schemas, written after the events that change the set: `setup`, `install`,
  `uninstall`, `upgrade`. Never a timer; it is derived, rebuildable data,
  which is exactly what `state/cache/` is for (the QMD index next door makes
  the precedent).
- `config.json` points at it: `"$schema": "./state/cache/schema.json"` — a
  relative path, resolved against the file; that already works, no absolute
  URI machinery.
- Retired with it: the checked-in `schemas/aivi.schema.json`,
  `scripts/schema.mjs`, the `schema:check` step in `npm run check`, and the
  AGENTS.md sentence "run `npm run schema` after changing a zod config schema".
  Verified consumers (2026-09-27): only the `check` script chain. Tests assert
  each plugin exports a schema and that composition round-trips.

## Follow-ups

- **Knowledge as an optional plugin.** The machinery already exists and
  already hardcodes nothing: modules claim tool *descriptors* on the
  `ToolRegistry` at `start` (claimed exactly once, second claimant fatal —
  [tools.ts](../../../packages/host/src/tools.ts)), `GET /tools` serves and
  `POST /tools` dispatches, and the OpenCode plugin "registers exactly what
  the list says at its load"
  ([opencode/src/index.ts:82-98](../../../packages/opencode/src/index.ts)) —
  no aivi tool is hardcoded there. So the move is: knowledge module claims
  its tools and jobs, `@aivi/knowledge` joins the list, `serve`'s loop imports
  it like any other. Mid-process re-registration stays out (prompt-cache rule;
  recovery is an OpenCode reload).
- The `dashboard` and `editor-mode` backlog pages sit downstream of this
  registry; neither blocks it.

## Checklist

- [ ] `aivi-plugins` read + validation (array, string-or-tuple entries) from
      `<home>/app/package.json`; boot order: manifest → compose → parse.
- [ ] Move the three config schemas into their plugins as `plugin.configSchema`;
      compose with the core envelope; both error directions produce the new
      messages.
- [ ] `serve`: delete the hardcoded if-chain; loop the list.
- [ ] `state/cache/schema.json` generation on setup/install/uninstall/upgrade;
      `$schema` line written into `config.json`.
- [ ] Delete `schemas/`, `scripts/schema.mjs`, the `schema:check` script and
      its `check` step; update AGENTS.md and configuration docs in the same
      commit.
- [ ] `aivi install`/`uninstall` write/remove all three facts; lifecycle tests
      at the manifest and config boundaries.
- [ ] Docs: [configuration.md](../../configuration.md) (enablement, cache
      file), [CONTEXT.md](../../../CONTEXT.md) (amended decision line, plans
      row), [operations.md](../../operations.md) (plugins section).
- [ ] Changesets (fixed group).
