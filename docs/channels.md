# Channel modules

A channel module connects one chat platform (Discord, Slack) to aivi. The host
owns everything a chat channel needs that is not platform-specific; a module
implements one contract and keeps only the glue: its gateway client, mapping
platform messages to an `AccessRoute`, sending, thread creation, slash
commands. Platform specifics live in [discord.md](discord.md) and
[slack.md](slack.md). This page owns the contract, the shared machinery, the
identifiers and the `report` shape.

## The contract

A module is a `HostModule` (`id`, `start(services)` → `stop()`) whose `start`
registers one `ChannelModule` with `services.channels.register(module)`:

| Member | Meaning |
| --- | --- |
| `id` | The module id (`discord`, `slack`): `report.module`, table prefix, lease owner, `metadata.aivi.origin` |
| `ownsSession(sessionId)` | This OpenCode session is one of the module's conversations (bound or adopted) |
| `reenter(sessionId, text, context)` | Bring a run's outcome into the conversation bound to that session as a turn of kind `job`; `context` is `{ run, state }` |
| `post(channel, text, context)` | Post text to a platform channel; throw if aivi may not post there (`reportChannels`) |
| `accepts(channel)` | Whether a report to that channel could be delivered; refuses a job before anything is spent |
| `channelOf(sessionId)` | The platform channel the conversation bound to that session lives in (a thread's parent, a DM itself); "post it to this channel" resolves through it |

Registering is the whole integration with reports: `Channels` (the router on
`HostServices.channels`) sends `{ to: "channel", module }` reports to the
module with that id and `{ to: "session" }` reports to the module that owns
the session, falling back to a native `session.prompt` into the OpenCode
session when nobody owns it. `channels.ownerOf(sessionId)` is how the
jobs tool defaults `module` for a conversation that asks for a channel
report. `register` returns the unregister function; call it in `stop`.

## What a module inherits

Everything below is in `@aivi/host` (`packages/host/src/channel/`) and is
parameterized by a `ChannelPlatform`: `{ id, label, replyLimit,
describeSpeaker? }`.

- **`ConversationStore`**: the durable inbox and conversation↔session
  bindings in the host database, tables `<id>_turns`, `<id>_sessions`,
  `<id>_binding`, versioned through `Store.migrate(id, …)`. Turns are of kind
  `message` (a person) or `job` (an outcome re-entering). A conversation is a
  string the module chooses (a Discord thread id, a Slack `channel:thread_ts`,
  a DM channel); each has one session at a time, `ready` once created. It
  provides: `enqueue` (dedupe by turn id, `maxPending`), `claim` (one turn per
  conversation, a lease on the module's pool in the same transaction),
  `ready`, `result`/`sent`, `block`, `fail`, `resolve`, `recover` (restart:
  interrupted turns are discarded, capacity released, the callers told),
  `interrupt` (a turn ended by choice, a shutdown or a `/stop`: discarded with
  the reason, lease released), `reset` (`/new`; refused while work is
  pending), `adopt` (a report thread continues a job's session, or is seeded
  with a script's output), `setModel` (the conversation's model pin, see
  [commands](#chat-commands)), `running` (the turn the agent is working on in
  a conversation), `channelOf`, `enqueueJobResult`, `has`, `list`,
  `sessionOf`, and the binding rotation: constructing the store with a
  different binding (agent, directory, application) acts as `/new` for every
  conversation, refused while any turn is queued or blocked.
- **`ChannelEngine`**: claims queued turns within `maxConcurrent` and shared
  capacity, calls the turn runner with a timeout, splits the reply at
  `replyLimit` (UTF-16 units, surrogate pairs intact) and sends it, records
  `sent`; `TurnNotStarted` → the turn is discarded and the person asked to
  resend; anything else → `blocked` with "an operator has been notified". Each
  launched turn has its own abort besides the engine's and the timeout:
  `stopTurn(conversation)` aborts the one running there (`/stop`), which is
  then discarded as "Stopped at the person's request" and the conversation
  hears "Stopped at your request."; a reply already being delivered is not
  stopped. The engine tells the host when capacity is released
  (`services.wake`). It talks
  to the platform through a `ChannelDelivery`: `send(conversation, text)`
  returning the posted message id, and optional `edit(conversation,
  messageId, text)` and `delete(conversation, messageId)`, which power the
  progress placeholder below.
- **Progress** (`progress.ts`, `reporter.ts`): while a turn runs, one
  placeholder message in the conversation says what the agent is doing. The
  module picks the mode from its config (`progress`: `silent` | `status` |
  `tools`, default `status`); a platform without `edit` is silent whatever the
  mode. See [progress](#progress-while-a-turn-runs).
- **`createTurnRunner`**: one turn = one verified turn of the agent's session
  through `runTurn`, with `external_directory` allows for the configured
  knowledge sources and nothing else; permission prompts auto-rejected. It
  builds the prompt (`[<label> message from <name> (user <id>)]` or the
  platform's `describeSpeaker`; the seed prefix for a script report's first
  turn; `reentryPrompt` for job outcomes) and the metadata (see ids below),
  and passes the conversation's model pin (`Turn.model`) as `TurnInput.model`,
  so the session is switched to it before the prompt; without a pin the agent
  file's model applies ([opencode](opencode.md#host-submission)).
- Report helpers: `describeOutcome`, `shouldReport`, `reentryPrompt`.

## Progress while a turn runs

The typing indicator and the 👀 reaction say "alive"; the placeholder says
"what". Progress is one edited message, never a flood: the conversation ends
with the answer only.

- **Source.** The host opens OpenCode's `client.event.subscribe()` once
  (`HostServices.events`, `packages/host/src/events.ts`): a live-only stream
  with no replay and no reconnect of its own, so the host rediscovers the
  client and reopens it with backoff (1 s doubling to 30 s) whenever it ends
  or errors, until the host stops. The first `events.watch(sessionID,
  listener)` opens it; `tick` and `once` never do. Events are fanned out by
  `data.sessionID`; events for sessions nobody watches are dropped. Connect
  and disconnect are logged once per transition (`events.connected`,
  `events.disconnected`).
- **Model** (`progress.ts`, pure): a turn's `phase` (`thinking` | `tool` |
  `writing`), its tool calls so far (`{ name, detail?, state: running | done
  | failed }`), start and last-activity times, folded from
  `session.tool.input.started` / `session.tool.called` /
  `session.tool.success` / `session.tool.failed`, `session.text.*`,
  `session.step.started`, `session.tool.progress`. Under codemode the native
  tool is `execute`, which only gets its name once the code arrives, so it
  stays out of the status line until then (seen live 2026-09-15: showing
  `execute` at `input.started` was the only tool phase anyone saw, the real
  name arriving inside the edit throttle). The aivi tools it runs are named
  from `session.tool.progress` → `metadata.toolCalls[].tool` with their status
  (authoritative), and from the code at `session.tool.called` as a fallback
  (`tools.knowledge.search({ query })` → `knowledge.search "…"`, bracket and
  destructured spellings included).
  Native tools show their name and a short detail: `read` the file's
  basename, `grep`/`glob` the pattern, `webfetch` the hostname, `bash` the
  first 40 characters of the command.
- **Text.** `status` is one line: `⏳ thinking…`, `🔧 reading handbook.md`,
  `🔧 searching knowledge "leave policy"`, `✍️ writing the answer`; after 20 s
  it carries ` · 3 tools · 1m 20s`; after 30 s without any event it reads
  `⏳ still working (2m 10s)…`. `tools` adds one line per call in order,
  capped at the last eight: `✓ knowledge.search "leave policy"`, `… read
  handbook.md`, `✗ webfetch example.com`.
- **Delivery.** The placeholder is posted when the turn is claimed. Edits are
  coalesced to at most one per 2 s per placeholder (the first at once, the
  rest on the trailing edge), and only when the text changed. There is no
  polling: the one timer waits for the next instant the text changes by
  itself (the 20 s suffix, the 30 s idle notice, then each 30 s refresh of
  the elapsed time). When the answer is ready the reply is posted and the
  placeholder deleted (edited into the first chunk where the platform cannot
  delete), so a new message carries the answer and its notification. A turn
  that could not start or finish edits the placeholder into the existing
  notice instead of posting another message. `job` turns (an outcome
  re-entering a conversation) get the same placeholder; scheduled runs with no
  conversation get none.

## Identifiers and prefixes

All derive from the module id so two platforms never collide in one database
or one OpenCode:

| What | Shape |
| --- | --- |
| Tables | `<id>_turns`, `<id>_sessions`, `<id>_binding` |
| Lease | id `<id>:<turn id>`, owner `<id>` |
| Session | `ses_<id>_<uuid>`, title `<label> <conversation>`, `metadata.aivi = { origin: <id>, channel }` |
| Message | `msg_<id>_<turn id>` with every character outside `[A-Za-z0-9_]` replaced by `_` |
| Message metadata | `{ origin: <id>, channel, user, sourceMessage: <turn id> }`; job outcomes `{ origin: "job-result", channel, run }` |
| Job turn | id `run:<run id>`, user and name `aivi` |

A turn id is the platform's message id (a Discord snowflake, a Slack
`channel:ts`); it deduplicates gateway replays.

## Reports

`report` is a union owned by core (`reportSchema`):
`{ to: "session", session, on }` or `{ to: "channel", module, channel, on }`.
A session report re-enters the owning module's conversation as a `job` turn,
ordered behind the messages already waiting; a channel report is posted by
the named module, which opens a thread that adopts the run's session (agent
job) or is seeded with the output (script job), so replying to an outcome
meets an agent that knows what it did. Configuration and defaults:
[configuration](configuration.md#reporting).

## Feedback and recovery, shared

A module's `start` may throw. Throw `ConfigurationError` (from `@aivi/host`)
for what only the operator can fix (missing tokens, rejected credentials, a
wrong application id); the host then stops. Anything else (a 5xx from the
platform, DNS, a socket that never opened) is retried by the host with backoff
while the module shows as `degraded` in status; the module needs no retry logic
of its own and must leave nothing half-registered when it throws.

Every state a person waits on gets a signal: a waiting reaction while a
message is queued behind other work, a placeholder that says what the agent is
doing while it works ([progress](#progress-while-a-turn-runs)), a short
message when a turn could not start or could not be finished, and a goodbye
when aivi goes down. On shutdown (`ChannelEngine.shutdown`) the running turn is
discarded, not blocked, since its only external effect is the reply, and its
conversation hears "I am going offline … please send it again" (or "my last
answer may be incomplete" when delivery had started); every conversation with
messages still queued hears that they stay queued and are answered after the
restart, which they are. Only a hard kill leaves `running`/`replying` turns
for the next start, where `recover()` discards them and the module posts the
same two notices. Prompts are never resubmitted; a partial reply is never
resent. Blocked turns keep their capacity until the operator runs
`<module> resolve TURN_ID --reason … --confirm-stopped` after inspecting the
native session. Messages received while aivi was offline are not backfilled
from platform history.

`describeSession` (host) renders one session's context: the window in use
against the model's limit (last answer's input + cache + output vs
`model.list().limit.context`), compactions, the session's token and cost
totals and the knowledge in scope, as markdown both platforms render, read
from OpenCode's transcript and catalogue. It backs three surfaces: the
channels' `/context` command (`describeConversation`, which adds the
conversation's binding and pending turns), `GET /v1/context?session=` and the
plugin tool `aivi_context`, so an agent asked "what's the context?" answers
with the same text. Slack refuses slash commands inside threads; there the
agent is the way to ask.

## Chat commands

Commands are adapter UI over host operations: the operation lives in the host
and a module only translates its platform's command into it, so both
platforms get the same set. `CHAT_COMMANDS` (`packages/host/src/channel/commands.ts`)
is the one table: name, description, arguments (with `required` and an
optional `autocomplete: "model"`), and whether the command acts on one
conversation. Discord registers its slash commands from it, Slack checks its
manifest against it (a test compares the snippet in [slack.md](slack.md#setup)
with the table), and `helpText` renders `/help` from it, each platform
spelling the names its own way (`/new`, `/aivi-new`). Conversation commands
are refused where a slash command cannot name one conversation (a
threads-mode channel outside a thread) and pass the same `access` policy as
messages.

| Command | Host operation |
| --- | --- |
| `new` | `ConversationStore.reset` |
| `status` | `ConversationStore.list` + `status()` |
| `context` | `describeConversation` |
| `search QUERY [project]` | `HostServices.knowledge.search` |
| `model [model]` | `describeModel` / `switchModel`: shows the conversation's pin, what its session last answered with and the agent's own model; with an argument pins the conversation to a catalogue model (`model.list` for the directory, enabled ones, spelled `provider/model` or `provider/model@variant`, `provider/model (variant)` accepted; a model id or display name that names exactly one entry works too; otherwise the closest matches are offered). The pin is `setModel` on the session row: `Turn.model` → `TurnInput.model`, applied by `session.switchModel` before each prompt, until `/new`; `default` unpins. Refused while a turn runs in that conversation. Discord autocompletes the argument from the catalogue (≤ 25 choices by prefix); Slack validates free text |
| `stop` | `stopTurn`: `ChannelEngine.stopTurn` (the turn is discarded as stopped, the conversation hears "Stopped at your request.") then `session.interrupt` so the agent stops spending; queued messages stay queued and follow. Nothing running → says so |
| `steer TEXT` | `steerTurn`: `session.prompt` with `delivery: "steer"` into the running turn's session, the speaker line as for a message, and `metadata.aivi.steer = <that turn's message id>` so `finalAnswer` counts it as part of the turn; nothing is queued when no turn runs |
| `jobs` | `describeJobs`: the next five occurrences (id, title, when) and the last ten runs (job, state, when) from the host store, as short markdown |
| `help` | `helpText`: one line per command |

## Live gate

Mock tests establish the contract, the store, the engine, the progress model
and the event stream (fan-out and reconnection against a mock SSE server), and
the turn runner against the real OpenCode client on a mock server. Each
platform has its own
live gate: a message in a DM and in a configured channel, a thread opened by
a mention, a queued message showing the waiting signal, the progress
placeholder changing while the agent works and vanishing with the answer, a
job outcome
re-entering a thread, a report opening a thread that continues the job
session, and the slash commands. Record the result in
[roadmap](roadmap.md#live-gates).
