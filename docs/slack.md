# Slack adapter

`@aivi/channel-slack` is an optional module inside the host application. It
connects to Slack over **Socket Mode** (no public URL) with `@slack/socket-mode`
and `@slack/web-api`, and implements the [channel module contract](channels.md)
with the module id `slack`; the inbox, session bindings, engine, turn runner,
recovery and feedback described there are the host's. This page has what is
Slack's. `aivi serve` starts and stops it; there is no separate Slack process.

## Behavior

- One configured OpenCode agent and fixed librarian directory for the
  installation; `agent` and `directory` work as for Discord.
- A conversation is a DM channel (`D…`), a thread (`channel:thread_ts`), or a
  whole channel. A configured channel is either `sessions: "threads"`
  (default: a top-level message addressing aivi opens a thread on that message
  and each thread is a conversation; the channel itself never is) or
  `sessions: "channel"` (the channel is one shared conversation and its
  threads are ignored). Speakers share a conversation's history; prompts
  carry the speaker's display name (`users.info`) and Slack user id.
- Access is the shared `access` policy with Slack ids: users `U…`/`W…`,
  channels `C…`/`G…`; DMs are keyed by the `D…` channel. Triggers work as on
  Discord; Slack always delivers message text, so there is no
  `messageContent` switch. Addressing aivi is an `app_mention` event or
  `<@bot>` in the text; Slack sends both for one message and the module keeps
  the first by `channel:ts`. Messages from bots (including its own), edits,
  deletions, joins and other subtypes are ignored. A message with files or
  without text gets a "text only" reply.
