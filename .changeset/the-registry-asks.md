---
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/forge-github': minor
'@aivi/tracker-linear': minor
---

**The forge registry: who owns this project's remote?** The kit declares
a `Forges` contract and `AiviServices` carries it; `forge-github` now
registers its forge at module start instead of standing by unused. The
`projects-sync` task asks before it fetches: a checkout whose `origin` a
registered forge recognises syncs **through that forge**, authenticated as
its own installation; no forge or an unowned remote stays plain git
naming no plugin (the configurable path, not the spine). And the
misplaced git moved: worktree git left the Linear module for
`@aivi/host`'s orchestrator — a tracker answers tickets — while
`tracker-linear` stops exporting `ensureWorktree` and friends.
