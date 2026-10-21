---
'@aivi/core': major
'@aivi/host': major
'@aivi/plugin': major
'@aivi/cli': major
'@aivi/channel-discord': major
---

**Voice rooms: aivi hears and speaks.** The voice plugin (streaming MLX
transcription with speaker separation, CAM++ naming, wake, TTS that
streams while the answer is written) opens rooms through the new `voice`
seat; Discord joins voice channels whose speakers it already knows, and
the aivi face renders in core with `aivi face` previews. `aivi add` runs
a package's `./setup` only when it has one to say — a config-only plugin
now installs cleanly — and the voice wizard walks every audio model one
at a time, downloading on yes and stating the consequence on no. The
voice packages themselves (`@aivi/voice`, `@aivi/chrome`,
`@aivi/google-meet`) are deliberately **not** in this release: they are
private, 0.x, active development, and join the public set when they
graduate.
