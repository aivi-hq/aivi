---
"@aivi/voice": patch
---

Drop a call-room sentence that is worded after its room closed. An utterance still in the engine when everyone left was batched and armed the finished-window timer on the closed room. That late flush logged `voice.flush` for a prompt that could not be sent, and after a host shutdown it ran against the closed database and threw from a timer. The sentence is now logged as `voice.batch.dropped`, like the rest of a closing batch, and no timer is armed.
