# Module behaviour on host shutdown

Status: wanted before Linear workers exist.

## Today

`aivi serve` stops modules in reverse start order, aborts in-flight jobs (they
end `blocked`; see [operations.md](../operations.md#shutdown)), closes
the API, browser, knowledge, and releases the lock. Modules get `stop()` and an
aborted `signal`; nothing tells the outside world.

## Wanted

- Discord: announce in every conversation with an active or queued turn that
  aivi is going down (and, on restart, that it is back / that a turn was
  interrupted). Quiet conversations get nothing.
- Linear: stop active workers with a final `error` activity naming the
  worktree and session; what could not be verified stopped ends blocked
  ([plans/linear.md](../plans/linear.md)).
- Jobs: an `opencode.prompt` or `dreaming` turn interrupted by shutdown is
  already blocked; reporting could say so to its destination.
- A `--reason` on stop (maintenance, update, crash) so announcements can say why.

## Design notes

- Extend `HostModule` with an optional `stopping(reason)` phase that runs before
  `stop()`, bounded by a configurable grace period; the host must still exit
  when a module misbehaves.
- Announcements are proactive posts: they must respect each destination's
  policy (Discord: only where aivi already takes part, or `reportChannels`).
- Restart recovery already marks interrupted turns; pair it with a message.
