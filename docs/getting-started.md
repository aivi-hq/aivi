# Getting started

From a fresh clone to a librarian answering questions, in this repository's
example home. Installation on another machine is not there yet
([installation](backlog/installation.md)).

## Run it

Use Node 26 and npm. From the repository root:

```sh
npm ci
npm run check
npm run aivi -- config check
```

There is no build step: every package runs from its TypeScript sources through
Node's type stripping, and `npm run typecheck` (`tsc --noEmit`) is a check.

aivi reads one **home** directory: `aivi.json`, `.env`, `projects/`, `memory/`
and `state/` together. Installed copies use `~/.aivi`; in this repo `npm run
aivi` points `AIVI_HOME` at `example/`, a complete home with everything enabled.
Its [README](../example/README.md) lists what is in there, including how to
provide or disable Discord and Slack.

Start the host. Either have fnox inject an `AIVI_TOKEN` of at least 24
characters, or set `host.auth.mode` to `"none"` for a trusted machine:

```sh
npm run aivi -- serve
```

The example indexes bundled documents and runs scheduled maintenance. It needs
no inference model. In another terminal:

```sh
npm run aivi -- knowledge search "decisions"
npm run aivi -- knowledge search "decisions" --project demo --no-core
npm run aivi -- knowledge search "agreements" --core-only
npm run aivi -- projects list
npm run aivi -- jobs list
npm run aivi -- runs list
```

The CLI sends searches to the running host; it does not open another index.

## The librarian in OpenCode

1. With `host.auth.mode: "token"`, export the same `AIVI_TOKEN` in the OpenCode
   **server** environment and `opencode service restart`; with
   `opencode.lifecycle: "own"` (the default) `aivi serve` does both for you.
   Whatever started the service, restart it after every change to the plugin
   or the host client: the long-running service keeps `@aivi/host/client` in
   its module cache, so a plugin that registers a new tool can still call a
   client without that method ("client.jobs is not a function", seen
   2026-09-15). The example home uses `discover`, so there `opencode service
   restart` stays manual.
2. Open `example/` in OpenCode v2. Its `opencode.jsonc` loads the local plugin
   and selects the `librarian` agent from `.opencode/agents/`.
3. Ask it to list the projects and read the company handbook.

The example agent denies shell, edits, and subagent launches; everything else
is OpenCode's default. The home is the OpenCode location, so the example's
knowledge, memory and project directories are inside it and need no
`external_directory` rules. Sources elsewhere get those rules from aivi per
session ([opencode](opencode.md)). With a running service,
`npm run live:opencode -- --plugin "$PWD/example"` verifies the real boundary.

## A project

```sh
npm run aivi -- projects add https://github.com/acme/website.git
```

That clones into `example/projects/website/source`; restart `serve` and its `docs/`
is searchable with `--project website`. What a project is and how it is
described: [projects](projects.md).

## A chat channel

For Discord, fill in the IDs in `example/discord.json`, put `DISCORD_BOT_TOKEN`
in `example/.env`, and run `serve` as above (slash commands are registered
at start) ([Discord setup](discord.md#setup)). For Slack,
create the app from the manifest in [Slack setup](slack.md#setup), fill in
`example/slack.json`, and put `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in
`example/.env`.

## Then

Running it for real: [operations](operations.md). Every field: [configuration](configuration.md).
