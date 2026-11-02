---
'@aivi/host': patch
'@aivi/opencode': patch
'@aivi/plugin': patch
---

The pinned `@opencode/*` family moved to 2.2.5. Nothing in aivi changed: the same endpoints under the same discovery rules — the releases between added routes (the `server.worktree` group, among others), none moved — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.
