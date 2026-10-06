# @aivi/plugin

This is the package you import to write an aivi plugin — not the package
`aivi install` installs. A plugin is a plain npm package that exports a
module the host composes, a `./setup` entry `aivi install` runs, and a
`./cli` entry whose commands join `aivi --help`. The kit holds every
contract a plugin author needs and nothing more; the host stays the
runtime that implements them. The seam words — tracker, forge adapter,
platform adapter, project contributor — are defined in
[docs/vocabulary.md](docs/vocabulary.md).

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/plugin` | the contracts: `PluginSetupContext`/`PluginSetupResult`/`PluginSetupCancelled` (the install-time subpath), `PluginCliContext` and `resolveBlocked` (the runtime one), and the module contract under its authoring names (`AiviModule`, `AiviServices`) |
| `@aivi/plugin/api` | `createHostClient` — the fetch-only HTTP client for the aivi server, the one piece of runtime code a guest in someone else's process (the OpenCode plugin) may carry |
| `@aivi/plugin/channel` | the channel kind's vocabulary: `ChannelModule` and the conversation-binding types — types only; the shared inbox, engine and turn runner are the host's |

Rules the kit keeps:

- The kit depends on `@aivi/core` only — never on `@aivi/host` at runtime.
  Where a contract names a runtime type (`Store`, `ConversationStore`), the
  import is type-only: the host implements the bag, plugins receive it typed.
- Prompts: the runner hands over its own `@clack/prompts` module instance
  (`ctx.prompts`); whoever is called owns the screen. There are no `ask.*`
  wrappers — two clacks animating one terminal mangle each other.
- A plugin kind gets a subpath (`./channel`, later `./tracker`); it is
  promoted to its own package only if the kind ever needs runtime-shared
  code.
