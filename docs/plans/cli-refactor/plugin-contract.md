# 2 · The plugin contract

Status: landed (2026-09-28, `refactor/single-cli-command`). Depends on:
[one-cli.md](one-cli.md) (landed). Unlocks:
[plugin-registry.md](plugin-registry.md).
Goal: one command mechanism everywhere — plugins export plain **commander**
subtrees — and one kit package, `@aivi/plugin`, that every plugin author
imports instead of the host runtime.

## The kit

What a plugin author imports, and nothing more. Contents are **moved code**,
not new:

| Export | Moves from | Contains |
| --- | --- | --- |
| `@aivi/plugin` | `core/src/plugin.ts` + `host/src/plugin-cli.ts` | `PluginSetupContext`/`PluginSetupResult`/`PluginSetupCancelled`, `PluginCliContext`, the module contract `AiviModule` (from `host`'s `HostModule`), the services-bag interface, `resolveBlocked` |
| `@aivi/plugin/api` | `host/src/client.ts` | `createHostClient` — the HTTP client for the aivi server. `api`, not `client`: "client" now means the operator's laptop |
| `@aivi/plugin/channel` | `host/src/channel/*` (types only) | `ChannelModule` and conversation-binding types |
| `@aivi/plugin/tracker` | — | when the first tracker beyond Linear exists |

Rules:

- `@aivi/plugin` depends on `@aivi/core` only — never on `@aivi/host`. Where a
  contract names runtime types (`Store`, `ConversationStore`), the import is
  **type-only**; the host implements the bag, plugins receive it typed. The bad
  edge this phase deletes is *runtime*: all three channel packages import
  `resolveBlocked` from `@aivi/host` (`channel-discord/src/cli.ts:6` and
  friends) — the whole runtime package pulled in to declare a CLI command.
- The name's one ambiguity (a "plugin" is also what `aivi install browser`
  installs) is documented in one line in the package README: *this is the
  package you import to write an aivi plugin.*
- Subpath before package: a plugin kind gets a subpath; it is promoted to its
  own package only if the kind ever needs runtime-shared code.
- **Every rename and subpath in this document lands with this phase** — no
  intermediate state where plugins still import contracts from `@aivi/host`.
  Only `./tracker` waits for its kind to exist.

## The command contract: `(ctx) => Command`

A plugin's `./cli` subpath exports one factory that builds its own commander
subtree. Before (`channel-slack/src/cli.ts` — a data object our shape
constrains, mounted through host plumbing):

```ts
const slack: PluginCliCommand = {
  name: 'slack',
  subcommands: [{ name: 'resolve <id>', run: async (ctx, args, options) => … }],
};
```

After:

```ts
import { Command } from 'commander';
export const slack = (ctx: PluginCliContext): Command => {
  const slack = new Command('slack').description('…');
  slack.command('resolve <id>').option('--reason <text>', '…').action(…);
  return slack;
};
```

The mount is `program.addCommand(await slack(ctx))` — the same call the CLI
uses for host commands ([one-cli.md](one-cli.md)). Plugins declare `commander`
themselves (the root pins the family version). Full commander expressiveness
(choices, conflicts, variadics) comes free; `PluginCliCommand`,
`PluginCliSubcommand`, the `run(ctx, args, options)` relay, and the mounting
translation in `app/src/commands/channels.ts` are deleted.

`ctx` stays: it is the irreducible part — the plugin cannot know the home, the
store door, or the poke.

## Prompts: the module rule, no wrappers

The setup contract already dropped the `ask.*` wrappers: the context hands over
the raw `prompts` module — *"the very `@clack/prompts` module the runner renders
with … two clacks animating one terminal mangle each other (measured
2026-09-27)"* (`core/src/plugin.ts:26`). This phase applies the same rule to
`PluginCliContext`: its leftover `ask: { text … }` (`host/src/plugin-cli.ts:65`)
dies; the CLI ctx hands over `prompts` too. One rule across both contracts:
**the runner hands its own module instance; whoever is called owns the screen.**

## The descriptor (set up for phase 3)

A plugin's **main entry** exports what the runtime composition needs — and
only that, so `serve` never even loads commander:

```ts
// packages/channel-discord/src/index.ts
export const plugin: AiviPlugin = {
  moduleId: 'discord',
  configSchema: discordConfigSchema, // arrives with the plugin (phase 3)
  createModule: createDiscordModule,
};
```

`./cli` and `./setup` stay separate exports: separate module graphs mean the
host process never imports CLI code, and the CLI process never imports module
code.

## Renames

- `@aivi/linear` → **`@aivi/tracker-linear`**: the naming rule is
  `@aivi/<kind>-<name>`, and `@aivi/github` (the day a GitHub tracker lands)
  must not be ambiguous between "repo hub/source" and "issue tracker".
  Kind prefixes then read: `channel-discord`, `channel-slack`, `tracker-linear`,
  future `tracker-github`.
- Cheapest moment is now: pre-1.0, few installs, and these packages are opened
  anyway. Changesets under the fixed group.
