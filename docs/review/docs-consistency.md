# Documentation consistency review

Scope: `README.md`, `AGENTS.md`, `docs/*.md` (not `backlog/`, `review/`),
`examples/**/*.md`, cross-checked against `packages/*/src`, `examples/*.json`,
`examples/**/opencode.jsonc`, `schemas/`, `package.json`. Read-only review;
nothing else was changed. Dated 2026-09-14.

Legend for section 1: **file:line → claim → reality → fix**.

## 1. Contradictions (docs vs docs, docs vs code)

### Node version

- `AGENTS.md:19` → "Use Node 24" → `package.json:10` `engines.node ">=26.0.0 <27"`; `README.md:11` and `docs/architecture.md:134` say Node 26 → change to "Use Node 26 (see `engines` in `package.json`)".

### Tool names (`knowledge.search` vs `knowledge_search`)

The plugin registers namespaces `knowledge`, `aivi`, `browser` with tools
`search`, `status`, `sources`, `control` (`packages/opencode/src/index.ts:58-113`).
Effective tool IDs are `knowledge_search`, `aivi_status`, `aivi_sources`,
`browser_control`; codemode form is `tools.knowledge.search()`. Permission actions
also use the underscore IDs (`packages/discord/src/native.ts:32-34`,
`packages/host/src/dreaming.ts:197`). Docs mix both forms:

- `docs/application.md:35` → "`knowledge.search` reaches the same service" → ID is `knowledge_search` → use `knowledge_search`.
- `docs/knowledge.md:54` → "the plugin exposes `knowledge.search` with `query`, optional `projects`, `includeCore`, and `limit`" → ID is `knowledge_search`, and `kinds` is also an argument (`opencode/src/index.ts:42-46,74`) → "`knowledge_search` with `query`, `projects`, `includeCore`, `kinds`, `limit`".
- `docs/browser.md:35` and `:69` → "`browser.control`" → ID is `browser_control` (`docs/opencode.md:22,78` already say so) → rename both.
- Rule: use the underscore IDs everywhere; mention the codemode dotted form once, in `docs/opencode.md:22` (already there).

### Discord behaviour

- `docs/discord.md:152-153` → "No … typing/streaming UI … is included" → typing indicator is implemented (`packages/discord/src/module.ts:108-125`) and claimed at `docs/discord.md:45` and `README.md:68` → delete "typing/" from line 153; keep "no streaming".
- `docs/discord.md:146-147` → "web/browser tools are future additions" → `webfetch` and `websearch` are allowed (`native.ts:30-31`), browser is denied; `docs/discord.md:37` already says web fetch/search are allowed → rewrite: "web fetch/search are allowed; browser stays denied".
- `docs/discord.md:143-147` duplicates `:36-40` (permission policy) with a different tool list → delete `:143-147`, keep `:36-40`.
- `docs/discord.md:96` → "By default, guild messages must mention the bot" → the default `trigger` is `mention-to-start` (`core/src/config.ts:229`) and any trigger other than `mention` fails validation without `messageContent: true` (`discord/src/config.ts:27-33`). The "default" is therefore not runnable without the intent → "Channel entries default to `mention-to-start`, which requires `messageContent: true`; set `trigger: "mention"` to run without the Message Content intent."
- `examples/discord.json:11-16,19` → channel entry without `trigger`, `messageContent: false` → fails `loadDiscordConfig` (`discord/src/config.ts:27`); `docs/discord.md:85` (`config check`) and `README.md:39-41` tell newcomers to use it → set `"trigger": "mention"` on the example channel (already noted in `docs/review/adapters-and-plugin.md`).
- `docs/discord.md:46` → "Attachments are not downloaded or silently omitted" (ambiguous) → the bot replies "Text messages only for now; paste the relevant text." (`module.ts:160-162`) → "Messages with attachments or no text get a 'text only' reply."
- `docs/discord.md:154` → "Host scheduled-task completion remains operator-confirmed" → `opencode.prompt` jobs verify a final answer via `runTurn` (`host/src/session.ts:71-138`, `runtime.ts:112-131`); only blocked jobs need an operator → "Both jobs and Discord turns use the same verified-final-answer driver; only blocked work needs an operator."
- `docs/discord.md:137` → "duplicate host hosts" → typo → "duplicate hosts".
- `docs/discord.md:100` → link `https://docs.discord.com/developers/host/you-might-not-need-a-privileged-intent` → path looks wrong (`/developers/host/`); could not verify offline → check and fix the URL.
- `docs/discord.md:11-13` → "a top-level message addressing aivi opens a thread named after it" → thread name is the first non-empty line, truncated to 80 chars (`module.ts:57-61`) → "named after its first line".

