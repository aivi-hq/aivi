---
'@aivi/tracker-linear': patch
---

**The board query speaks Linear's id types.** `issuesIn` declared its
`$teamId`/`$stateId` as `String!` where Linear's id **filters** are typed
`ID` and answer a String variable with a 400 — the eligibility walk died
on the first real board read (live, 2026-10-02). The fake board could
never catch it; direct id arguments accept String, filter comparisons do
not.
