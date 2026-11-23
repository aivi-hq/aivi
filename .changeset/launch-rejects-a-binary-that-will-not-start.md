---
"@aivi/chrome": patch
---

Make `Chrome.launch` reject when the browser binary cannot be started. Node reports a binary that is missing or not executable as an `error` event on the child process, and with no listener on it Node ends the whole process. `launch` now listens, and rejects with that error (for example `spawn /opt/chrome ENOENT`).
