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
{ "search": { "provider": "qmd", "indexOnStart": true } }
```

QMD is a pinned dependency of the knowledge package, imported statically; a missing
or broken install stops aivi from starting. Disabling search leaves the rest of aivi
usable.

Retrieval has two gears, and the public SDK is the boundary either way — aivi
never queries QMD's private database tables:

- **Keyword (BM25)** answers from the first boot, no models needed.
- **Semantic** — query expansion, vector retrieval, and LLM reranking fused —
  serves once the three local GGUF models sit in QMD's cache. `aivi knowledge
  warm` fetches and loads them (configurable via `search.models`; qmd's own
  defaults when unset). Searches never wait on a download: while any model is
  missing, keyword answers alone, and a semantic failure answers with keyword
  hits and says so once in the log.

Embedding rides the index scan only when the embed model is already on disk,
so boot never stalls on a download. Switching `search.models.embed` means
re-embedding: vectors are not cross-model; run `aivi knowledge warm` again.

## Kinds

Every source declares what it contains, from a registry in
`packages/core/src/kinds.ts`:

| kind | meaning |
| --- | --- |
| `doc` (default) | Reference material: handbooks, guides, research notes |
| `decision` | Recorded decisions (ADRs); authoritative on why |
| `memory` | Facts and proposals distilled by [dreaming](dreaming.md); dated, attributed, softer |
| `conversation` | Indexed transcripts; useful for details, never authoritative (reserved) |
| `manual` | Docs shipped by installed packages (`<package>/docs/`), indexed in place: the assistant knows the manuals of what is installed ([self-knowledge](plans/templates/self-knowledge.md)) |
| `archive` | How things used to be: each memory home's `archive.md`, where dreaming moves superseded facts. Dated, kept as history, never authoritative for the present |

Hits carry `kind`, `scope`, and `projectId`, so an answer can say what kind of
material it rests on. `knowledge_search`, `/knowledge/search?kind=…`, and
`/sources?kind=…` accept a kind filter (the `aivi knowledge sources` CLI does
not yet). The assistant's agent file explains the
kinds to the model; adding a kind means one entry in the registry.

## Use it

`aivi knowledge search QUERY [--project ID … | --core-only] [--no-core] [--limit N]`
sends the query to the running host ([getting started](getting-started.md)).
In OpenCode, the plugin exposes `knowledge_search` with `query`, optional
`projects`, `includeCore`, `kinds`, and `limit`. Discord's `/search query [project]`
and Slack's `/<prefix>-search` call the service directly without starting a
model turn. The assistant can also use the native tool while answering normal
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
where applicable, original file path, title, excerpt, and score. A hit names the
file, never a line inside it. Scope is retrieval selection, not a multi-tenant
access boundary.

## Refresh and scheduling

The default refresh happens on startup. Examples also schedule an hourly
`knowledge.index` task in a dispatcher pool. Request a refresh now:

```sh
npm run aivi:cli -- knowledge index
```

Fetch and load the semantic models once per machine (downloads what
`search.models` names, embeds the corpus, warms expansion and rerank):

```sh
npm run aivi:cli -- knowledge warm
```

It opens the same QMD database the way `knowledge index` does — a short-lived
visitor beside the host — and is the setup step: semantic search serves after
it, keyword-only before it. Rerun it after changing the embed model.

That queues a job; the host executes it against the same service. Searches
run concurrently: QMD reads are synchronous SQLite on a WAL database, which
the database itself serializes at millisecond granularity. Indexing owns its
own lock — one scan runs, and a caller arriving mid-scan only indicates
another sync is wanted: a re-scan follows detached, so files written
mid-scan still land while the caller is already on its way. Dreaming and
projects-sync indicate a sync the same way; the job scheduler schedules and
never dedupes their work. Keyword search does not acquire an inference
slot, so an assistant holding a model slot can search without deadlocking
itself. Semantic search will need explicit model-resource accounting.

Updates/deletions appear after refresh. Excerpts represent the indexed version,
so edits since refresh can leave stale excerpts. Already-deleted paths are omitted.
The rebuildable index is separate from durable job/session metadata.

## Follow-up work

Conversation export, embeddings, reranking, and model configuration extend this
service later. They will not require one memory server per integration.

Tests use the real SDK to index temporary core/project documents, retrieve scoped
hits, preserve filenames, and refresh changes/deletions, without model downloads.
See the upstream [QMD repository](https://github.com/tobi/qmd).
