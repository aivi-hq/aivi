# @aivi/channel-slack

Slack channel module: Socket Mode, DM/thread routing, sending, manifest
slash commands, and report threads. It implements the host's
`ChannelModule` contract; the host owns the inbox, bindings, engine, and
turn runner.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/channel-slack` | `createSlackModule`, `openSlackStore`, `slackManifest` |
| `@aivi/channel-slack/setup` | self-configuration entry used by `aivi install slack` |

## Enable it

The short way is `aivi install slack`: it prints how to create the Slack
app, asks for the tokens, verifies each, writes `config.json` and `.env`
itself, and aivi comes back with the module running.

By hand: presence of a validated `modules.slack` block in `config.json`
enables the module; `false` is an explicit off. Put `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` in `.env`. Create the Slack app from the manifest
(`aivi slack manifest`).

## Dependencies

`@slack/socket-mode` and `@slack/web-api`; `@aivi/host` as a peer.

## Docs

[slack](../../docs/slack.md) ·
[channels](../../docs/channels.md)
