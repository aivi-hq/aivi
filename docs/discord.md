# Discord adapter

`@aivi/discord` is an optional module inside the host application. It connects
to Discord through discord.js and uses the host's shared OpenCode client,
knowledge service, database, and capacity limits. `aivi serve` starts and stops it;
there is no separate Discord server or daemon command.

## Behavior

- One configured OpenCode agent and fixed librarian directory for the installation.
- Each conversation maps to its own native session. A DM is one conversation.
  A configured channel is either `sessions: "threads"` (default: a top-level
  message addressing aivi opens a thread named after it, and each thread is a
  conversation; the channel itself never is) or `sessions: "channel"` (the
  channel is one shared conversation and its threads are ignored). Speakers
  share a conversation's history; prompts carry their Discord IDs.
- Access is decided before anything is queued, by the shared `access` policy:

  ```json
  "access": {
    "dm": { "users": ["<user id>"] },
    "channels": [
      { "id": "<home channel id>", "users": "anyone" },
      { "id": "<team channel id>", "users": ["<user id>"], "trigger": "any" }
    ]
  }
  ```

  No `dm` block means nobody may DM. Channel entries default to
  `sessions: "threads"` and `trigger: "mention-to-start"`: a mention opens a
  thread, and inside a thread aivi takes part in every message counts. Other
  triggers: `mention` (always address aivi) and `any` (every message). Anything
  but `mention` needs `messageContent: true` (Discord's Message Content intent). Everyone else is silently ignored; bots,
  webhooks, system messages, and edits are ignored too. The same shape will be
  used for Slack and other adapters.
- The librarian session is read-only: deny-all, then allow read/glob/grep, Code
  Mode, skills, web fetch/search, and the aivi tools (`knowledge_search`,
  `aivi_sources`, `aivi_status`) plus reads inside configured knowledge
  sources. Never shell, edit, subagents, or browser. Permission prompts are
  auto-rejected because nobody is at the server to approve them.
- `/new` starts fresh on the next message, preserving old native sessions. It
  refuses while that conversation has queued, running, or blocked turns.
- `/status` shows only that conversation's pending states.
- `/search query [project]` calls the shared knowledge service directly; no model turn is needed.
- The bot shows a typing indicator while the agent works.
- Input is text-only. Attachments are not downloaded or silently omitted.
- Replies are split below Discord's message limit, with mentions and link embeds
  suppressed. Reasoning and tool output are excluded.

## Setup

Build the monorepo with `npm ci` and `npm run build`. Create a Discord application
and bot, then invite it to your server with `bot` and `applications.commands`.
Give it access to the selected channels and permission to send messages, create
public threads, and send messages in threads. Private threads also require bot
membership/access.

Edit the IDs in `examples/discord.json`, and use `examples/aivi-discord.json` as
the installation config. It enables the module with:

```json
{ "modules": { "discord": { "config": "discord.json" } } }
```

That path resolves relative to `aivi.json`; the librarian directory resolves
relative to the Discord config. The example librarian loads the native aivi
plugin, including `knowledge_search`.

Put `DISCORD_BOT_TOKEN` in a `.env` next to `aivi.json` (or inject it with fnox) and, with `host.auth.mode: "token"`,
`AIVI_TOKEN` (host API). Make `AIVI_TOKEN` available to the native OpenCode
server process as well so its plugin can call the host. The host discovers the
running `opencode service` on its own. Configure your provider/model in native
OpenCode for the librarian location.

`reportChannels` lists channel IDs where scheduled job outcomes may be posted
(`report.to: "discord"`); with an empty list aivi never posts on its own.

A Discord gateway error is logged and left to discord.js's reconnect logic; it
does not stop the host. Sessions created for Discord carry
`metadata.aivi = { origin: "discord", channel }` and each prompt carries the
Discord message id, user id, and channel, so conversations can later be selected
by origin and speaker.

```sh
npm run aivi -- --config examples/aivi-discord.json config check
npm run aivi -- --config examples/aivi-discord.json discord register
npm run aivi -- --config examples/aivi-discord.json serve
```

`discord register` upserts `/new`, `/status`, and `/search`. Startup does not change
Discord commands. Only the final command is a long-running aivi process: it starts
the host HTTP API, scheduler, knowledge service, and Discord together. OpenCode
remains its native execution service. No live Discord registration was performed
during development.

By default, guild messages must mention the bot; DMs need no mention. For natural
follow-ups throughout allowed threads, set `messageContent: true` **and** enable
Message Content Intent in the Discord developer portal. The module requests no
member or presence intents. Discord documents the
[message-content exceptions](https://docs.discord.com/developers/host/you-might-not-need-a-privileged-intent)
for DMs and bot mentions.

## Queue and recovery

Incoming accepted messages enter a durable SQLite inbox before model dispatch.
Discord message IDs deduplicate Host replays. Messages received while the
adapter is completely offline are not backfilled from Discord history.

Each active turn reserves the configured resource pool and global capacity in the
same transaction as its inbox claim. Scheduled jobs honor these reservations,
and chat respects running/blocked jobs. `maxConcurrent` adds a Discord-specific
upper bound. `maxPending` bounds the inbox. One conversation runs only one turn
at a time; excess messages queue in arrival order.

The native session ID is persisted before creation. Each turn uses a stable
native prompt ID and speaker metadata. The adapter waits for that exact turn's
completed final answer, successful native idle outcome, and finished tools.
It does not treat idle alone as proof of completion. The session's fixed agent
and directory are checked before each prompt.

Replies are saved before delivery. Once fully delivered, their payloads and input
text are removed from the inbox; native OpenCode remains the transcript store.
If generation, delivery, timeout, or shutdown is interrupted, the turn becomes
blocked and retains its capacity. A partial Discord reply is not automatically
resent. This avoids duplicating potentially delivered messages after a lost
response. `/status` exposes the blocked state; operator status includes the native
session ID and undelivered result for inspection.

```sh
npm run aivi -- --config examples/aivi-discord.json discord status
npm run aivi -- --config examples/aivi-discord.json discord resolve TURN_ID --confirm-stopped --reason "Inspected native session and Discord delivery; no owned work remains"
```

Resolution discards that blocked turn and releases capacity. It does not stop the
native session or resend a reply. Inspect/stop native work first. Queued messages
can then continue in the same session. Restarted adapters block interrupted turns
instead of resubmitting prompts. The application lock prevents duplicate host hosts; a module lock also protects the Discord inbox.
Changing application, agent, or directory against existing state is rejected;
deliberate rebinding/migration is future work.

## Boundaries and verification

Every native Discord session receives a session-level deny-by-default policy,
with reads, search within files, and Code Mode enabled. Configured source
directories receive external-read access. Shell, edits, subagents, MCP actions,
and other unspecified actions remain denied. This first adapter uses local
documents; specialist delegation and web/browser tools are future additions.
Use trusted native plugins in the librarian location: plugins remain executable
OpenCode extensions. The native permission model is documented
[here](https://opencode.ai/v2/docs/permissions).

No agent/project switching, ticket control, proactive messages, Discord permission
approval UI, attachment ingestion, typing/streaming UI, or automatic cleanup is
included. Host scheduled-task completion remains operator-confirmed; Discord
has a separate read-only chat completion path.

Tests cover routing, session isolation/reset, deduplication, queueing, shared
capacity, restart recovery, failed delivery, Unicode splitting, and final-answer
filtering. The actual OpenCode client is exercised against a mock server. Live
Discord and native OpenCode integration still require your configured installation.
