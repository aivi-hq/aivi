---
"@aivi/voice": patch
---

Say when a live utterance is only partly transcribed because the engine died while the person was still speaking. The `voice.lane.partial` warning was logged only when the engine died after the utterance had ended; a death in the middle of it committed the partial line without a word.
