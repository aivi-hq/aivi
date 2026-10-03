---
'@aivi/core': patch
'@aivi/cli': patch
'@aivi/tracker-linear': patch
---

**The last biome diagnostics are cleared.** The leftovers of the
dead-code sweep (unused imports and bindings, `['aivi-plugins']` written
as a computed key, string concatenation where a template belongs,
`!x || x.state !== …` where `x?.state !== …` says it) are fixed, and
`biome check .` reports nothing. The `ProjectEntry` alias, the write-only
`config`/`clients` members on `LinearPlatform`, the unread `lane` in the
webhook handler, and the unused `expire` argument were dead weight; the
`aivi configure` output is byte-identical.
