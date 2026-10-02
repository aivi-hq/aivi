---
'@aivi/core': minor
'@aivi/knowledge': patch
'@aivi/host': patch
---

**Knowledge search is on by default.** The `search` block now defaults to
`{provider: "qmd", indexOnStart: true, maxPending: 32}`: an install that
never mentions it searches, and `search: false` is the only off switch.
Before this, a missing block meant every `knowledge_search` answered
"Knowledge search is not enabled" — a silent no-search install, which the
operator just lived through.
