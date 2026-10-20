# Knowledge & dreaming: review notes (2026-10-20)

Working file for the pre-release review of the knowledge pipeline: verified
facts, operator rulings, and the fix list. Nothing built yet — the staleness
loop (§D) is an explicit design discussion.

## Verified facts (read from code, 2026-10-20)

- Retrieval path: `knowledge_search` → host API → `store.searchLex` → QMD
  `searchFTS` → SQLite FTS5 `bm25()`. Pure keyword. QMD itself ships the
  good stuff (hybrid `search()`: query expansion + BM25 + vector + rerank,
  node-llama-cpp bundled; separate `store.embed()` step) — aivi wires
  neither, and git history shows it never did. Any reranker testing was
  QMD's own CLI, not aivi's path.
- `aivi knowledge index` (= QMD `update()`) is file-scan + FTS writes only:
  no LLM, no model, incremental (unchanged files skipped).
- One promise chain serializes ALL knowledge ops, search and index alike
  (`packages/knowledge/src/index.ts`, `run`). It exists for ONE QMD store
  handle, not model capacity. Search itself is milliseconds; a search that
  arrives DURING an index pass waits behind the whole file scan, and the
  plugin tool gives up at 10 s.
- Dreaming's default review list (`origins: []`) = the registered CHANNEL
  MODULE ids (`channels.ids()`, `packages/host/src/channel/router.ts:30`) —
  `discord`, `slack`. Who gets stamped what:
  - channel turns → platform id (`discord`, `slack`) → reviewed
  - Discord voice rooms → `discord` (room id is `DISCORD.id`) → reviewed
  - Meet rooms → `meet` (a plugin, not a channel module) → NOT reviewed
  - job prompt runs → `job` → not reviewed (correct: tasks, not conversations)
  - dreaming runs → `dreaming` → not reviewed by default
  - direct OpenCode sessions and worker sessions → no aivi metadata →
    never reviewed
- `<state>/dreaming/<runId>.md` is the dreamer's INPUT: the conversations
  since last run, rendered per session (`**user** <when>` + text,
  `**<agent>** <when>` + text). Facts are the dreamer's OUTPUT into
  facts.md; that is how conclusions reach knowledge (facts.md is an
  always-indexed `memory` source). The OpenCode sessions hold everything
  the file holds — it is convenience input, kept today forever, deleted never.
- Memory homes: org `<home>/memory` (dreaming arg `memoryDirectory`) plus
  each project's `<home>/projects/<id>/memory`. Each home = `facts.md` +
  `proposals/`. Session rules allow writes to exactly those files in
  exactly those dirs; permission prompts auto-reject.
- Supersede today (dreamer soul): old bullet stays struck through with a
  date, new bullet below. Never deleted.
- Dispatcher middle road ALREADY EXISTS for ticket work:
  `dispatcher.provide(leaseId, {agent, directory})` creates the session
  with the pool's model (`dispatcher.ts:395`), and the prompt comes LATER —
  worktree prep, tracker + forge gathering all happen while the slot is
  held. The job path does NOT use it: `store.claim` checks capacity only,
  then `runPrompt` creates a bare session (agent + directory, no model).
- Request diary: one `requests` row per arriving HTTP request, body capped
  32 KiB, credentials recorded as `[present]` only. `store.clearRequests`
  exists but only a manual CLI calls it — the seeded retention job
  (`runs.prune`) never touches diary rows. They grow with traffic.
- Log file (`<state>/logs/aivi.log`) rotates. `store.prune` deletes runs,
  audit rows, done one-off jobs, expired link codes — DB only, never files.

## Operator rulings (this conversation)

1. No multi-tenant secrecy needed now. "Scope = retrieval selection, not
   an access boundary" is the accepted state; person boundaries get
   permission gates LATER, not in this release.
2. Facts stay markdown files. Per-person layouts (`<home>/persons/<id>/…`)
   allowed if they earn their keep. (Thinking aloud, not instruction.)
3. Superseded content must NOT sit in active docs. No struck-through
   bullets, no "used to be X", no dated decision trail in code comments —
   `(ruled 2026-10-13)` style notes are NOT acceptable. Decisions go in
   ADRs or nowhere; not every choice needs documenting; git history is
   the trail for everything else. History of facts belongs in an ARCHIVE
   collection that stays searchable as clearly-historical.
4. Embeddings + rerank are genuinely unbuilt → they go on the build list.
5. Jobs must adopt the pool's model like everything else. Middle road, as
   the dispatcher already does for ticket work: claim the slot FIRST,
   prepare the session (pool decides model) WITHOUT the prompt, and compose
   the prompt later (worktree/tracker/forge gathering proves the prompt
   often must wait while capacity is held).
6. Staleness intelligence wanted — clean data is everything. Long-unused
   data is suspect (unimportant or wrong); check some facts periodically,
   maybe ask an operator about one or two stale ones after a while.
   DESIGN DISCUSSION PENDING (§D).
