# Channel adapters: one contract for Discord, Slack, Signal, Telegram

Status: agreed direction 2026-09-15; do it as the first step of the Slack
adapter, which the owner wants soon. Slack goes first because its UX (channels,
threads, mentions) is closest to Discord's.

## What exists

`@aivi/discord` implements everything a chat channel needs, by itself: an
access policy → durable inbox (`discord_turns`) → lease → `runTurn` → reply,
thread↔session bindings (`discord_sessions`, with adoption of job sessions and
seeds), restart recovery, `/new`, `/status`, `/search`, a destination for
reports (`register('discord', …)`) and a session owner for re-entry
(`registerSessionOwner`). The host knows three half-formal hooks: `Destination`
(`deliver`, `accepts`), `SessionOwner` (`owns`, `reenter`), and the
`HostModule` start/stop contract.

The `report` shape leaks this: `{ to, channel, on }` overloads `channel` (a
session id for `to: "session"`, a Discord channel id otherwise), and "none" is
`null` in storage but `"none"` in the tool.

## Direction

1. **A `Report` union** owned by core:
   `{ to: "session", session }` (channel-agnostic: whoever owns the session
   delivers) | `{ to: "channel", module, channel }` | absent. `on` unchanged.
   Migrate stored reports in one schema step.
2. **A `ChannelModule` contract** in the host that every chat adapter
   implements and registers itself with (`services.channels.register(module)`):
   `ownsSession`, `reenter`, `post(channel, text, context)`, `accepts(channel)`,
   plus the identity used in `metadata.aivi.origin` and in lease owner ids.
   Registering *is* what makes a module usable as a destination; the two
   registries (`Destinations`, session owners) merge into this one.
3. **Lift the shared machinery into the host**: the inbox table shape, the
   claim-with-lease transaction, thread↔session bindings with adoption and
   seeds, restart recovery, the verified-turn driver call, reply splitting by a
   per-platform limit. The adapter keeps only what is platform-specific: the
   gateway client, message → route mapping, sending, thread creation, slash
   commands. Target: a new adapter is mostly glue.
4. **Package naming**: `@aivi/channel-discord`, `@aivi/channel-slack`,
   `@aivi/channel-signal`, `@aivi/channel-telegram`. Rename `@aivi/discord`
   as part of this; config key `modules.discord` can stay.
5. **Access policy stays shared** (`accessPolicySchema` already is); each
   adapter maps its own ids into it.

## Order

Refactor with Discord as the only implementation (behaviour unchanged, tests
moved to the host where the machinery moves), live-gate Discord again, then
write Slack against the contract. Signal and Telegram (no threads, DM-first)
will test whether the binding model generalizes; expect a "conversation without
threads" case, as Hermes has for WhatsApp/Signal.
