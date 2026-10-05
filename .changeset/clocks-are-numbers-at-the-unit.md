---
'@aivi/host': minor
---

**The dispatcher's clocks are milliseconds at the unit.** `Dispatcher`
takes `idleMs` and `prepareMs` as numbers — the config load parses the
duration strings once (`application.ts`), and the waiting itself has
never needed the strings. A test hands 30 in and watches a clock fire
in milliseconds instead of paying a real second per test; the duration
grammar people write (`180m`, `5m`) is untouched. `expire`'s third
parameter, a `now` the body never read, is gone.
