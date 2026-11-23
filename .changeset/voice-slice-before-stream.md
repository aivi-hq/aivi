---
"@aivi/voice": patch
---

Answer a request for audio from before the stream began with nothing. `EngineRun.slice` with a negative start returned samples that were not numbers instead of `null`, which would have reached the voiceprint model.
