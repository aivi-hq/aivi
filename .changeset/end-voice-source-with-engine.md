---
"@aivi/voice": patch
---

End a development room's audio source when its engine process dies. The file or microphone capture behind a `voice.room` kept running after an engine crash: nothing stopped it until the host exited, so a microphone stayed open with no engine left to hear it. The source now ends with its engine.
