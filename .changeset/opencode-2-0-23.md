---
'@aivi/host': patch
'@aivi/opencode': patch
'@aivi/plugin': patch
---

The pinned `@opencode/*` family moved to 2.0.23. Nothing in aivi changed: the same endpoints under the same discovery rules — the release only added routes (`/api/credential`, `/api/vcs/init`), none moved — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.
