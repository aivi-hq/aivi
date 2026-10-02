---
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**Elicitations hold their slot for a while, then cost nothing.** A worker
that asks a person a question parks its run in `awaiting_input` — the
claim and the session stand, and the OpenCode form is the durable record
of the wait. The slot is held for `orchestrator.elicitationKeepAlive`
(default 5 minutes); after that the lease is **released, not expired**:
nobody is killed, and the freed capacity goes to the walk. When the answer
arrives it reacquires capacity and resumes the same session — the pool it
was born in, never a fallback — and a full pool queues the reacquisition
like any other resume: the answer's words wait with the request, the
person hears that the worker wakes when a slot opens, and a refusal is
said too. A stop reaches a parked run; a wait that survived a restart
re-arms its clock from the boot.
