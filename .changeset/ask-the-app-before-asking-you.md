---
'@aivi/forge-github': patch
'@aivi/tracker-linear': patch
---

Two wizard fixes from the operator's live `projects add`. The forge asks
the app what it was granted before asking the person anything: the
repository prompt is now a search-as-you-type pick-list of the
installation's real repositories, with the typed prompt kept for when the
list cannot be fetched. And the lane wizard stopped asking "does this
lane write files" to decide on a worktree — the worktree belongs to the
branch, not to writing: a review lane changes nothing yet must read the
pull request's branch, which lives nowhere but a worktree. The question
is now "does work happen on the ticket's branch".