### Discord live verification status (pick one truth)

- `README.md:61,68` → header "Working and verified … on the target Mac" with bullet "Discord live: DMs and channels … typing indicator, slash commands, job reports".
- `README.md:73` → "Discord module (built and unit-tested; live verification still open)".
- `docs/discord.md:93-94` → "No live Discord registration was performed during development".
- `docs/discord.md:159-160`, `docs/architecture.md:118-119`, `docs/architecture.md:141`, `docs/implementation-roadmap.md:4` → live Discord validation outstanding.
- Fix: decide, then state it once (README Status) and delete the other four sentences. If verified, `README.md:73` becomes "Browser control service (built and unit-tested; live Chrome verification open)".

### OpenCode connection

- `docs/opencode.md:15,44`, `docs/configuration.md:22`, `docs/architecture.md:125-127`, `docs/application.md:52-53`, `packages/host/src/opencode.ts:18-39` all agree: discovery by default, `opencode.url` + `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` as override. No doc mentions `OPENCODE_TOKEN`. Consistent; no change.
- `docs/opencode.md:18` → "This is what the Discord adapter's `finalAnswer` checks" → `finalAnswer` lives in `host/src/session.ts:145` and serves jobs, dreaming and Discord → "This is what the host's `finalAnswer` checks."
- `docs/opencode.md:55-60` → session driver description omits that `opencode.prompt` jobs apply **no** session-level permission rules (`runtime.ts:112-130` passes no `permissions`; Discord and dreaming do) → add "The job agent's own frontmatter is its only permission boundary."

### Auth (`AIVI_TOKEN` vs `mode: none`)

- `README.md:19-20`, `docs/configuration.md:21,94-97`, `docs/opencode.md:30-32`, `docs/architecture.md:97-98`, `host/src/server.ts:12-21,44-50` agree. Consistent.
- `docs/knowledge.md:38` → "With `AIVI_TOKEN` supplied by fnox:" → omits the `mode: "none"` alternative every other page gives → "With `AIVI_TOKEN` set (or `host.auth.mode: "none"`):".
- `docs/application.md:44-45` → `aivi tick` "no API, no modules" → correct; also runs with auth `none` (`cli.ts:205-207`) → add "(no token needed)".

### `.env` locations

Code (`packages/app/src/cli.ts:66-72`): `AIVI_ENV_FILE` if set, else `.env` next to the config, then `~/.aivi/.env`; existing environment wins.

- `README.md:39` → ".env next to the config" (one of three).
- `README.md:69` → "`.env` secrets (`~/.aivi/.env`)" (another one).
- `docs/discord.md:69` → ".env next to `aivi.json`".
- `docs/configuration.md:94-99` → talks about `AIVI_TOKEN` and fnox, never mentions `.env` or `AIVI_ENV_FILE` at all.
- Fix: one sentence in `docs/configuration.md` "Secrets" (new subsection): "Loaded without overriding the environment: `AIVI_ENV_FILE`, else `.env` beside the config, then `~/.aivi/.env`." Point README/discord at it.

### Reporting

- `docs/configuration.md:43-50`, `README.md:69`, `docs/discord.md:75-76`, `docs/dreaming.md:64`, `host/src/destinations.ts`, `discord/src/module.ts:279-288` agree. Consistent.
- `docs/application.md:18-20` → HostServices list omits `destinations` (`host/src/application.ts:22`) → add "a `destinations` registry for `report.to`".

### Dreaming

- `docs/architecture.md:112-113` (Deferred work) → "Dreaming: review recent conversation deltas…" → implemented (`host/src/dreaming.ts`, `docs/dreaming.md`, `README.md:70`) → delete the bullet.
- `docs/knowledge.md:93` → "Conversation export, embeddings, reranking, model configuration, and dreaming extend this service later" → dreaming is done → drop "and dreaming".
- `docs/dreaming.md:22-23` → "Everything else is read-only; shell and subagents are denied" → actual policy is deny-all then allow `read/glob/grep/execute/knowledge_search/aivi_sources` (`dreaming.ts:195-207`) → "deny-all, then read/glob/grep, Code Mode and the aivi tools".
- `docs/architecture.md:129-130` → origins "`discord`, `job`, later `linear`" → dreaming sessions carry `origin: "dreaming"` (`dreaming.ts:209`) → add `dreaming`.
- `examples/librarian/.opencode/agents/dreamer.md:14` → "Once a day" → cron is configuration (`examples/aivi.json:54`) → "On each dreaming run".

