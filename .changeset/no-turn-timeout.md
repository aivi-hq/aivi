---
'@aivi/host': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/tracker-linear': minor
---

**`turnTimeoutMs` is gone from every platform.** The option existed three
times: Discord and Slack used it honestly (a chat turn longer than it was
discarded with a reason), Linear's copy promised — in its own description —
that "a worker turn longer than this is interrupted and ends stopped", while
the value only ever bounded the **assistant** turns of the channel engine.
Worker turns were never bounded by any clock: the dispatcher's idle timeout
times silence, and every tool event re-arms it. The operator ruled the whole
option removed (2026-10-03) rather than one more half-true knob: no clock
bounds a turn now. The bound's right home is the dispatcher, which watches
every session — the turn-lease design sketches its shape, and
`docs/plans/orchestrator.md` carries the ticket. Until it lands, a hung
assistant turn holds one of `maxConcurrent` slots and ends only when it
ends, with OpenCode's own errors, or with shutdown.
