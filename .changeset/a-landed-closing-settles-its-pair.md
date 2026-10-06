---
'@aivi/tracker-linear': patch
---

A landed closing now **settles its pair**. The boot pass used to re-owe
every terminal run ever — two Linear queries and a delegate-write per pair,
per boot, forever, growing with the history (live, 2026-10-06). Landed pairs
are stamped in the tracker's own table and boot reads only the owed ones,
through a partial index that stays tiny while the history grows. The stamp
records that the asking happened and never replaces it: an owed pair is
still reconciled against Linear's real state, so a home from before the
stamp asks once and settles.
