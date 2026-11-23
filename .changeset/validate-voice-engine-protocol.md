---
"@aivi/voice": patch
---

Validate streaming-engine JSON before delivering events or batch replies. Non-object messages and malformed event fields now produce a bounded diagnostic instead of crashing or manufacturing transcript data. Malformed replies for known requests settle as lost, and an error response cannot certify accompanying text as a successful transcription.
