---
'@aivi/cli': patch
---

**`aivi uninstall` no longer hangs on a deaf OpenCode.** With the CLI on
PATH but no service registered, `opencode plugin list` never exits, and the
command froze mid-listing — no timeout in the test runner could fire,
because the frozen spawn blocks the loop that enforces it. The probe now
carries an OS-enforced 500 ms deadline on the spawn itself, and silence
fails by name instead of an empty list reading as "no plugins".
