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
4. **Startup resilience** (live finding 2026-09-15): a transient
   `Unexpected server response: 503` from a chat platform's WebSocket during
   `module.start` took the whole host down, because startup failure unwinds
   everything ([application.md](../application.md)). After startup the rule
   "an optional module never takes the knowledge server and scheduler down"
   holds; at startup it does not. Wanted: a channel module that cannot connect
   retries with backoff in the background and reports itself degraded, while
   the API, scheduler and other channels run; only configuration errors (bad
   token, wrong application id) stay fatal. Also name the module in that
   error.
