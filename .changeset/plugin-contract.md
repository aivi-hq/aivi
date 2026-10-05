---
'@aivi/core': minor
'@aivi/tracker-linear': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/browser': minor
---

The plugin contract is a kit. `@aivi/plugin` carries the setup, CLI and module contracts and the `./api` client, and plugins are plain commander subtrees built by `(ctx) => Command` factories — one command mechanism for the server's own commands and the plugins' alike. A plugin's main entry is `{ moduleId, configSchema, createModule }` with `./cli` and `./setup` subpaths, and its `./config` declares its module id and config shape: core stopped knowing plugin names, and the host composes the closed `config.json` schema from the listed packages at load. The `ask` wrappers are gone — a plugin's command receives the prompt rule as part of its context, and two clacks animating one terminal can no longer mangle each other. `@aivi/linear` is now `@aivi/tracker-linear` (the `linear` alias in `aivi add` is unchanged).