- **The module id is the package's short name** (ruled 2026-09-30, as the forge
  landed): `plugins.tracker-linear`, `plugins.forge-github` — the same word as
  the npm name after the scope, and the same word `/status` and the log category
  use. Linear's id moved to `tracker-linear` that day; there was no installed
  config to break. Not module ids, and so not renamed, are the **platform**'s
  short names: the SQLite prefix and session-id prefixes (`linear_turns`,
  `ses_linear_…`), the webhook URL Linear's dashboard holds, the `aivi linear`
  command. **The operator ruled the same for the channels** (2026-09-30, the
  day after): `@aivi/channel-discord` and `@aivi/channel-slack` key their
  blocks `plugins.channel-discord` and `plugins.channel-slack` too, and the
  rule now holds for every plugin that can be installed; their **platform**
  ids stay `discord` and `slack`, which is what keys the database.

## Core loses its last CLI face

`@aivi/core` drops the `@clack/prompts` dependency (its only use was
`import type` for the old contract) and keeps zero knowledge of terminals.
Core's one-line job after this phase: config envelope, shared types, logging,
output — needs nothing, knows no plugin.

`@aivi/opencode` (the OpenCode-side plugin) switches its import from
`@aivi/host/client` to `@aivi/plugin/api`. No behavior change: tools still
come from `GET /tools` at load
([plugin-registry.md](plugin-registry.md#follow-ups) keeps the story).

## Landing (2026-09-28)

Landed as described, with four deviations:

- **The module contract's declaration stays in the host.** The kit type-imports
  `Store` and `ConversationStore` from `@aivi/host`, so the host engine cannot
  reference the kit without a project-reference cycle (TS6202 — the same trap
  half 2 of [one-cli.md](one-cli.md) split around). The engine declares and
  renames in place (`HostServices`→`AiviServices`, `HostModule`→`AiviModule`
  in `packages/host/src/application.ts`) and the kit exports those names to
  plugin authors; plugins' type imports come only from the kit, so the
  authoring face is exactly what this document describes.
  `ConfigurationError` stays in the host: module entries import it at runtime
  from the process that hosts them. The type-only reference the kit keeps to
  the host is what forces this; deleting it is scheduled as
  [store-package](../../backlog/store-package.md) right after the refactor.
- **`PluginSetupContext` gained a `withStore` door.** The deletion ledger wants
  no plugin→host runtime imports, and `linear/src/setup.ts` built
  `new Store(...)` from `@aivi/host` to read the request diary during the
  webhook test. The runner (host's `cli/plugin-setup.ts`) supplies the door
  from the same store bracket the CLI context uses; the flow receives the
  store typed.
- **`createHostClient` now names the kit's version.** The version moved with
  the code: `x-aivi-client` is `@aivi/plugin`'s own `package.json` version,
  read at runtime. The gate serves a client at or behind the host, and
  `@aivi/plugin` joined the changesets `fixed` group so releases keep the
  sides of the wire equal.
- **An empty Enter at the Slack manifest prompt ends the command** (exit 1).
  The old `ask.text` wrapper turned an empty Enter into the string
  `'undefined'` — an answer nobody typed; the branch that prompt's own
  `answered === undefined` documented "no answer", and the new action says
  exactly that.

The kit's one devDependency is `commander` (its contract test builds a
subtree); its runtime dependencies stay `@aivi/core` only.

## Checklist

- [x] Create `packages/plugin` (`@aivi/plugin`): move contracts out of
      `core/src/plugin.ts` and `host/src/plugin-cli.ts` (incl. `resolveBlocked`,
      which reaches the store only through `ctx.withStore`); add `./api`
      (move `host/src/client.ts`; host keeps the server-side gate/routes).
- [x] `PluginCliContext` gains `prompts` (the module), loses `ask`; update
      plugin call sites to own their screens.
- [x] Each plugin: `./cli` becomes `(ctx) => Command`; delete the data-object
      relay in all three channel packages; declare `commander`.
- [x] Module contract types (`HostModule` → `AiviModule`, services bag) move to
      the kit; host implements; plugin imports are type-only.
      (Declaration stays in the host — see Landing.)
- [x] Rename `@aivi/linear` → `@aivi/tracker-linear` (workspace, config
      references, docs).
- [x] Core: remove `@clack/prompts`; `@aivi/opencode` imports `@aivi/plugin/api`.
- [x] Docs same commits: [channels.md](../../channels.md) (module contract),
      [opencode.md](../../opencode.md) (plugin loading),
      [linear.md](../../linear.md), [CONTEXT.md](../../../CONTEXT.md)
      (packages, vocabulary).
- [x] Changesets for every package under `packages/` touched (fixed group).
      Landed 2026-09-28 in `53e55f4`: `.changeset/plugin-contract.md`
      (core minor, `@aivi/tracker-linear` minor, the three plugins minor);
      the `fixed` group carried `@aivi/plugin` along at the group's 0.9.0.
