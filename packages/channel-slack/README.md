# @aivi/channel-slack

Slack channel module: Socket Mode, DM/thread routing, sending, manifest
slash commands, and report threads. It implements the host's
`ChannelModule` contract; the host owns the inbox, bindings, engine, and
turn runner.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/channel-slack` | `createSlackModule`, `openSlackStore`, `slackManifest` |
| `./config` | the `plugin` declaration: module id, config schema, Slack id shapes |
| `./setup` | the setup guide `aivi add slack` runs |
| `./cli` | the `aivi slack` command |

## Enable it

The short way is `aivi add slack`: it prints how to create the Slack
app, asks for the tokens, verifies each, writes `config.json` and `.env`
itself, and aivi comes back with the module running.

By hand: list `@aivi/channel-slack` in `aivi-plugins` in
`app/package.json` — the list is what enables a module, the block is only
its setup — and write a validated `plugins.channel-slack` block in
`config.json`. Put `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env`. Create
the Slack app from the manifest (`aivi slack manifest`).

The module id is `channel-slack`, the package's short name; the *platform*
id stays `slack` and is what keys the database tables and session ids,
because renaming a prefix would orphan every conversation already bound
to it.

## Dependencies

`@slack/socket-mode` and `@slack/web-api`; `@aivi/host` as a peer.

## Docs

[slack](../../docs/slack.md) ·
[channels](../../docs/channels.md)
