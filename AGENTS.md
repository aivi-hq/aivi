# Working on aivi

Read `CONTEXT.md` at the start of a session: it says what exists, what was
decided and why, and which document owns which fact. Read the owning doc before
changing runtime behavior.

- Use native OpenCode agents, sessions, permissions, tools, and providers.
- Keep installation state in the host, not in each native plugin instance.
- Add integrations as optional adapters; avoid a general plugin framework.
- Keep source documents authoritative and search indexes rebuildable.
- Preserve project scope; unknown IDs must not broaden a query.
- Do not equate prompt acceptance or session idleness with job completion.
  A failure before the prompt is accepted is `failed`; after it, `blocked`.
- Every state change a person waits on gets a visible signal; never silence.
- Keep credentials in fnox/environment, never configuration examples or logs.
- Agents are ordinary OpenCode agents in `<home>/.opencode/agents/`; their
  file is the whole boundary. aivi adds session rules only for paths it
  knows, never a deny.
- No polling, no periodic timers. React to events: OpenCode's stream, a wake
  from whoever changed state, a promise that resolves. A timer is acceptable
  only to wait for a known instant (a due job, a retry backoff) or to satisfy
  a protocol keep-alive. A "safety net" interval is a poll with a better name.
  `setInterval` is banned outright; where a re-read is the only cross-process
  signal (the installer's diary watch, whose file events macOS never
  delivers), the wait is a `setTimeout` calling itself, re-armed only after
  the previous read finished.

Rules for the worker/Linear lifecycle (built: `docs/linear.md`; what is left:
`docs/plans/linear.md`):

- Never release a worker's resources merely because its caller disconnected.
- A worker runs in the project's checkout; a lane that says `worktree: true`
  gets its own git worktree once a forge gives them. A lane that writes is
  never read-only by aivi — that is its agent file's own permission deny.
- Stop means stop: a stop request, the HITL label or a lane change ends the
  worker and releases the issue. A stop cleans up its own attempt: the run's
  worktree goes with its uncommitted work and local commits (what was
  pushed stays pushed); the native transcript stays for inspection. The
  stopped ticket carries the HITL label when the person's own move did not
  already mark it — the board is the stop's memory, never a line in a
  database. `blocked` is only for a stop that cannot be verified.
  Graceful agent-first cleanup is a later upgrade, not a precondition.
- Linear lanes select OpenCode agents directly; one app (the primary) does the
  receiving, and the assistant (`linear.agent`) answers what people mention it
  on. A delegation no lane can run is not the assistant's: its delegate is
  un-taken and it gets one plain fixed answer saying why.

When behavior changes, update the one document that owns that fact (the map is
in `CONTEXT.md`) in the same commit; a change is not done while a document
still describes the old behavior. When a backlog idea is built, shrink its page
to what is left and point at the owners. `docs/review/*.md` are findings, not
specifications; `docs/backlog/*.md` are unscheduled ideas.

Use Node 26 (`engines` in `package.json`), pinned dependencies, and npm
workspaces. The `@opencode/*` family is one version set: every package pins
the same version (root `overrides` enforces it). aivi owns OpenCode discovery:
a server is alive when it answers HTTP on its registered endpoint, whatever
its version — the SDK's replace-on-mismatch machinery is never allowed to
kill a running server, and version skew is logged, never fatal. When a server
release moves an endpoint aivi uses, bump the family in the same commit.
Packages compile to `dist/` with TypeScript 7 (`npm run build`) and publish
that artifact untouched; tests and typecheck resolve workspace packages to
`src/` through the `development` exports condition
(`--conditions=development`, plus `NODE_OPTIONS` so CLI children spawned by
tests resolve sources too), so keep to erasable TypeScript syntax and `.ts`
import specifiers — Node must run the sources directly. Test
lifecycle, persistence, and configuration changes at the actual boundaries they
affect. Live OpenCode, Discord and macOS Chrome verification are
separate gates; mock tests do not establish those.

Commits follow Conventional Commits (`type(scope): subject`; lefthook enforces
it). Run `npm run agentic:verify` before committing. A commit that changes a
publishable package under `packages/` carries a changeset (`npx changeset`, or
a hand-written `.changeset/*.md`); without one the release leaves that
package's version untouched. Docs-only commits need none.

## Red lines

- Do not be proactive and start making changes. Always request the user's express permission. Even when in build mode.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
