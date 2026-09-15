# Discord adapter

`@aivi/channel-discord` is an optional module inside the host application. It connects
to Discord through discord.js and uses the host's OpenCode connection,
knowledge service, database, and capacity limits. `aivi serve` starts and stops it;
there is no separate Discord server or daemon command. It implements the
[channel module contract](channels.md) with the module id `discord`; the
inbox, session bindings, engine, turn runner and recovery described there are
the host's. This page has what is Discord's.

## Behavior

- One configured OpenCode agent and fixed librarian directory for the installation.
- Each conversation maps to its own native session. A DM is one conversation.
  A configured channel is either `sessions: "threads"` (default: a top-level
  message addressing aivi opens a thread named after its first line, and each thread is a
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
- The agent is an ordinary OpenCode agent and its file is the whole boundary.
  Discord runs it exactly as defined; aivi only adds `external_directory`
  allows for the configured knowledge sources, which the agent file cannot
  know. Want no shell, no edits, no browser in Discord? Deny them in the agent
  file (the example librarian denies edit, shell and subagents). Permission
  prompts are auto-rejected because nobody is at the server to approve them,
  so anything OpenCode would *ask* about is refused.
- `/new` starts fresh on the next message, preserving old native sessions. It
  refuses while that conversation has queued, running, or blocked turns.
- `/status` shows that conversation's pending states, the next job
  occurrences, and how many runs finished in the last 24 hours (missed ones
  included).
- `/context` shows the session's context window as a bar against the model's
  limit (the last answer's prompt plus output, from OpenCode's model catalogue
  and transcript), compactions, then the session's totals (messages, answers,
  input/output/reasoning/cache tokens, billed cost), the knowledge in scope
  and what is pending here. Before the first message it says what the first
  one would start. Asking the agent in prose gives the same text through
  `aivi_context`.