7. Hit tracing wanted: record when a knowledge hit is served, so hot vs
   cold information is knowable. Facts need metadata (count, age); at
   volume facts.md becomes several files or a database — keep in mind,
   not for now.
8. Dreaming must not review dreaming (feedback loop). Default already
   avoids it (origins = channel modules); make it impossible, not just
   defaulted-off.
9. Jobs are not reviewed — correct as-is, they are tasks, not
   fact-sources.
10. The transcript file is disposable: the OpenCode session is the real
    input (metadata lives there). Keep the markdown only as dreaming's
    convenience input, DELETE it after the run, and prefer dreaming
    PER SESSION over one giant all-sessions file. (Design note.)
11. Search is supposed to be milliseconds; if anything waits ~10 s, the
    bug is queue position (a search behind an index pass), not slow
    search. The concurrency fix removes that failure mode.
12. Meetings join dreaming (origins), not a separate minutes pipeline.
    The durable-vs-upcoming call is the dreamer's judgment from context
    (who, where, what), not a rule keyed on the source.
13. Motivation has a place — in ADRs with a status, searchable as
    `decision` kind — not in code comments. Code comments state only
    what must be true. No separate `motivation` kind unless motivation
    without a decision actually shows up.
14. Permissions are configuration, not a listener. OpenCode defaults to
    allow; ask fires only on protected paths (external dirs, .env). An
    unattended run must deny or explicitly allow those in its permission
    rules. Answering prompts from code is a fallback for a question nobody
    configured — never the design. Policy lives in the agent file.
15. Recorded decisions are input, never a veto. Consider them always;
    raise one only when it conflicts with what the human is saying, and
    raise it as a question: "this earlier decision says X — do we change
    it, or rethink the current approach?" (AGENTS.md updated to match.)

## Fix list

### A. Facts: archive instead of strikethrough (+ loop guard) — BUILT 2026-10-20
- New `archive` kind in the registry ("how things used to be… never
  authoritative for the present"); automatic source `<memory>/archive.md`
  per memory home (org + each project), id `archive` reserved from config
  like `memory`. Knowledge service touches the file at survey so it
  indexes from the start; dreaming grants the dreamer `archive.md` writes.
- Dreamer soul rewritten: facts.md = current truth only; superseded
  wording MOVES to archive.md (dated, says what replaced it); no
  struck-through text, no "used to be". Plus the durable-vs-upcoming
  judgment: plans are phrased as plans and retire to the archive when
  they harden into decisions.
- Origins: `dreaming` rejected at schema level — dreaming never reviews
  its own runs. Default origins = channel modules + voice room platforms
  (`voice.origins()`), so Meet and Discord-voice conversations are
  reviewed once a room has spoken.
- Transcript: a succeeded run DELETES `<state>/dreaming/<runId>.md` (the
  OpenCode sessions are the record); a failed run keeps it for the
  post-mortem. No forever-accumulation.
- NOT built (deferred by ruling): per-session dreaming; fact inventory
  metadata (§F); staleness loop (§D).

### Queue — BUILT 2026-10-20
- The knowledge package's promise chain (born in the first commit, no
  recorded reason) is gone. Searches run free: QMD reads are synchronous
  SQLite on WAL, the database serializes them in ms by itself.
- Indexing owns its own lock: one scan runs; a caller arriving mid-scan
  only indicates another sync is wanted → one detached re-scan follows,
  so files written mid-scan still land while the caller is already on its
  way. Dreaming and projects-sync indicate and move on. The job scheduler
  schedules and never dedupes.
- `search.maxPending` removed from the schema (it only sized the chain).

### E. Retention gaps — BUILT 2026-10-20
- `runs.prune` (the seeded retention job) now also sweeps the request
  diary (`clearRequests` on the same cutoff). Diary-vs-separate-db stays
  deferred until real traffic says so.

### B. Knowledge service — semantic BUILT 2026-10-21; per-session dreaming still open
- Built: the index scan embeds when the embed model is on disk; `search()` runs
  expansion + vectors + reranking when all three models are cached, with
  keyword fallback on any miss or failure (searches never wait on a download).
  `search.models.{embed,rerank,generate}` configures the GGUF URIs (qmd
  defaults when unset); `aivi knowledge warm` is the setup step that fetches,
  embeds and loads. The 10 s plugin timeout stands: warm models answer
  sub-second; cold starts are warm's job, not the timeout's.
- Still open: dreaming per session (ruling 10): one dreamer turn per session
  instead of one turn per batch — cheaper reconciliation per turn, finer
  cursor; read-before-write keeps facts consistent across turns.

