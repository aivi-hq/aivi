---
"@aivi/voice": patch
---

Make the reference TTS engine always end a streamed sentence. When the model produced no audio, or stopped without a final chunk, `engine/mlx-tts.py` sent nothing, so the client waited out its whole timeout while later sentences queued behind it. The engine now sends a final reply without audio in that case.