### Kinds

- `README.md:75-77` → "Not yet built: Knowledge `kind` labels (doc, decision, memory, conversation) and people" → kinds are built end to end (`core/src/kinds.ts`, `config.ts:14`, `contracts.ts:46,50`, `server.ts:109-114`, `opencode/src/index.ts:42-46`, `schemas/aivi.schema.json:99-107`, `docs/knowledge.md:19-34`) → delete kinds from the list; keep "people".
- `docs/knowledge.md:33` → "`aivi sources` accept a kind filter" → the CLI `sources` command only takes `--project` (`cli.ts:21,92-93`); `knowledge search` has no `--kind` either → either add `--kind` to the CLI or change to "the `/v1/sources?kind=` endpoint accepts a kind filter".
- `examples/project/docs/adr/0001-knowledge.md:5` → "future search indexes will be rebuildable derivatives" → they exist → "search indexes are rebuildable derivatives".
- `examples/librarian/.opencode/agents/librarian.md:45-46` → "Conversation retrieval and durable-memory tools are not implemented yet" → durable memory is searchable through the `memory` kind (`examples/aivi.json:13-17`); conversation retrieval is not → "Conversation retrieval is not implemented yet; memory is a `memory`-kind source."

### `Status.mode` / `completion`

- No doc and no code has a `Status.mode` field. `Status` is `{version, counts, sources, leases, completion}` with `completion` a hard-coded `'verified-final-answer'` (`core/src/contracts.ts:24-30`, `host/src/server.ts:23-31`). No doc describes the status payload at all. Either document it in `docs/opencode.md` (one line under "Tool invocation") or drop the constant (see `docs/review/host-core-app.md` S5). Nothing to correct in prose.

### Job states and `jobs resolve`

- `docs/architecture.md:54-55,66-68`, `docs/configuration.md:88-92`, `docs/opencode.md:62-71`, `core/src/contracts.ts:7`, `host/src/store.ts:377-386`, `cli.ts:191-199` agree: six states; `resolve` needs `--outcome succeeded|failed --reason --confirm-stopped`; only blocked jobs; no side effects. Consistent.
- `docs/architecture.md:28-29` → "Schema version 2 adds resource leases; version 3 adds an audit index and a `migrations` table" → `HOST_SCHEMA_VERSION = 4` (report column, `store.ts:58,104-108`) → add "version 4 adds `jobs.report`" or drop version numbers entirely.
- `docs/configuration.md:31` → schedule fields "cron/timezone/resource/task … optional `report`" → `enabled` also exists (`config.ts:96`, `schemas/aivi.schema.json:374`) → add `enabled` (default `true`).

### Package responsibilities table

Two tables describe the same packages differently: `README.md:45-53` and
`docs/application.md:8-16`. Differences vs code:

- `README.md:49` `@aivi/host` → omits session driver, dreaming, destinations (`host/src/index.ts`) → "Lifecycle, API, scheduler, SQLite store, leases, OpenCode client, session driver, dreaming, report destinations".
- `README.md:48` `@aivi/core` → omits kinds registry and access policy (`core/src/kinds.ts`, `config.ts:211`) → "Config/access schemas, kinds, contracts, logger".
- `README.md:52` `@aivi/discord` → add "slash commands, report destination".
- Keep one table (README), link from `docs/architecture.md`; delete `docs/application.md:8-16`.

### Other

