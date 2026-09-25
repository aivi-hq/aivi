# Knowledge search

The host owns one QMD 2.8.3 SDK store. Authoritative documents remain in their
configured core/project paths; the derived index lives in `<state>/knowledge/`.
Each source maps to a separate collection. Directories index Markdown recursively;
a source pointing to one file indexes only that file. A file belongs to the most
specific source that contains it: a directory source ignores every source nested
inside it, so `docs/adr` as `decision` inside `docs` as `doc` indexes each ADR
once ([projects](projects.md)). A source whose path does not exist is skipped
with a `knowledge.missing` warning; `memory` sources are created, since aivi
owns them.

```json
{ "search": { "provider": "qmd", "indexOnStart": true, "maxPending": 32 } }
```

QMD is a pinned dependency of the knowledge package, imported statically; a missing
or broken install stops aivi from starting. Disabling search leaves the rest of aivi
usable.
This release calls QMD's `searchLex` API: keyword/BM25 retrieval, with no embedding,
reranking, or query-expansion model loaded. The public SDK is the boundary; aivi
does not query QMD's private database tables.

## Kinds

Every source declares what it contains, from a registry in
`packages/core/src/kinds.ts`:

| kind | meaning |
| --- | --- |
| `doc` (default) | Reference material: handbooks, guides, research notes |
| `decision` | Recorded decisions (ADRs); authoritative on why |
| `memory` | Facts and proposals distilled by [dreaming](dreaming.md); dated, attributed, softer |
| `conversation` | Indexed transcripts; useful for details, never authoritative (reserved) |

Hits carry `kind`, `scope`, and `projectId`, so an answer can say what kind of
material it rests on. `knowledge_search`, `/knowledge/search?kind=…`, and
`/sources?kind=…` accept a kind filter (the `aivi sources` CLI does not yet). The librarian's agent file explains the
kinds to the model; adding a kind means one entry in the registry.

## Use it

`aivi knowledge search QUERY [--project ID … | --core-only] [--no-core] [--limit N]`
sends the query to the running host ([getting started](getting-started.md)).
In OpenCode, the plugin exposes `knowledge_search` with `query`, optional
`projects`, `includeCore`, `kinds`, and `limit`. Discord's `/search query [project]`
and Slack's `/<prefix>-search` call the service directly without starting a
model turn. The librarian can also use the native tool while answering normal
conversations.

| Selection | Meaning |
| --- | --- |
| Omit `projects` | All configured project and core sources |
| `projects: []` | Core sources only |
| `projects: ["demo"]` | That project plus core |
| `projects: ["demo"], includeCore: false` | That project only |
| Multiple project IDs | Those projects, plus core unless disabled |

Unknown IDs fail. An empty source selection returns nothing rather than an
unscoped query. Filters are passed to QMD before retrieval; returned collections
and file paths are also checked. Results contain source ID, scope, project ID
where applicable, original file path, title, excerpt, line, and score. Scope is
retrieval selection, not a multi-tenant access boundary.

## Refresh and scheduling

The default refresh happens on startup. Examples also schedule an hourly
`knowledge.index` task in the `maintenance` resource pool. Request a refresh now:

```sh
npm run aivi -- knowledge index
```

That queues a job; the host executes it against the same service. Search and
indexing serialize through one bounded queue, so a large refresh delays searches
behind it (the plugin's client gives up after 10 s). Sources are small today;
letting searches run concurrently and only queue behind `index()` is planned
work, not a knob. Keyword search does not acquire
another inference slot, so a librarian holding a model slot can search without
deadlocking itself. Semantic search will need explicit model-resource accounting.

Updates/deletions appear after refresh. Excerpts represent the indexed version,
so edits since refresh can leave stale excerpts. Already-deleted paths are omitted.
The rebuildable index is separate from durable job/session metadata.

## Follow-up work

Conversation export, embeddings, reranking, and model configuration extend this
service later; see [roadmap](roadmap.md). They will not require one memory
server per integration.

Tests use the real SDK to index temporary core/project documents, retrieve scoped
hits, preserve filenames, and refresh changes/deletions, without model downloads.
See the upstream [QMD repository](https://github.com/tobi/qmd).
