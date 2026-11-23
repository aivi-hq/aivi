---
"@aivi/chrome": patch
---

Bound each `/json/version` request of `Chrome.launch` and `Chrome.attach` by the time the call was given (`startupTimeoutMs`, `timeoutMs`). A request to an endpoint that took the connection and never answered was not bounded by them, so the call could outlast its timeout.
