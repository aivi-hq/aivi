---
'@aivi/cli': patch
'@aivi/host': patch
'@aivi/plugin': patch
---

A worker's execution that **fails** on the wire now ends its run at once,
with the wire's own words as the reason. The watcher knew only an
execution's start and its success: an unloadable model variant failed the
drain 3 ms after the prompt (live, 2026-10-06), and the run sat `working`
forever behind a keep-alive that promised "still working" to a deleted
audience — no nudge, no failure, no slot back. The ticket stays where the
person can see it: the worker never got to work on it.