- `docs/requirements.md:3` → "Research findings are recorded separately in opencode-worker-research.md" → no such file in the repo → delete the sentence.
- `docs/requirements.md:48` → "No retrieval backend has been selected yet" → QMD 2.8.3 is pinned and used (`packages/knowledge/package.json:5`) → see section 2 (treat requirements as frozen).
- `docs/architecture.md:134` → "on macOS and (CI) Linux" → no CI config in the repo (`.github/` absent) → drop "(CI) Linux" unless CI exists elsewhere.
- `docs/browser.md:108-109` → "The development environment passed the MCP handshake but had no Chrome binary; the browser download failed" → describes one past machine → "Live Chrome control on the target Mac is not yet verified; run `npm run smoke:browser` there."
- `docs/implementation-roadmap.md:5` → "No implementation or runtime validation has been performed for this roadmap" → contradicts lines 3-4 and `docs/opencode.md:7-24` → delete.

## 2. Stale or dead content

| Location | Content | Status in code | Recommendation |
| --- | --- | --- | --- |
| `README.md:59-81` "Status" | Long done/not-done list; internally contradictory on Discord (`:68` vs `:73`); kinds listed as not built (`:77`) | Kinds, dreaming, reporting, Discord module all implemented | **Rewrite** to ≤6 bullets: what works, what is live-verified, three next items; move detail to `docs/roadmap.md` |
| `README.md:55-57` | "Linear will be another in-process module…" | Not started | **Keep** one sentence; it sets the architecture direction |
| `docs/architecture.md:105-121` "Deferred work" | Dreaming (done), Discord adapter (done; live open), browser service (done) mixed with real future work | Partly implemented | **Rewrite**: remove dreaming/Discord/browser "implement" items, keep only genuinely open items, or move whole section to `docs/roadmap.md` |
| `docs/architecture.md:70-74` | Future worker cleanup / Linear Stop | Not started | **Keep**, label "not implemented" (already says so) |
| `docs/architecture.md:132-141` "Verification" | Repeats README `:83-86` and `docs/opencode.md:7-11` | – | **Merge** into README/roadmap; delete here |
| `docs/implementation-roadmap.md` (whole file) | Milestone plan "Proposed 13 September 2026" with `:5` "No implementation … performed"; M0-M3 done, M4 partially (has a status line `:76-81`), M5 built, M6-M7 not started | Out of date within a day | **Rewrite** as `docs/roadmap.md`: one status line per milestone (done / built, live open / not started) plus the "Decisions to make early" table `:119-128`; drop the "Build/Done when" prose for finished milestones |
| `docs/implementation-roadmap.md:3-4` | Two "Current architecture / Implementation update" paragraphs bolted on top | – | **Delete** once the roadmap is rewritten |
| `docs/requirements.md:3` | "Status: v0.8 … Updated 2026-09-13 … opencode-worker-research.md" | Dead reference | **Rewrite** to: "Frozen product requirements (v0.8, 2026-09-13). Implementation status: `docs/roadmap.md`." |
| `docs/requirements.md:9,11,47-48,174` | "working package name such as `@aivi/host`", "a specific build must be pinned", "No retrieval backend selected", "TypeScript and any particular database remain candidates" | All decided | **Keep** as historical requirements (it is a PRD), but the new status header must say decisions live in `architecture.md` |
| `docs/requirements.md:170-180` §9 "Research and technical design" | Instructions to do research that is done | Done | **Delete** §9 or fold the QMD model paragraph `:178` into `knowledge.md` |
| `docs/knowledge.md:91-94` "Follow-up work" | "…and dreaming extend this service later" | Dreaming done | **Rewrite** to one line without dreaming, or move to roadmap |
| `docs/dreaming.md:73-77` "Later" | Project memory, per-person memory, decay, quiet-hours schedule | Open | **Keep** (short and accurate) or move to roadmap |
| `docs/browser.md:98-110` "Verify on your machine" | Includes dev-environment anecdote `:108-110` | Anecdote stale | **Rewrite** last paragraph (see §1) |
| `docs/browser.md:112-124` "Why this backend" | OpenClaw comparison + upstream-docs caveat | Fine | **Keep**, could move to `architecture.md` |
| `docs/discord.md:141-160` "Boundaries and verification" | Duplicates policy from `:36-40`; stale on web tools, typing, task completion | Partly stale | **Rewrite** to 5 lines: what is out of scope + what tests cover + live status |
| `docs/discord.md:93-94` | "No live Discord registration was performed during development" | Unknown (see §1) | **Delete** here; state once in README |
| `docs/opencode.md:7-24` verified-boundary table | Accurate, dated | Current | **Keep**; this is the best page in the set |
| `docs/application.md` | Half duplicates `architecture.md:10-23`; half is operator lifecycle | – | **Split**: module contract → `architecture.md`; startup/shutdown/tick → `operations.md` |
| `docs/configuration.md:58-82` "Linear mapping (validation only)" | Accurate | Validation only | **Keep**, shorten to the two JSON snippets |
| `examples/memory/facts.md`, `examples/memory/proposals/README.md` | Seed files | Match `dreaming.ts:187` | **Keep** |
| `examples/knowledge/company.md` | Placeholder | – | **Keep** |

