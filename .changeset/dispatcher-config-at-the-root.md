---
'@aivi/core': minor
---

**The dispatcher's numbers get a home at the config root.** `dispatcher.pools`
— named capacity pools `{model?, capacity, fallback?}` every service draws
from — with the rule that **no pools means capacity is not moderated**
(unlimited, the intended default). `dispatcher.timeouts` watches leases:
`idle` (default `180m`, silence on an attached session before the slot is
reclaimed) and `prepare` (default `5m`, a lease without a session).
`orchestrator.elicitationKeepAlive` (default `5m`) is the orchestrator's own
dial: how long an open in-session elicitation holds its slot. Fallback chains
are load-checked — they must name pools that exist and must not cycle.
`parseDuration` now **sums space-separated parts**: `1h 30m` is 90 minutes.
The dispatcher that reads these numbers arrives with the next steps; naming
them wrong fails at load already.
