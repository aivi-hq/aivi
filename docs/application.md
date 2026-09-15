# One application, contained modules

Run **`aivi serve`**. It starts the HTTP API, scheduler, knowledge service, and
configured modules together. Discord is a package boundary, not a deployment
boundary. A future Linear module will receive webhooks through the same host
listener and use the same services.

The package table is in the [README](../README.md#packages).

Modules receive a `HostServices` object containing the loaded installation
config, store, knowledge service, optional browser service, an `opencode()`
client factory, a structured logger, the shutdown signal, a `destinations`
registry for `report.to`, and `fail()`. They
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
authenticated API. `knowledge_search` reaches the same service used by Discord's
`/search` command and scheduled indexing jobs. A future permission-checked Discord
job command can similarly use host job operations.

Startup validates the auth mode and token first (so a missing `AIVI_TOKEN`
never launches QMD or Chrome), acquires installation ownership, initializes
shared services, refreshes the search index when configured, opens the API on
`host.bind:host.port`, then starts modules. Only after configured modules start
does it announce readiness and dispatch scheduled work. Startup failure unwinds
already-started modules. `aivi tick` runs the same lifecycle in one-shot mode:
no API, no modules (and no token needed), one dispatch round, drain, exit.

Shutdown stops dispatch and aborts running jobs at once: a shell command gets
`SIGTERM`, an agent turn stops waiting. Each interrupted job ends `blocked` with
the reason "Host stopped …" and keeps its capacity, because aivi cannot know
what the external side had already done; `aivi jobs resolve` releases it after a
look. Modules are then stopped in reverse startup order, the aborted jobs are
awaited so their outcomes are recorded and reported, HTTP requests finish, the
browser/MCP and QMD close, and ownership is released. A grace period that lets
work finish first is a design choice not yet made
([shutdown-hooks](backlog/shutdown-hooks.md)).

Job outcomes distinguish "nothing happened" from "unknown": OpenCode not
reachable or a command that cannot start ends `failed`, and the next occurrence
simply tries again; anything after the first request or after the process
started ends `blocked` when it cannot be verified.

OpenCode runs as its own background service; aivi discovers it through the SDK's
service registration at the start of each job or conversation turn (one file
read), so an `opencode service restart` is picked up by the next turn. aivi never
manages OpenCode's installation or startup. QMD uses its
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
