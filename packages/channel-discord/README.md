# @aivi/channel-discord

Discord channel module: gateway, DM/thread routing, sending, slash
commands, and report threads. It implements the host's `ChannelModule`
contract; the host owns the inbox, bindings, engine, and turn runner.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/channel-discord` | `createDiscordModule` — the `HostModule` a running server composes |
| `@aivi/channel-discord/setup` | self-configuration entry used by `aivi install discord` |

## Enable it

The short way is `aivi install discord`: it prints how to create the
Discord app, asks for the tokens, verifies each, writes `config.json` and
`.env` itself, and aivi comes back with the module running.

By hand: presence of a validated `modules.discord` block in `config.json`
enables the module; `false` is an explicit off. Put `DISCORD_BOT_TOKEN` in
`.env`. Slash commands are registered at start.

## Dependencies

`discord.js` for the gateway; `@aivi/host` as a peer (the host runs it
in-process).

## Docs

[discord](../../docs/discord.md) ·
[channels](../../docs/channels.md)
