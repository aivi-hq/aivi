---
"@aivi/host": minor
---

Remove `requestId` from `DispatcherLease` and from the input of `LeaseStore.grant`. Nothing ever wrote it: the dispatcher's queue lives in memory only. The `request_id` column stays in existing databases, unused.