- `/search query [project]` calls the shared knowledge service directly; no model turn is needed.
- `/model` shows what this conversation is pinned to (if anything), the
  model its session last answered with, and the agent file's own model.
  `/model <model>` pins the conversation to a catalogue model for its next
  turns until `/new` (`provider/model` or `provider/model@variant`; the option
  autocompletes from OpenCode's catalogue for the agent's directory; a model
  id or display name that names exactly one entry works too, anything else
  gets the closest matches); `/model default` unpins. Refused while a turn is
  running here. Shared behaviour: [channels](channels.md#chat-commands).
- `/stop` aborts the turn running in this conversation: the thread hears
  "Stopped at your request." in place of the answer, the turn is discarded
  (not blocked), its capacity released, OpenCode's session interrupted, and
  queued messages follow. Nothing running: it says so.
- `/steer text` passes text into the running turn (`delivery: "steer"`)
  instead of queueing it behind; with no turn running it says so and queues
  nothing.
- `/jobs` lists the next five job occurrences and the last ten runs.
- `/help` lists the commands, one line each.
- People always get a signal: a ⏳ reaction while a message waits behind other
  work (a short reply instead where the bot may not react; the invite should
  grant Add Reactions), a typing indicator while the agent works, a
  placeholder message in the conversation that says what the agent is doing
  (`progress`, below), a short
  message when a turn could not start (please resend) or could not be finished
  (an operator has been notified), and a goodbye when aivi goes offline
  mid-turn or with messages waiting. `reportChannels` see aivi come online
  and go offline ([channels](channels.md#feedback-and-recovery-shared)).
- `progress` (`silent` | `status` | `tools`, default `status`) chooses what
  the placeholder shows: nothing at all (`silent` is exactly the typing
  indicator alone), one line such as `⏳ thinking…`, `🔧 reading handbook.md`,
  `✍️ writing the answer` with the tool count and elapsed time after 20 s, or
  that line plus one line per tool call (`✓ knowledge.search "leave policy"`).
  It is edited in place at most every 2 s and deleted when the answer is
  posted, so the thread ends with the answer only; a turn that fails turns the
  placeholder into the failure notice. Shared behaviour:
  [channels](channels.md#progress-while-a-turn-runs). Needs Manage Messages
  only for other people's messages; the bot edits and deletes its own.
- Input is text-only. A message with attachments or without text gets a
  "text only" reply.
- Replies are split below Discord's message limit, with mentions and link embeds
  suppressed. Reasoning and tool output are excluded.

## Setup

Run `npm ci` (no build step). Create a Discord application
and bot, then invite it to your server with `bot` and `applications.commands`.
Give it access to the selected channels and permission to send messages, add
reactions, create public threads, and send messages in threads. Private threads also require bot
membership/access.

The example home enables Discord. Edit the IDs in `example/discord.json`;
`example/aivi.json` enables the module with:

```json
{ "modules": { "discord": { "config": "discord.json" } } }
```

That path resolves relative to the home. `agent` names an agent in the home's
`.opencode/agents/` (the home is the OpenCode location; `directory` overrides
that for an agent defined elsewhere). Discord and native chat run the same
agent file.

`DISCORD_BOT_TOKEN` comes from the environment (`<home>/.env`, see
[secrets](configuration.md#secrets)) and, with `host.auth.mode: "token"`, so
does `AIVI_TOKEN` (host API). Make `AIVI_TOKEN` available to the native OpenCode
server process as well so its plugin can call the host. The host discovers the
running `opencode service` on its own. Configure your provider/model in native
OpenCode for the librarian location.

`reportChannels` lists channel IDs where job outcomes may be posted
(`report: { "to": "channel", "module": "discord", "channel": … }`); with an
empty list aivi never posts on its own. A
posted outcome opens a thread (named after the job's `title`, else the
first line) and the thread is a conversation: for an agent job it continues
the run's own OpenCode session, so a reply lands with the agent that did the
work and it remembers everything; for a script job the thread gets a fresh
session whose first turn carries the posted output as context, and no model
call happens until someone replies. `/new` in such a thread returns it to the
module's own agent. Where a thread cannot be opened (a DM, a forum channel,
missing permission) the text is posted alone.

A Discord gateway error is logged and left to discord.js's reconnect logic; it
does not stop the host. Sessions created for Discord carry
`metadata.aivi = { origin: "discord", channel }` and each prompt carries the
Discord message id (`sourceMessage`), user id, and channel
([identifiers](channels.md#identifiers-and-prefixes)), so conversations can
later be selected by origin and speaker.

```sh
npm run aivi -- config check
npm run aivi -- serve
```

Commands follow the code: at every start the module overwrites the application's
command list with the shared command table (`/new`, `/status`, `/context`,
`/search`, `/model`, `/stop`, `/steer`, `/jobs`, `/help`; best effort,
logged); `discord register` does the same on demand without a restart. Global
commands can take up to an hour to appear in clients. Only the final command is a long-running aivi process: it starts
the host HTTP API, scheduler, knowledge service, and Discord together. OpenCode
remains its native execution service.

Channel entries default to `trigger: "mention-to-start"`, which needs
`messageContent: true` **and** the Message Content intent enabled in the
Discord developer portal (the example config has it on). Set
`trigger: "mention"` on a channel to run without that intent; DMs and bot
mentions are delivered regardless. The module requests no member or presence
intents. Discord documents the
[message-content exceptions](https://discord.com/developers/docs/topics/gateway#message-content-intent)
for DMs and bot mentions.

## Queue and recovery

The shared machinery is described in [channels](channels.md#what-a-module-inherits);
Discord's parameters: message ids are snowflakes and deduplicate gateway
replays, replies are split at 1900 UTF-16 units, the binding that rotates
sessions when it changes is `{ applicationId, agent, directory }`, and the
turn timeout is `turnTimeoutMs`. `maxConcurrent` adds a Discord-specific upper
bound on concurrent turns; `maxPending` bounds the inbox. The application lock
prevents duplicate hosts; a module lock also protects the Discord inbox.

```sh
npm run aivi -- discord status
npm run aivi -- discord resolve TURN_ID --confirm-stopped --reason "Inspected native session and Discord delivery; no owned work remains"
```

Resolution discards that blocked turn and releases capacity. It does not stop the
native session or resend a reply. Inspect/stop native work first. Queued messages
can then continue in the same session.

### Job outcomes in a thread

A job whose `report` points at a thread's session (`to: "session"`; the default
for jobs the librarian creates from a thread) does not post text: it re-enters
the thread as a turn of kind `job` ([channels](channels.md#reports)). The
prompt says that aivi delivered a job outcome and nobody typed it, and that the
librarian must pass it on rather than act on it (live finding 2026-09-15: asked
to relay a riddle, the librarian solved it). If no thread is bound to the
session, delivery fails and is audited on the job; the job outcome is unchanged.

## Boundaries

The session policy is the one under Behavior; web fetch/search are allowed,
browser stays denied. Out of scope for now: agent or project switching, ticket
control, streaming replies, attachment ingestion, a permission-approval UI,
automatic cleanup. Both jobs and Discord turns use the same verified-final-answer
driver; only blocked work needs an operator. Use trusted native plugins in the
librarian location: plugins remain executable OpenCode extensions.

Tests in this package cover Discord routing, the slash command definitions
against the shared table, and the example config; the shared
inbox, engine and turn runner are tested in the host with the real OpenCode
client against a mock server. Live status is in the [README](../README.md#status).

## Later

- Several Discord agents per installation (per channel or several module
  instances); the config already carries `agent` and `directory`. `/agent` is
  deliberately not a command: one librarian per bot, personalities by
  configuration.
