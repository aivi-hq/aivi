---
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**The dispatcher's queue: a full pool says *wait*, not *no*.** A lease
request that finds no slot is accepted into the pool's in-memory queue —
one place per service per pool — and when a slot opens the dispatcher
grants the lease and calls the service's own callback with its request id
and the lease. A resume waits in its own pool and returns there, never
into a fallback that happened to have room. Cancellation loses the queue
place and nothing more; the queue is ephemeral by design, and a restart
simply lets callers ask again for work that is still relevant. A service
nobody registered to hear gets the plain refusal — a lease granted to
nobody is a leak, not a queue.

The orchestrator re-checks the ticket before starting from the queue:
moved, blocked or claimed in the meantime, and the lease goes straight
back; a person's move on a queued ticket cancels its request. A queued
delegation says so to the delegator, keeps its Linear pair while it
waits, and starts the moment capacity opens — attaching to the very
session it was delegated in.
