---
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/forge-github': minor
---

**`aivi_pr`: the worker's word that the branch is ready, routed to the
forge.** The worker calls it with the pull-request title and description;
the orchestrator checks the run, asks the registry who owns the project's
remote, reads *locally* what there is to push — a detached head, the
project's default branch and a branch the remote already holds in full are
each said, not pushed — and hands the transfer over: the forge pushes as
its own app and opens the pull request only when the branch has none.
Served always, erroring plainly where the project has no forge. And every
external boundary is now crossed by using the forge (ruled 2026-10-02):
the `Forge` interface gains `fetchBranch`, and the worktree machinery took
out its raw `git fetch origin` — with a forge it receives that fetch
injected, without one the worktree starts from refs the clone already
holds.
