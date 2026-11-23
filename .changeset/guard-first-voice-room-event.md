---
"@aivi/voice": patch
---

Guard the engine state a room shows a new watcher. That first event was delivered outside the guard later events get, so a watcher that threw on it threw out of `onEvent`, got no unsubscribe function and stayed registered. It is now logged as `voice.listener.failed` like any other failing watcher.
