---
'@aivi/tracker-github': major
'@aivi/github': major
---

**The board answers in types, not `any`.** The GraphQL node shapes
(project V2 boards, fields, options, items, issues) are declared once in
the client and shared with setup-project, which reads the same board —
the looseness stays in the query documents, the mapping code speaks
types. `pool` names replace `resource` on the tracker's own block, and
the module claims capacity through `poolCapacities` like every other
service.
