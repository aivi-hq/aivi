---
'@aivi/host': minor
---

**The dispatcher: the only part that knows how much capacity is left.**
`host/src/dispatcher/` — durable leases (granted before a session exists,
attached when one is provided, released, expired) and the state machine
over them. A **new** session walks the pool's `fallback` chain and is
created in the first pool with room; a **resume** returns to the pool the
session was created in and waits there rather than move — running a session
in another pool would change its model and lose its prefill cache. At
session create **the pool decides the model**; the agent file's own model
wins only in a pool that names none, and in unlimited mode — which is what
no `dispatcher.pools` means: every request granted, capacity not moderated.
The dispatcher **kills a session before freeing its slot**: an unconfirmed
kill keeps the slot unavailable rather than double-book capacity that may
still be spending. At boot, persisted leases are reconciled against
OpenCode's reality — and a server that does not answer defers the whole
pass: silence is never proof that work died. Ending a lease never deletes
the session. Inert until the orchestrator starts asking.
