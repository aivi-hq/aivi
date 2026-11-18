---
"@aivi/voice": patch
---

Forget a room's persisted lease id once the restart recovery has returned it. The id stayed in the voice store until that room's next turn, so every later start asked the dispatcher again to release a lease that no longer existed. Capacity was never affected: the dispatcher's own lease was already gone.
