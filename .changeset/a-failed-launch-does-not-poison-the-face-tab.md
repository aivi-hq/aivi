---
"@aivi/core": patch
---

Stop a failed browser launch from poisoning every later face tab. The shared browser is one promise that the face tabs reuse; when `Chrome.launch` rejected (no Chrome installed, a boot that timed out), that rejected promise stayed in place and its user count stayed up, so every later `openFaceTab` met the same stale error until the host restarted, even after the cause was fixed. A launch that fails now leaves nothing behind, and the next open launches again.
