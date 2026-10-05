---
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**An answer lands in OpenCode before the books move.** The answer's
delivery was: flip the ledger to `working`, prompt the worker, close the
form. When the prompt threw — OpenCode down at that instant — the queued
path's catch had already given the reacquired lease back, leaving a
`working` run with no lease, no turn and no clock: nothing timed it out,
and a person's answer bought silence until the next boot. The order is now
OpenCode first, the books second (ruled 2026-10-03): the prompt goes in,
and only when it lands does the run flip back to `working` and the form
close as the record. A refused prompt moves nothing — the run stays parked
on its open form, the keep-alive re-arms as it stood, the person hears the
failure in the conversation, and the answer is giveable again. A delivery
whose ledger guard missed — the other answer of a race won, or a stop
landed in flight — now says so (`answer.duplicate`) instead of pretending;
`ledger.resumed` answers `undefined` when its guard misses.
