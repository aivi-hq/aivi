# aivi

An always-on teammate built around OpenCode v2. OpenCode stays the runtime for
agents, sessions, providers, tools, skills, and permissions. aivi adds what a
team needs around it: a shared knowledge server, scheduled work, and channels
such as Discord and Slack, all started by one **`aivi serve`**. Ordinary OpenCode
installs reach the knowledge server through a small native plugin.

## Try it

Use Node 26 and npm. From the monorepo root:

```sh
npm ci
npm run check
npm run aivi -- config check
```

There is no build step: every package runs from its TypeScript sources through
Node's type stripping, and `npm run typecheck` (`tsc --noEmit`) is a check.

aivi reads one **home** directory: `aivi.json`, `.env`, and `state/` together.
Installed copies use `~/.aivi`; in this repo `npm run aivi` points `AIVI_HOME`
at `example/`, a complete home with everything enabled. Its
[README](example/README.md) has the quickstart, including how to provide or
disable Discord.

Start the host. Either have fnox inject an `AIVI_TOKEN` of at least 24
characters, or set `host.auth.mode` to `"none"` for a trusted machine:

```sh
npm run aivi -- serve
```

The example indexes bundled documents and runs scheduled maintenance. It needs
no inference model. In another terminal:

```sh
npm run aivi -- knowledge search "decisions" --project demo
npm run aivi -- jobs list
npm run aivi -- runs list
```

To use the tools from OpenCode, open `example/` in OpenCode v2 with
`opencode service` running; see [OpenCode integration](docs/opencode.md). With a
running service, `npm run live:opencode -- --plugin "$PWD/example"`
verifies the real boundary.

For Discord, fill in the IDs in `example/discord.json`, put `DISCORD_BOT_TOKEN`
in `example/.env`, register commands once with `npm run aivi -- discord register`,
and run `serve` as above. See [Discord setup](docs/discord.md). For Slack,
create the app from the manifest in [Slack setup](docs/slack.md), fill in
`example/slack.json`, and put `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in
`example/.env`.

## Packages

| Package | Responsibility |
| --- | --- |
| `@aivi/app` | `aivi` CLI; composes configured modules and launches the host |
| `@aivi/core` | Config and access-policy schemas, knowledge kinds, contracts, logger |
| `@aivi/host` | Lifecycle, API, scheduler, SQLite store, capacity leases, OpenCode connection, session driver, dreaming, the channel module contract with the shared inbox, engine and turn runner, report routing |
| `@aivi/knowledge` | QMD-backed document indexing and scoped keyword search |
| `@aivi/browser` | Chrome DevTools MCP, persistent profile, session-owned tabs |
| `@aivi/channel-discord` | Discord channel module: gateway, DM/thread routing, sending, slash commands, report threads |
| `@aivi/channel-slack` | Slack channel module: Socket Mode, DM/thread routing, sending, manifest slash commands, report threads |
| `@aivi/opencode` | OpenCode plugin: `knowledge_search`, `knowledge_projects`, `aivi_sources`, `aivi_status`, `aivi_jobs`, `aivi_browser` |

Modules and jobs call shared services in-process. The plugin reaches the same
services over the authenticated host API. Linear will be another in-process
module with webhook routes on the same listener.

## Status

- Live-verified against OpenCode 2.0.3 and a Discord test server on the target
  Mac: discovery and auth, plugin tools, the session driver (jobs, dreaming,
  Discord turns all end in a verified final answer), Discord DMs/channels/
  threads with slash commands and job reports.
- Browser control: live-verified against headless Chrome on the target Mac
  (`npm run smoke:browser`); login takeover and extensions still to exercise.
- Knowledge: core and per-project sources with kinds (`doc`, `decision`,
  `memory`, `conversation`); scope never widens on unknown IDs. Projects are
  clean checkouts under `<home>/projects/`, described from the home by a
  `docs/` convention ([docs/projects.md](docs/projects.md)).
- Jobs: definitions (cron or one-off `at`) and their runs in SQLite, Croner
  as the calendar, `shell`/`opencode.prompt`/`dreaming`/maintenance tasks,
  dedupe, pools and leases, restart recovery, missed-run accounting,
  retention, reports.
- Dreaming: a scheduled agent maintains `facts.md` and proposals from
  conversations since its last run ([docs/dreaming.md](docs/dreaming.md)).

Next, in order: next channels, installation on other machines, Linear (with
per-project locks and quiet-time maintenance). Details and milestone status: [docs/roadmap.md](docs/roadmap.md);
unscheduled ideas: `docs/backlog/`.

`npm run agentic:verify` runs Biome and `npm run check` (build, tests against
real SQLite, real QMD and the real v2 client on a mock server, schema check,
CLI and daemon smoke). Live gates: `npm run live:opencode`, `npm run smoke:browser`.

New here? Start with [CONTEXT.md](CONTEXT.md). Then [configuration](docs/configuration.md),
[application lifecycle](docs/application.md), [knowledge search](docs/knowledge.md),
[dreaming](docs/dreaming.md), [OpenCode integration](docs/opencode.md),
[channel modules](docs/channels.md), [Discord](docs/discord.md),
[Slack](docs/slack.md), [architecture decisions](docs/architecture.md),
and [roadmap](docs/roadmap.md).
