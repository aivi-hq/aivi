# @aivi/knowledge

QMD-backed document indexing and scoped keyword search. Indexes core and
per-project sources; scope never widens on unknown IDs.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/knowledge` | `createKnowledgeService` — builds the index from configured sources, answers scoped searches |

## How it works

Uses `@tobilu/qmd` (optional dependency) to build and query a full-text
index over Markdown sources. Each source belongs to a kind (`doc`,
`decision`, `memory`, `conversation`) and a project scope. A search names
projects explicitly or searches core; it never silently broadens.

## Docs

[knowledge](../../docs/knowledge.md) ·
[projects](../../docs/projects.md)
