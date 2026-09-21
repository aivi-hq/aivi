---
'@aivi/cli': patch
---

The published `aivi` bin gains its shebang — without it the global command
could not execute at all (the shell tried to run the JavaScript as a script).
