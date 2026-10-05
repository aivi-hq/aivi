---
'@aivi/host': minor
'@aivi/forge-github': minor
---

The git crossings are injectable now: the orchestrator's git tools take a `git` dep, the worktree machinery a `WorktreeGit`, the project sync a `ProjectGit`, and the GitHub forge a `GitRunner`. Production leaves the real binary; the tests answer these instead, so the tools' decisions — which argv where, which refusal means what — are units, not git simulations. The killed slow tests are back: the CLI mechanism, the exec relay, the forge, the worktree teardown, the project sync, and the git tools, all in well under a second.
