# @aivi/channel-discord

Discord channel module: gateway, DM/thread routing, sending, slash
commands, and report threads. It implements the host's `ChannelModule`
contract; the host owns the inbox, bindings, engine, and turn runner.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/channel-discord` | `createDiscordModule` — the module a running server composes |
| `./config` | the `plugin` declaration: module id and config schema |
| `./setup` | the setup guide `aivi add discord` runs |
| `./cli` | the `aivi discord` command |

## Enable it

The short way is `aivi add discord`: it prints how to create the
Discord app, asks for the tokens, verifies each, writes `config.json` and
`.env` itself, and aivi comes back with the module running.

By hand: list `@aivi/channel-discord` in `aivi-plugins` in
`app/package.json` — the list is what enables a module, the block is only
its setup — and write a validated `plugins.channel-discord` block in
`config.json`. Put `DISCORD_BOT_TOKEN` in `.env`. Slash commands are
registered at start.

The module id is `channel-discord`, the package's short name; the *platform*
id stays `discord` and is what keys the database tables and session ids,
because renaming a prefix would orphan every conversation already bound
to it.

## Dependencies

`discord.js` for the gateway; `@aivi/host` as a peer (the host runs it
in-process).

## Docs

[discord](../../docs/discord.md) ·
[channels](../../docs/channels.md)
