---
"@aivi/voice": patch
---

Report live first-word latency in milliseconds. The `voice.lane.firstword` log previously stored rounded seconds in its `ms` field, making sub-second recognition delays appear as zero.