## 3. Structure proposal (≤12 files, `docs/` as future site source)

Readers: **newcomer** (install and see it work), **operator** (run it, fix
blocked work, add channels), **developer** (change it).

| Target file | Reader | Built from | Action |
| --- | --- | --- | --- |
| `README.md` | all | README `:1-41` (pitch + 5-minute try), one package table, 6-bullet status, link list | Rewrite; move everything else out |
| `AGENTS.md` | developer (agent) | AGENTS.md | Fix (see §4) |
| `docs/getting-started.md` | newcomer | README "Try it", `opencode.md:26-40` "Librarian in native chat", `knowledge.md:36-57` "Use it", `discord.md:50-101` "Setup" (short pointer) | New file by merging; no new prose |
| `docs/configuration.md` | operator | `configuration.md` + new "Secrets" (`.env` precedence) + `enabled` + CLI usage block from `cli.ts:15-41` | Keep, extend |
| `docs/operations.md` | operator | `application.md:39-56` (startup/shutdown/tick), `opencode.md:42-74` "Host submission" (jobs, blocked, resolve), `discord.md:103-139` "Queue and recovery", logs (`configuration.md:105-106`) | New file by merging |
| `docs/knowledge.md` | operator/developer | `knowledge.md` minus "Use it" and "Follow-up work" | Keep, trim |
| `docs/dreaming.md` | operator | `dreaming.md` | Keep |
| `docs/discord.md` | operator | `discord.md` Behaviour + Setup + Boundaries (rewritten); recovery moves to `operations.md` | Keep, restructure |
| `docs/browser.md` | operator | `browser.md` minus anecdote | Keep, trim |
| `docs/opencode.md` | developer | `opencode.md:1-25,76-80` verified boundary, plugin loading, tool IDs, `Status` payload, session driver contract | Keep, developer-facing |
| `docs/architecture.md` | developer | `architecture.md` minus Deferred work/Verification + `application.md:18-37,66-72` module contract (`HostServices`, `Store.migrate`, leases) | Keep, absorb |
| `docs/roadmap.md` | all | `implementation-roadmap.md` (status per milestone, early/late decisions table), README "Not yet built", `architecture.md` Deferred work, `knowledge.md` Follow-up, `dreaming.md` Later, `browser.md` follow-ups; link `docs/backlog/` | Replace `implementation-roadmap.md` |
| `docs/requirements.md` | product | unchanged body, new 2-line status header, §9 removed | Keep as frozen PRD |

Delete: `docs/application.md`, `docs/implementation-roadmap.md` (contents
merged as above). `docs/backlog/` and `docs/review/` stay as-is and are linked
from `roadmap.md` / `architecture.md`. That is 2 root files + 11 in `docs/`
(one over the limit only if `requirements.md` counts; drop `requirements.md`
into `docs/backlog/` if the cap is strict).

Style rules for the rewrite: one source of truth per fact (tool IDs in
`opencode.md`, secrets in `configuration.md`, live status in README);
cross-link instead of restating; put "not implemented" in `roadmap.md` only.

## 4. AGENTS.md review

Accurate and useful lines: 3-4, 6-11, 16-17, 20-22 (boundary testing, live
gates). Problems and concrete edits:

