---
"@aivi/voice": patch
---

Check the replies of the separate `voice.stt` and `voice.tts` endpoints the way the streaming engine's are checked. A batch reply whose `text` was not a string was returned as the transcript, and a voice reply with malformed `audio` left its sentence waiting until the timeout while later sentences queued behind it. A malformed reply for a known request now logs a bounded bad-line diagnostic and settles as lost, and a line that is not an object with a request id is reported instead of ignored.
