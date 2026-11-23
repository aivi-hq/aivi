---
"@aivi/voice": patch
---

Load a fresh separate speech endpoint after its process dies. A `voice.stt` or `voice.tts` process that exited after loading stayed cached as loaded, so every later utterance was lost and every later answer stayed unspoken until the host restarted. The next request now starts a replacement, as a failed load already did.
