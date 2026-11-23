---
title: Discord
description: Put aivi in Discord channels, DMs and threads.
order: 7
group: Plugins
---

`@aivi/channel-discord` connects aivi to Discord through one bot. It uses the host's sessions, search, database and capacity, so there is no separate Discord process to run.

```sh
aivi add discord
```

The short name installs `@aivi/channel-discord`. The full package name works too. The command creates the `plugins.channel-discord` block, verifies the bot token, writes `DISCORD_BOT_TOKEN`, and restarts aivi when it runs as a service.

## Setup

1. Create a Discord application and bot.
2. Invite it with the `bot` and `applications.commands` scopes.
3. Give it access to the channels it should read. It needs permission to send messages, add reactions, create public threads and send messages in threads.
4. Enable the Message Content intent when a channel uses a trigger other than `mention`.
5. Run `aivi add discord` and answer the token questions.

Each channel entry is a place aivi listens. The default opens a thread when someone mentions aivi. Inside that thread it answers every message. A `mention` trigger always needs an address, and `any` listens to every message.

## Link people

An account must be linked before aivi listens to it.

```sh
aivi link discord
```

Send `/link <code>` to the bot within 15 minutes. A linked person can DM the bot and is heard in the configured channels. An unlinked account is ignored, except for redeeming a code.

## Configuration

```json
{
  "plugins": {
    "channel-discord": {
      "agent": "assistant",
      "access": { "channels": [{ "id": "123456789" }] },
      "reportChannels": ["987654321"],
      "progress": "status"
    }
  }
}
```

`agent` is an OpenCode agent in the home. `reportChannels` are the channels where a job outcome may be posted. `progress` chooses the placeholder: `silent`, `status` or `tools`.

The shared chat commands work here: `/new`, `/status`, `/context`, `/search`, `/model`, `/stop`, `/queue`, `/jobs`, `/link` and `/help`. A message sent during a turn interjects by default; `/queue` puts it behind the turn.

Discord input is text only. A message with files or no text gets a short "text only" reply.

The full platform page is [Discord](https://github.com/aivi-hq/aivi/blob/main/docs/discord.md).