- Replies go through `chat.postMessage` into the thread (`thread_ts`) or the
  DM, with link and media unfurling off, split at 3900 characters. Every
  message the module sends (replies, the progress placeholder, ephemeral
  command answers) is a Block Kit `markdown` block with the same string as
  `text` for the notification preview: agents write standard Markdown, and a
  bare `text` field would be read as Slack's own mrkdwn dialect (`**bold**`,
  headings, `[text](url)` all come out mangled). The block renders it as
  written; the module translates nothing. Slack has
  no typing indicator for bots, so reactions on the person's message carry the
  signal: ⏳ (`hourglass_flowing_sand`) while it waits behind other work, 👀
  (`eyes`) while the agent works on it, both removed when the answer is posted
  (live request 2026-09-15). In addition a placeholder message in the thread
  or DM says what the agent is doing (`progress`: `silent` | `status` |
  `tools`, default `status`): `⏳ thinking…`, `🔧 searching knowledge "leave
  policy"`, `✍️ writing the answer`, in `tools` mode with one line per call
  beneath it. It is updated through `chat.update` at most every 2 s and
  deleted (`chat.delete`) when the answer is posted, so the thread ends with
  the answer; a turn that fails turns it into the failure notice. `silent`
  keeps the reactions only. Shared behaviour:
  [channels](channels.md#progress-while-a-turn-runs). `chat:write` covers
  editing and deleting the bot's own messages; no new scope is needed.
- Slash commands are predefined in the app manifest with a configurable
  prefix (`commandPrefix`, default `aivi`): `/<prefix>-new`,
  `/<prefix>-status`, `/<prefix>-context`, `/<prefix>-search QUERY [project]`;
  replies are ephemeral through the command's `response_url`. Slack commands
  carry no thread, so in a `threads` channel they speak for the channel:
  `-new` says that every new top-level message already starts a fresh
  conversation, `-status` counts the pending turns of all its threads, and
  `-context` says it cannot tell which thread is meant (Slack itself refuses
  slash commands inside threads; ask the agent for the context there). In a DM or a
  `channel`-mode channel they behave like Discord's `/new`, `/status` and
  `/context` ([discord](discord.md#behavior)).
  `-search` treats the last word as a project only when it names a
  configured one.
- Sessions carry `metadata.aivi = { origin: "slack", channel }` and each
  prompt the Slack `channel:ts` as `sourceMessage`
  ([identifiers](channels.md#identifiers-and-prefixes)).

## Setup

Create a Slack app from this manifest (replace `{prefix}` with your
`commandPrefix`; the app and bot names are yours):

```yaml
display_information:
  name: aivi
features:
  bot_user:
    display_name: aivi
    always_online: true
  slash_commands:
    - command: /{prefix}-new
      description: Start a fresh conversation
      should_escape: false
    - command: /{prefix}-status
      description: Show this conversation status
      should_escape: false
    - command: /{prefix}-context
      description: What this conversation's session knows
      should_escape: false
    - command: /{prefix}-search
      description: Search team knowledge
      usage_hint: QUERY [project]
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - im:read
      - im:write
      - reactions:write
      - users:read
      - commands
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Install the app to the workspace, create an **app-level token** with
`connections:write` (`xapp-…`) and copy the **bot token** (`xoxb-…`). Put
them in `<home>/.env` as `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`
([secrets](configuration.md#secrets)). Invite the bot to every channel it
should listen in. Collect the ids: your user id (profile → copy member id),
channel ids (channel details → bottom of the About tab). DM channel ids are
not configured; the `dm.users` allow-list decides who may DM.

The example home enables Slack with placeholder ids in `example/slack.json`;
`example/aivi.json` has:

```json
{ "modules": { "slack": { "config": "slack.json" } } }
```

```json
{
  "$schema": "../schemas/slack.schema.json",
  "version": 1,
  "agent": "librarian",
  "commandPrefix": "aivi",
  "access": {
    "dm": { "users": ["U0000000001"] },
    "channels": [{ "id": "C0000000001", "users": "anyone" }]
  },
  "reportChannels": ["C0000000001"],
  "progress": "status",
  "resource": "local-model",
  "maxConcurrent": 1,
  "maxPending": 100,
  "turnTimeoutMs": 300000
}
```

`reportChannels` lists channels where job outcomes may be posted
(`report: { "to": "channel", "module": "slack", "channel": … }`). A posted
outcome's thread is a conversation: for an agent job it continues the job's
own session; for a script job it gets a fresh session seeded with the output.
Slack threads have no titles, so the job's `title` is not used.

```sh
npm run aivi -- config check
npm run aivi -- serve
```

No `slack register` exists: Slack has no API for slash commands; the manifest
defines them. A Socket Mode disconnect is routine and the client reconnects
on its own; it never stops the host.

## Queue and recovery

Shared: [channels](channels.md#what-a-module-inherits). Slack's parameters:
turn ids are `channel:ts`, replies are split at 3900, the binding that
rotates sessions when it changes is `{ agent, directory }`, and the turn
timeout is `turnTimeoutMs`.

```sh
npm run aivi -- slack status
npm run aivi -- slack resolve TURN_ID --confirm-stopped --reason "Inspected native session and Slack delivery; no owned work remains"
```

## Boundaries

Same as Discord's: the agent file is the boundary, web fetch/search allowed,
browser denied by the example agents. Out of scope: agent or project
switching, streaming replies, attachment ingestion, a permission-approval UI,
Block Kit beyond the `markdown` block (layouts, interactive components),
multi-workspace (org) installs.

Tests mirror Discord's: routing and access with Slack ids, the example
config, and the module against a fake connection and the real OpenCode client
on a mock server (mention → thread reply, dedupe, files, report thread
adoption, re-entry, slash commands, waiting reaction, not-started turns, the
progress placeholder through `chat.update`/`chat.delete`). The
Socket Mode client itself is only exercised live.

## Later

- Live gate on the owner's workspace ([roadmap](roadmap.md#live-gates)).
- Reply to a top-level message in `channel` mode as a thread when the person
  started one.
- Several Slack agents per installation; the config already carries `agent`
  and `directory`.
- Slack's "Agents & AI Apps" feature (`assistant:write`,
  `assistant.threads.setStatus`) would add a "thinking…" status, but only in
  assistant threads (the app's DM in the AI side panel), not in channel
  threads, and it changes the DM UX (suggested prompts, split view). An option
  for DM-heavy use; the 👀 reaction covers channels either way.
- See [chat commands](backlog/chat-commands.md).
