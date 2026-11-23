---
title: Slack
description: Put aivi in Slack with Socket Mode, DMs and threads.
order: 8
group: Plugins
---

`@aivi/channel-slack` connects aivi to Slack over Socket Mode. It needs no public URL, and it uses the host's sessions, search and capacity.

```sh
aivi add slack
```

The short name installs `@aivi/channel-slack`. The command prints the app manifest, asks for the two tokens, verifies each against Slack, writes `plugins.channel-slack`, and stores the tokens in `.env`.

## Setup

1. Run `aivi slack manifest` and paste the JSON into Slack's app setup. The manifest includes the commands, scopes and Socket Mode setting.
2. Install the app to the workspace.
3. Create an app-level token with `connections:write`.
4. Copy the bot token and the app token.
5. Invite the bot to every channel it should listen in.

The two secrets are `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. `aivi add slack` writes them for you and restarts the service.

## Link people

```sh
aivi link slack
```

Send `/link <code>` to the bot. Only linked people are heard in channels, and a linked person may DM the bot from anywhere.

## Configuration

```json
{
  "plugins": {
    "channel-slack": {
      "agent": "assistant",
      "commandPrefix": "aivi",
      "access": { "channels": [{ "id": "C0000000001" }] },
      "reportChannels": ["C0000000001"],
      "progress": "status"
    }
  }
}
```

`commandPrefix` sets the slash command names, so the default is `/aivi-new`, `/aivi-search` and so on. `reportChannels` are the channels where job outcomes may be posted. A thread opened by a report continues the job's session.

Slack has no typing indicator for bots. aivi reacts to the message while work is queued and while the agent is working, and a placeholder message says what it is doing. Every reply is sent as a Markdown block so agents can write standard Markdown.

The shared chat commands are the same as Discord's, with the configured prefix. In a threads-mode channel, commands that need one conversation say they cannot tell which thread is meant, because Slack refuses slash commands inside threads.

The full platform page is [Slack](https://github.com/aivi-hq/aivi/blob/main/docs/slack.md).
