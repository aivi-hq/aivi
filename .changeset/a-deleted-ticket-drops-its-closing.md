---
'@aivi/tracker-linear': patch
---

A deleted ticket stops haunting the log. Deleting an issue takes its agent
session with it, and Linear then answers every later call with
`Entity not found` (HTTP 200): the owed closing failed, the help-on-the-way
comment failed on the same grave, and the boot pass re-owed and re-failed
it on **every** boot (live, 2026-10-06). The tracker now knows Linear's
gone-answer: the debt drops where it stands, said once, and a missing
issue reads as deleted — not a crash — wherever the ending asks where the
ticket sits.
