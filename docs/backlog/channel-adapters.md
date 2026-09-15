# Channel adapters: one contract for Discord, Slack, Signal, Telegram

Status: the contract and the shared machinery are built (2026-09-15); Discord
is the only implementation. What exists is owned by
[channels.md](../channels.md) (contract, inherited machinery, ids, report
shape) and [configuration.md](../configuration.md#reporting) (the `report`
union and its defaults).

## Left to do

1. Live-gate Discord again after the lift (its behaviour is meant to be
   unchanged; the message metadata key `discordMessage` became
   `sourceMessage`).
2. `@aivi/channel-slack`: Socket Mode, threads as conversations
   (`channel:thread_ts`), the same `/new`, `/status`, `/search` as predefined
   slash commands, reports opening a thread that adopts the job session.
3. Signal and Telegram (no threads, DM-first) will test whether the binding
   model generalizes; expect a "conversation without threads" case, as Hermes
   has for WhatsApp/Signal.
