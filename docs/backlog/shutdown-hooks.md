# Module behaviour on host shutdown

Status: the announcements landed; the reason and the grace period did not.
What is left:

- A `--reason` on stop (maintenance, update, crash) so the notices can say
  why.
- An optional `stopping(reason)` phase on `HostModule` that runs before
  `stop()`, bounded by a configurable grace period; the host must still exit
  when a module misbehaves.

Announcements stay proactive posts: they must respect each destination's
policy (Discord: only where aivi already takes part, or `reportChannels`).
Restart recovery already marks interrupted turns — a `--reason` is what lets
the notice carry a cause.

## Landed

`aivi serve` still stops modules in reverse start order and aborts in-flight
work ([operations.md](../operations.md#shutdown)), but the outside world is
told now: a conversation with a queued or running turn hears that aivi is
going offline and that its message stays queued, hears it when a turn is cut
off mid-reply, and hears `🟢 aivi is online.` when the host is back
(`packages/host/src/channel/presence.ts`); a Linear worker says the same in
its own vocabulary.
