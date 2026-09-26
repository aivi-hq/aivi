---
'@aivi/core': patch
'@aivi/host': patch
'@aivi/cli': patch
'@aivi/app': patch
---

`host.public`: the address others reach aivi at (funnel, tunnel or proxy URL), asked once by `aivi setup`, softly probed against `/health`, and preferred in every URL aivi prints for someone else to paste — the "another machine" connect lines, `aivi people create`'s token handoff, and `/status`. aivi keeps dialling `host.bind`/`host.port`; nothing is derived.
