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
| `reenter(sessionId, text, context)` | Bring a job outcome into the conversation bound to that session as a turn of kind `job` |
| `post(channel, text, context)` | Post text to a platform channel; throw if aivi may not post there (`reportChannels`) |
| `accepts(channel)` | Whether a report to that channel could be delivered; refuses a job before it spends anything |
| `channelOf(sessionId)` | The platform channel the conversation bound to that session lives in (a thread's parent, a DM itself); "post it to this channel" resolves through it |

Registering is the whole integration with reports: `Channels` (the router on
`HostServices.channels`) sends `{ to: "channel", module }` reports to the
module with that id and `{ to: "session" }` reports to the module that owns
the session, falling back to a native `session.prompt` into the OpenCode
session when nobody owns it. `channels.ownerOf(sessionId)` is how the
schedule tool defaults `module` for a conversation that asks for a channel
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
  `reset` (`/new`; refused while work is pending), `adopt` (a report thread
  continues a job's session, or is seeded with a script's output),
  `channelOf`, `enqueueJobResult`, `has`, `list`, and the binding rotation:
  constructing the store with a different binding (agent, directory,
  application) acts as `/new` for every conversation, refused while any turn
  is queued or blocked.
- **`ChannelEngine`**: claims queued turns within `maxConcurrent` and shared
  capacity, calls the turn runner with a timeout, splits the reply at
  `replyLimit` (UTF-16 units, surrogate pairs intact) and sends it, records
  `sent`; `TurnNotStarted` → the turn is discarded and the person asked to
  resend; anything else → `blocked` with "an operator has been notified". The
  engine tells the host when capacity is released (`services.wake`).
- **`createTurnRunner`**: one turn = one verified turn of the agent's session
  through `runTurn`, with `external_directory` allows for the configured
  knowledge sources and nothing else; permission prompts auto-rejected. It
  builds the prompt (`[<label> message from <name> (user <id>)]` or the
  platform's `describeSpeaker`; the seed prefix for a script report's first
  turn; `reentryPrompt` for job outcomes) and the metadata (see ids below).
- Report helpers: `describeOutcome`, `shouldReport`, `reentryPrompt`.

## Identifiers and prefixes

All derive from the module id so two platforms never collide in one database
or one OpenCode:

| What | Shape |
| --- | --- |
| Tables | `<id>_turns`, `<id>_sessions`, `<id>_binding` |
| Lease | id `<id>:<turn id>`, owner `<id>` |
| Session | `ses_<id>_<uuid>`, title `<label> <conversation>`, `metadata.aivi = { origin: <id>, channel }` |
| Message | `msg_<id>_<turn id>` with every character outside `[A-Za-z0-9_]` replaced by `_` |
| Message metadata | `{ origin: <id>, channel, user, sourceMessage: <turn id> }`; job outcomes `{ origin: "job-result", channel, job }` |
| Job turn | id `job:<job id>`, user and name `aivi` |

A turn id is the platform's message id (a Discord snowflake, a Slack
`channel:ts`); it deduplicates gateway replays.

## Reports

`report` is a union owned by core (`reportSchema`):
`{ to: "session", session, on }` or `{ to: "channel", module, channel, on }`.
A session report re-enters the owning module's conversation as a `job` turn,
ordered behind the messages already waiting; a channel report is posted by
the named module, which opens a thread that adopts the job's session (agent
job) or is seeded with the output (script job), so replying to an outcome
meets an agent that knows what it did. Configuration and defaults:
[configuration](configuration.md#reporting).

## Feedback and recovery, shared

Every state a person waits on gets a signal: a waiting reaction while a
message is queued behind other work, a short message when a turn could not
start or could not be finished, and one notice per conversation after a
restart interrupted a turn ("please send it again", or "my last answer may be
incomplete" when delivery had started). Prompts are never resubmitted; a
partial reply is never resent. Blocked turns keep their capacity until the
operator runs `<module> resolve TURN_ID --reason … --confirm-stopped` after
inspecting the native session. Messages received while aivi was offline are
not backfilled from platform history.

## Live gate

Mock tests establish the contract, the store, the engine and the turn runner
against the real OpenCode client on a mock server. Each platform has its own
live gate: a message in a DM and in a configured channel, a thread opened by
a mention, a queued message showing the waiting signal, a job outcome
re-entering a thread, a report opening a thread that continues the job
session, and the slash commands. Record the result in
[roadmap](roadmap.md#live-gates).
