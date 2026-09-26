---
"@aivi/host": patch
"@aivi/opencode": patch
---

The pinned `@opencode/*` family moved to 2.0.18. Nothing in aivi changed: the same endpoints under the same discovery rules — a server that answers HTTP on its registered endpoint is alive whatever its version, and version skew is logged, never fatal.
