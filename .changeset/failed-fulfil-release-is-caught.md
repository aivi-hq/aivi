---
"@aivi/host": patch
---

Catch the failure to give back a slot after a lease could not be fulfilled. The orchestrator's `fulfill.failed` handler released the slot inside a `try` that cannot catch a promise, so a release that failed became an unhandled rejection. A lease that is already gone is an answer, not a failure, and is now taken as one.
