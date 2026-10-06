---
'@aivi/cli': patch
---

Worker agent files enforce their permissions again. The `description:`
frontmatter in `assistant.md`, `dev.md`, `product.md` and `review.md` held
unquoted text containing `: ` — invalid YAML — and OpenCode enforced none of
such an agent's permissions (verified 2026-10-06: a product agent whose file
denied `edit` wrote straight through the deny; quoting the description made
the deny bite). Descriptions are quoted now. `dreamer.md` was always valid.
