# One application, contained modules

Run **`aivi serve`**. It starts the HTTP API, scheduler, knowledge service, and
configured modules together. Discord is a package boundary, not a deployment
boundary. A future Linear module will receive webhooks through the same host
listener and use the same services.

| Component | Owns |
| --- | --- |
| `@aivi/app` | Command entry point and explicit module composition |
| `@aivi/host` | Application lifecycle, API, queue, leases, scheduler, native client |
| `@aivi/knowledge` | One QMD SDK store, source collections, indexing, search queue |
| `@aivi/browser` | Lazy Chrome DevTools MCP child and session tab ownership |
| `@aivi/discord` | Discord connection/events, channel mappings, conversation policy |
| `@aivi/opencode` | Native tools that call the host API |
| OpenCode | Agent execution, native sessions, permissions, providers, tools |

Modules receive a `HostServices` object containing the loaded installation
config, store, knowledge service, optional browser service, a lazy `opencode()`
client factory, a structured logger, the shutdown signal, and `fail()`. They
return an asynchronous `stop` function. They call shared services directly,
rather than calling the host over HTTP from inside the same application.

`fail()` aborts the whole host and is reserved for conditions the host cannot
run without (an unreliable store). Transient adapter trouble, such as a Discord
gateway error, is logged and left to the adapter's own reconnect logic: an
optional module must never take the knowledge server and scheduler down.

Adapters keep their own tables in the host database under a name prefix and
declare them through `Store.migrate(namespace, steps)`, which versions them
independently of the host schema. Host tables are only reached through `Store`
methods; shared capacity uses `acquireLease`/`releaseLease`/`blockLease`.

OpenCode plugins live inside the native runtime, so they use the host's
authenticated API. `knowledge.search` reaches the same service used by Discord's
`/search` command and scheduled indexing jobs. A future permission-checked Discord
job command can similarly use host job operations.

Startup validates the auth mode and token first (so a missing `AIVI_TOKEN`
never launches QMD or Chrome), acquires installation ownership, initializes
shared services, refreshes the search index when configured, opens the API on
`host.bind:host.port`, then starts modules. Only after configured modules start
does it announce readiness and dispatch scheduled work. Startup failure unwinds
already-started modules. `aivi tick` runs the same lifecycle in one-shot mode:
no API, no modules, one dispatch round, drain, exit.

Shutdown stops dispatch, signals modules, drains them in reverse startup order,
drains scheduled work and HTTP requests, closes browser/MCP and QMD, and releases ownership.
Interrupted native work retains its blocked state and capacity; shutdown never
pretends it cleaned up external effects.

OpenCode runs as its own background service; aivi discovers it through the SDK's
service registration and connects on first use rather than managing its
installation or startup. QMD uses its
library API inside aivi, with no QMD server or separate launch command. Only the
configured Discord module loads discord.js, and only enabled search loads QMD.

```json
{
  "version": 1,
  "modules": { "discord": { "config": "discord.json" } },
  "search": { "provider": "qmd", "indexOnStart": true }
}
```

This is ordinary TypeScript composition: no NestJS, decorators, service locator,
or new general-purpose plugin framework.

Browser configuration belongs to the same host. A configured browser service is
created after installation ownership is acquired. Its MCP/Chrome processes start
on first use and stop with the host; there is no separate browser server command.
See [browser setup](browser.md).
