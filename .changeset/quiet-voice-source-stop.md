---
"@aivi/voice": patch
---

Stop logging `voice.source.exited` when voice ends a development room's decoder itself. Closing a file or microphone room kills its ffmpeg, and that requested exit was warned about as if the source had failed. Only a decoder that ends on its own with a failure is reported now.
