---
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/forge-github': minor
---

**The git tools split, and the push gets smart.** `aivi_push` moves a
worker's commits to the remote and unstucks them itself: it fetches the
branch fresh through the forge, fast-forwards when it can, merges the
remote's real work in when it can (a conflict names the files and leaves
the merge in progress for the worker to resolve with plain git), and when
the divergence is only the worker's own rewrite — every remote commit
patch-equivalent — the force goes through, leased on the sha just fetched
so a person's newer commit can never burn. `aivi_sync` brings all the
remote's branches in (pruned, refs only) and answers behind/ahead, plus
how far the default branch moved. `aivi_pr` is reduced to *opening the
pull request*: it pushes first if anything is unpushed, answers an open
pull request instead of doubling it, and opens a fresh one when the last
merged and new commits came since. On the forge contract, `push` is pure
transfer now (plain, or `--force-with-lease` on the caller's `lease`),
opening a pull request is its own member `openPr`, and `fetchRefs` is the
sync's transfer.