- `:19` "Use Node 24" → "Use Node 26 (`package.json` `engines`), pinned dependencies, npm workspaces."
- `:19-20` "`npm run check` builds and runs focused tests plus the CLI smoke test" → "`npm run check` = build, type-check tests, `node --test packages/*/test`, `npm run schema:check`, CLI/daemon smoke. Run `npm run schema` after changing any zod config schema or the check fails."
- `:12-15` (worker cleanup, Linear lanes) are rules for code that does not exist yet → prefix the block: "Design rules for the future worker/Linear lifecycle (not implemented; validation-only config exists):" so an agent does not look for the code.
- `:16` "Discord uses one librarian agent" → add "and applies a session-level deny-all policy in `packages/discord/src/native.ts`; role behaviour lives in the agent file, not host code."
- Add a "Layout" paragraph (missing): `packages/{core,host,knowledge,browser,discord,opencode,app}`; tests in `packages/*/test/*.test.ts` (node:test, real SQLite/QMD, mock OpenCode); scripts in `scripts/`; JSON schemas generated into `schemas/`; examples in `examples/`.
- Add pinned boundaries: "OpenCode 2.0.3 (`@opencode/client`, `@opencode/plugin`), QMD 2.8.3, chrome-devtools-mcp 1.9.0. Bumping any of these needs the matching live gate (`npm run live:opencode`, `npm run smoke:browser`)."
- Add a docs rule: "When behaviour changes, update the single doc that owns that fact (tool IDs → `docs/opencode.md`, config/secrets → `docs/configuration.md`, status → README/`docs/roadmap.md`). Tool IDs are `knowledge_search`, `aivi_sources`, `aivi_status`, `browser_control`."
- Add: "Secrets load from `AIVI_ENV_FILE`, `.env` beside the config, `~/.aivi/.env`; never commit them (`discord.local.json` exists locally, do not reference it)."
- Add: "`docs/review/*.md` are findings, not specs; `docs/backlog/*.md` are unscheduled ideas."
- `:3-4` "The product requirements and roadmap are in `docs/`" → name the files once the restructure lands (`docs/requirements.md`, `docs/roadmap.md`).
- Lint: `npm run lint` (biome) exists but is not in `check` and not mentioned → add "Run `npm run lint` before finishing."

## 5. Example agent files

`examples/librarian/.opencode/agents/librarian.md`

- `:6-27` permission format `{action, resource, effect}` matches what the host sends (`host/src/session.ts:7`) and `examples/discord-librarian/opencode.jsonc:10-14`. OK.
- `:19-27` `external_directory` globs `**/aivi/examples/…/**` depend on the checkout directory being named `aivi`; `docs/opencode.md:36-40` explains why but not the naming dependency → add a comment "adjust if the repo is not checked out as `aivi`".
- `:30-32` tool names `aivi_sources`, `knowledge_search` match the plugin IDs. OK. `:42` `kinds` argument exists (`opencode/src/index.ts:42-46`). OK.
- `:38-40` kind descriptions match `core/src/kinds.ts:7-20`. OK.
- `:45-46` "Conversation retrieval and durable-memory tools are not implemented yet" → memory is searchable via the `memory` kind now → fix as in §1.
- No `browser` permission rule: consistent with a read-only librarian; `browser_control` would prompt (`ask`) in interactive use. Add an explicit `action: browser, effect: deny` if that is intended.
- When run by an `opencode.prompt` job (`examples/tasks/librarian.json`) these frontmatter rules are the *only* boundary (`runtime.ts:112-130` sends no session permissions); when run via Discord the host's deny-all policy (`native.ts:36-52`) overrides. Worth one sentence in `docs/opencode.md`.

`examples/librarian/.opencode/agents/dreamer.md`

- `:5-11` denies only `shell` and `subagent`; the dreaming job applies deny-all + allow-list + edit scope at session level (`dreaming.ts:195-207`), so the frontmatter matters only when a human runs `dreamer` interactively, where `external_directory` for the memory directory will prompt. Either add the same `external_directory` allow rules as `librarian.md` or say in `docs/dreaming.md:68-71` that the dreamer is meant to run only through the job.
- `:14` "Once a day" → schedule-dependent (see §1).
- `:16-17` "The host has already limited what you can write: `facts.md` and files under `proposals/`" → matches `dreaming.ts:205-206` (`proposals/*`, one level). OK.
- Model `github-copilot/gemini-3.8-flash` in both files matches `scripts/live-opencode.mjs:14` default. OK.

`examples/discord-librarian/opencode.jsonc`

- Inline `librarian` agent duplicates `examples/librarian/.opencode/agents/librarian.md` with a shorter prompt and no kinds guidance. `docs/discord.md:66-67` says "The example librarian loads the native aivi plugin, including `knowledge_search`" (true: `:4`), but the two example librarians will drift. Consider pointing `examples/discord.json:6` `directory` at `librarian` and deleting `discord-librarian/`, since the host applies the Discord policy anyway.
