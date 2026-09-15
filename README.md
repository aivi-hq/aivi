# aivi

An always-on teammate built around OpenCode v2. OpenCode stays the runtime for
agents, sessions, providers, tools, skills, and permissions. aivi adds what a
team needs around it: a shared knowledge server, scheduled work, and channels
such as Discord, all started by one **`aivi serve`**. Ordinary OpenCode
installs reach the knowledge server through a small native plugin.

## Try it

Use Node 26 and npm. From the monorepo root:

```sh
npm ci
npm run check
npm run aivi -- --config examples/aivi.json config check
```

Start the host. Either have fnox inject an `AIVI_TOKEN` of at least 24
characters, or set `host.auth.mode` to `"none"` for a trusted machine:

```sh
npm run aivi -- --config examples/aivi.json serve
```

The example indexes bundled documents and runs scheduled maintenance. It needs
no inference model. In another terminal:

```sh
npm run aivi -- --config examples/aivi.json knowledge search "decisions" --project demo
npm run aivi -- --config examples/aivi.json jobs list
```

To use the tools from OpenCode, open `examples/librarian` in OpenCode v2 with
`opencode service` running; see [OpenCode integration](docs/opencode.md). With a
running service, `npm run live:opencode -- --plugin "$PWD/examples/librarian"`
verifies the real boundary.

For Discord, fill in `examples/discord.json`, put `DISCORD_BOT_TOKEN` in a
`.env` beside the config (see [secrets](docs/configuration.md#secrets)), use
`examples/aivi-discord.json`, register commands once with `aivi ... discord register`,
and run the same `serve` command. See [Discord setup](docs/discord.md).

## Packages

| Package | Responsibility |
| --- | --- |
| `@aivi/app` | `aivi` CLI; composes configured modules and launches the host |
| `@aivi/core` | Config and access-policy schemas, knowledge kinds, contracts, logger |
| `@aivi/host` | Lifecycle, API, scheduler, SQLite store, capacity leases, OpenCode connection, session driver, dreaming, report destinations |
| `@aivi/knowledge` | QMD-backed document indexing and scoped keyword search |
| `@aivi/browser` | Chrome DevTools MCP, persistent profile, session-owned tabs |
| `@aivi/discord` | Discord module: DM/thread routing, durable inbox, librarian chat, slash commands, report destination |
| `@aivi/opencode` | OpenCode plugin: `knowledge_search`, `aivi_sources`, `aivi_status`, `browser_control` |

Modules and jobs call shared services in-process. The plugin reaches the same
services over the authenticated host API. Linear will be another in-process
module with webhook routes on the same listener.

## Status

- Live-verified against OpenCode 2.0.3 and a Discord test server on the target
  Mac: discovery and auth, plugin tools, the session driver (jobs, dreaming,
  Discord turns all end in a verified final answer), Discord DMs/channels/
  threads with slash commands and job reports.
- Built and unit-tested, live check still open: browser control
  (`npm run smoke:browser`).
- Knowledge: core and per-project sources with kinds (`doc`, `decision`,
  `memory`, `conversation`); scope never widens on unknown IDs.
- Jobs: SQLite + Croner schedules, `shell`/`opencode.prompt`/`dreaming`/
  maintenance tasks, dedupe, pools and leases, restart recovery, reports.
- Dreaming: a scheduled agent maintains `facts.md` and proposals from
  conversations since its last run ([docs/dreaming.md](docs/dreaming.md)).

Next, in order: jobs from chat and one-off runs, projects as capacity pools
with quiet-time maintenance, project-scoped memory, installation on other
machines, Linear. Details and milestone status: [docs/roadmap.md](docs/roadmap.md);
unscheduled ideas: `docs/backlog/`.

`npm run agentic:verify` runs Biome and `npm run check` (build, tests against
real SQLite, real QMD and the real v2 client on a mock server, schema check,
CLI and daemon smoke). Live gates: `npm run live:opencode`, `npm run smoke:browser`.

New here? Start with [CONTEXT.md](CONTEXT.md). Then [configuration](docs/configuration.md),
[application lifecycle](docs/application.md), [knowledge search](docs/knowledge.md),
[dreaming](docs/dreaming.md), [OpenCode integration](docs/opencode.md),
[Discord](docs/discord.md), [architecture decisions](docs/architecture.md),
and [roadmap](docs/roadmap.md).
