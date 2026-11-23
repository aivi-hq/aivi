---
"@aivi/voice": patch
---

Close a development room quietly while its own engine still loads. Stopping the room ended the loading process, and that was logged as `voice.engine.start-failed` and shown as engine state `failed`. A closed room no longer reports its own stop as a failed start.
