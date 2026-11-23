---
"@aivi/voice": patch
---

Stop separate STT and TTS processes during module shutdown even when their models are still loading. The module now owns each process before its ready marker, shares concurrent startup requests, and prevents late readiness or later audio from reviving a stopped endpoint.
