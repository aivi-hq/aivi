---
"@aivi/voice": patch
---

Identify the final diarized speaker before committing its line at end of stream. EOF now applies the same completed-stretch binding as a speaker change, so a sufficiently long final utterance no longer loses its speaker name merely because no later activity event arrived.
