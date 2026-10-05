---
'@aivi/cli': patch
'@aivi/core': patch
'@aivi/forge-github': patch
---

The CLI's `main` is a table of contents now: the remote flag, the
client-side set, the home commands, the exit ramp, the service verbs and
the app-command mount are each a named function, and `add`'s setup and
schema steps have their own names. Core's lane rules are four named
checks instead of one refinement. The GitHub test double reads a call's
shape in named parts. No behavior moved a word; 521 tests green before
and after.