### C. Jobs adopt pool models via the dispatcher middle road — BUILT 2026-10-21
- Job path (prompt tasks, dreaming included): request a lease →
  `dispatcher.provide()` (pool decides model at session create) → compose
  prompt whenever the work is ready → prompt → release. Same shape ticket
  work uses; `runPrompt`'s bare-session create is gone. Built as the full
  unification: one ledger (`dispatcher_leases`), one lease kind (session),
  the store's capacity ledger deleted.

### D. Staleness & verification loop — DESIGN PENDING
- Suspect signals: age, never-hit (needs §F traces first), contradictions
  from newer conversations. Cadence idea: a handful of facts/day audited;
  oldest-unsure ones proposed to an operator's channel one or two at a
  time. Needs somewhere to record "checked <date>: confirmed/retired" →
  argues for fact metadata (§F) first.

### F. Fact inventory & hit traces — still open
- Hit trace: one row per served hit (source path, kind, query, when);
  hot/cold becomes a query; retention prunes it.
- Fact metadata: bullets need stable ids + dates machine-readable enough
  to count, age, page facts.md, and feed §D. At volume: several files per
  home or a store — keep in mind, not now.

### G. Decision & motivation doctrine (ruling 3, discussed 2026-10-20)
The problem is not writing the why down — it is WHERE. A dated note inside
code reads as binding precedent forever (AGENTS.md literally says recorded
decisions win), which is exactly the "silly thing taken as law, never
reconsidered" failure the operator named. Doctrine:
- **Code comments carry constraints only**: what must be true, no dates,
  no `(ruled …)` references, no motivation. 100 hits in `packages/*/src`
  alone (62 files counting tests/scripts/docs) get swept: keep the
  constraint as a plain undated sentence, drop the trail — git blame is
  the trail.
- **The why lives in ADRs** (`docs/adr/`), few and load-bearing, each
  with a status (`accepted` / `superseded by NNNN`). The kinds registry
  already has their home: `decision` = "Authoritative for why something
  is the way it is; cite them over inference." So "why do we do X" is a
  `knowledge_search` with `kinds: ["decision"]` — no new kind needed
  unless motivation-without-a-decision actually appears (adding one is a
  one-line registry entry).
- ADRs are revisable by the operator and citable by the agent — evidence
  for judgment, not frozen law. Which current decisions qualify as ADRs
  is the operator's call.
- Live docs (docs/*.md, READMEs) swept the same way as code comments.
  `docs/plans/*` and `docs/research/*` stay: dated artifacts of their
  work rounds, i.e. legitimately history.

## Test checklist for the knowledge round (before any of the above)

1. `aivi knowledge index` + `search` against real docs; scope matrix
   (core / project / multi-project / kind filters) via CLI and `/search`.
2. A `prompt` job and a dreaming run end-to-end on the pool system;
   `aivi runs show` points at the session.
3. Dreaming: real conversation in a linked channel → run → facts.md
   bullets, `changed` list, index refresh, cursor advance; then a
   CONTRADICTION in a later conversation → reconcile behavior observed.
4. `system.check` reports source availability; retention run prunes runs.
5. Direct-OpenCode conversation → confirm NOT reviewed (coverage decision).
   Meet room conversation → confirm IS reviewed (room platforms are default
   origins now); a `dreaming` origin → config refuses it.

## Open — raised 2026-10-21, operator rejected both current fixes

**Problem 1: model-cache containment. DECIDED: no containment.** The
`XDG_CACHE_HOME` import trick is fully reverted. Models live in qmd's own
default cache (`~/.cache/qmd/models`, or the operator's own `XDG_CACHE_HOME`).
The clean upstream fix would be qmd passing its internal `modelCacheDir`
(llm.js:509) through the SDK `createStore` options; that is an upstream
conversation, not an aivi workaround.

**Problem 2: the node-llama-cpp override.** The Metal error on this M5 Max is
upstream: llama.cpp #27473 (tensor-API probe compiled at too-old Metal
language version). qmd 2.8.3 pins node-llama-cpp 3.20.0 (llama.cpp b10361,
predates the fix). node-llama-cpp 3.21.0 fixed it ("Metal 4 tensor API issues
on M5 mac machines"). The built round adds a root npm override to 3.21.1 —
the operator calls it a workaround, and the honest weaknesses: qmd pinned
3.20.0 exactly; our test gates never exercise the native binding (real-QMD
tests are keyword-only); the only proof is one live semantic run. Options:
keep the override as a recorded decision after real verification against
qmd's usage; or stay on 3.20.0 (search works, ~2 s queries, tensor API
disabled); or wait for qmd to bump.

Until decided: the semantic round stays UNCOMMITTED; the override can be
dropped without touching anything else (3.20.0 ran the same proof).

## Follow-ups deferred until the schema settles

- **Fold migrations into one v1 schema.** No live installs, so no
  compatibility is owed. When the schema is final for the v1 release, delete
  the migration steps and make a fresh database get the final shape at
  version 1 (store and channel namespaces). Keep one real upgrade test only
  if some install survives the cut; otherwise test the fresh shape alone.
