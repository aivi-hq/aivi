---
'@aivi/core': patch
'@aivi/host': patch
---

Pool models now speak OpenCode's own spelling: `provider/model#variant`,
parsed by OpenCode's own `Ref.parse` — the same one the agent-file
frontmatter goes through. The dispatcher had a homegrown parser splitting
the variant on `@`, a spelling nobody speaks: `provider/model#high` rode
into the wire with `#high` glued inside the model id, and OpenCode
answered `Model unavailable` (live, 2026-10-06) while the config looked
right. The startup gate stays — a pool model that is no model reference
is said at startup, never at a grant — now spoken by the parser that
also answers the frontmatter.
