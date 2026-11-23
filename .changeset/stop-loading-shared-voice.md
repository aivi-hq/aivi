---
"@aivi/voice": patch
---

Own the shared streaming engine while its models load so shutdown can stop that process immediately. Late readiness and a ready marker followed by process death no longer cache a dead engine. Normal EOF clears the cached engine and diarizer state, and stopped startup attempts do not report a new failure.
