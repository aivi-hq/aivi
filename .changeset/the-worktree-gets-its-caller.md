---
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**The worktree gets its caller.** `initWork` now answers with a
**work entry** — the summary plus the ticket's **branch name** where the
platform names one (Linear's `Issue.branchName`). A `worktree: true` lane
gets its own git worktree on that branch before the session opens: made
by the orchestrator with the forge's `fetchBranch` **injected** when a
forge owns the remote (local refs otherwise), and the worker session is
created **in** it. A lane that wants a worktree whose tracker named no
branch fails the run visibly — no invented names. The worktree mark gains
the wall: an empty `credential.helper` and `core.sshCommand=false`, so
boundary git that slips past the tools has no credential to spend.
