---
"@aivi/voice": patch
---

Stop sending the end-of-answer signal to a mouth after a barge-in. The room contract says `flush` never follows a barge, because `stop` already closed the answer, but a stretch interrupted between two chunks was still flushed.
