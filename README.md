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

For Discord, fill in `examples/discord.json`, put `DISCORD_BOT_TOKEN` in a `.env` next to the config, use
`examples/aivi-discord.json`, register commands once with `aivi ... discord register`,
and run the same `serve` command. See [Discord setup](docs/discord.md).

## Packages

| Package | Responsibility |
| --- | --- |
| `@aivi/app` | `aivi` CLI; composes configured modules and launches the host |
| `@aivi/core` | Config schemas, source scopes, contracts, logger |
| `@aivi/host` | Lifecycle, API, scheduler, SQLite store, capacity leases, OpenCode connection |
| `@aivi/knowledge` | QMD-backed document indexing and scoped keyword search |
| `@aivi/browser` | Chrome DevTools MCP, persistent profile, session-owned tabs |
| `@aivi/discord` | Discord module: DM/thread routing, durable inbox, librarian chat |
| `@aivi/opencode` | OpenCode plugin: `knowledge_search`, `aivi_sources`, `aivi_status`, `browser_control` |

Modules and jobs call shared services in-process. The plugin reaches the same
services over the authenticated host API. Linear will be another in-process
module with webhook routes on the same listener.

## Status

Working and verified against OpenCode 2.0.3 on the target Mac:

- Configuration with core and per-project knowledge sources; scope never widens on unknown IDs.
- Host API with `host.bind`/`host.port` and auth modes `token` and `none`; public `/health`.
- OpenCode discovery through the SDK service registration (random port, basic auth).
- Plugin loads in OpenCode v2 and its tools reach the host; librarian round trip with Gemini Flash.
- Session driver: scheduled `opencode.prompt` jobs run an agent turn to a verified answer, auto-handling permission prompts; Discord turns use the same driver.
- Discord live: DMs and channels with a shared access policy (allow-lists, mention rules, thread-per-conversation), typing indicator, slash commands, job reports to allowed channels.
- Jobs: `shell` tasks, `report` destinations, `.env` secrets (`~/.aivi/.env`).
- Dreaming: a scheduled agent reviews conversations since the last run and maintains `facts.md` plus rule/skill proposals inside a knowledge source ([docs/dreaming.md](docs/dreaming.md)).
- SQLite + Croner scheduling with dedupe, concurrency limits, restart recovery, adapter migrations.
- QMD document indexing and scoped keyword search.
- Browser control service and Discord module (built and unit-tested; live verification still open).

Not yet built, in order of intent:

1. Knowledge `kind` labels (doc, decision, memory, conversation) and people.
2. Installation and updates for other machines (`docs/backlog/installation.md`).
3. Remote access hardening (per-device tokens, SSO via reverse proxy), Linear
   with worker steering/cleanup.
4. Open design tickets in `docs/backlog/`: jobs, chat commands, identity linking.

`npm run check` builds, type-checks tests, runs the test suite (real SQLite,
real QMD, real v2 client against a mock server), verifies generated schemas, and
smoke-tests the CLI and daemon. Live checks: `npm run live:opencode`,
`npm run smoke:browser`.

Read [configuration](docs/configuration.md), [application lifecycle](docs/application.md),
[knowledge search](docs/knowledge.md), [dreaming](docs/dreaming.md),
[OpenCode integration](docs/opencode.md), [Discord](docs/discord.md), and
[architecture decisions](docs/architecture.md). Requirements and roadmap are
in `docs/`; `docs/backlog/` holds ideas not yet scheduled.
