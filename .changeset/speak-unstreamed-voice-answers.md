---
"@aivi/voice": patch
---

Speak an answer whose text block opened but whose text never streamed. The `session.text.started` event alone marked the answer as streamed, so when its deltas did not arrive the finished answer was never spoken and nothing was logged. Only text that actually streamed counts now: without any, the whole answer is spoken when it is finished.
