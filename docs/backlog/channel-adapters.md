# Channel adapters: one contract for Discord, Slack, Signal, Telegram

Status: the contract, the shared machinery, and two implementations exist
(2026-09-15). What exists is owned by [channels.md](../channels.md) (contract,
inherited machinery, ids, report shape), [discord.md](../discord.md),
[slack.md](../slack.md) and [configuration.md](../configuration.md#reporting)
(the `report` union and its defaults).

## Left to do

1. Live-gate Discord again after the lift (its behaviour is meant to be
   unchanged; the message metadata key `discordMessage` became
   `sourceMessage`), and Slack for the first time
   ([roadmap](../roadmap.md#live-gates)).
2. Signal and Telegram (no threads, DM-first) will test whether the binding
   model generalizes; expect a "conversation without threads" case, as Hermes
   has for WhatsApp/Signal. Slack's `sessions: "channel"` mode is the closest
   thing today.
3. Dreaming's default `origins` is `["discord"]`; a Slack installation must
   list `slack` itself. A default of "every registered channel module" needs
   the task to see the module list.
