---
'@aivi/host': patch
---

The version gate binds the core API surface only. The host applies the client-version negotiation to the endpoints it registers itself — the set fills from the route table as the app is built, so it cannot drift — and everything else passes untouched: a path nobody serves answers its honest 404 or 405 to any caller, so a browser probe or a mispointed webhook sees a missing path, never a refusal naming a version it was never asked about.
