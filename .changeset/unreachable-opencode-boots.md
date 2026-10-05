---
'@aivi/host': patch
---

**A host whose OpenCode is unreachable boots anyway.** The boot reconcile
pass caught a server that did not answer but died building the client when
discovery found no service at all (`lifecycle: "discover"`, none
registered) — so `aivi serve` exited at boot instead of serving. That
silence now defers the pass whole, exactly as a non-answering server
already did: leases stand, clocks arm, the host serves. `runHost` gained an
`opencode` injection point, and its tests no longer discover the
developer's real service through the back door.
