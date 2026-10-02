---
'@aivi/core': patch
'@aivi/host': patch
'@aivi/cli': patch
---

The request diary: the host journals every arriving request — method, path, answer, time, headers, and the body's first 8 KiB — before any routing, so a refused bearer, an unowned path and a throwing handler are all visible. Credential headers are recorded as `[present]`, never as their value, and bodies are read from a clone so webhook signature verification still gets every byte. `aivi host clear-logs --older-than 30d` retires the old rows.
