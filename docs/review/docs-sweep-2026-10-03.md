# Review: the docs sweep (2026-10-03)

Scope: every markdown file in `docs/` (including `plans/`, `backlog/`,
`review/`), `CONTEXT.md`, `AGENTS.md`, `README.md`, and the three shipped
package docs (`packages/host/docs/configuration.md`,
`packages/tracker-linear/docs/linear.md`, `packages/forge-github/docs/github.md`).
Method: a mechanical link check over the whole tree first, then a hand read
top to bottom, no child agents, hunting mistakes, false statements and
hard-to-understand jargon; claims were verified against the code and, where
cheap, against the live OpenCode service. Backlog pages got their status
lines and load-bearing sentences, not a line-by-line read. **No file was
edited for this review**; every line below was a finding for the operator to
decide on.

The verdict first: the *reference* docs (browser, channels, people,
configuration's chapters, the two plugin docs) are honest and current — every
number in browser.md checked out. The rot has a shape: the October build rush
(worktrees, lanes, the dispatcher, the forge tools, five seeds, `manual`)
landed faster than the prose. On top of that old rot sat fresh damage from
this branch's own moves (the two moves of the day broke links and anchors).

## Applied (2026-10-03) — the operator's word: "make all of them at least
honest, consistent and correct again; keep around ideas we do not have,
separately, so we do not lose them"

All findings A1–A2, B, C1–C34, D1–D9 are done; each landed where the owning
doc lives. What the fixes amounted to, grouped:

- **Links (A1, A2, B).** `packages/host/docs/configuration.md`'s 19
  `../../docs/…` links reach the repo docs now (`../../../docs/…`; in an
  installed home they read as repo paths, which is honest). The 13 links
  pointing at the stub `docs/configuration.md#anchor` point at the shipped
  file's real anchors. Headings that grew dates (`changes-while-work-is-active`,
  `live-gates`) shed the date from the anchor — retirement notes live in
  body text, not in slugs. `slack.md`'s `](url)` was a **false positive**:
  it sits inside backticks teaching Slack's mrkdwn dialect; left alone.
- **The dead future tense and its mirror (C5, C15, C18, C26–C28, C31–C34,
  and the six/five-file sweeps it touched).** "Worktrees wait for a forge"
  and "every worker runs in a worktree" are both gone from every page: the
  checkout is the default, a `worktree: true` lane gets its own, the forge's
  fetch goes in injected. README gained the forge-github row and the true
  tool list (`aivi_browser` is real — the browser module claims it;
  `aivi_config`, `aivi_connection`, and the worker tools are named).
- **Five kinds everywhere (C20, C25, C33).** `manual` joined the kind lists
  in knowledge.md, configuration.md, README and CONTEXT.
- **Two capacity systems, said plainly (C3, C21, D2).** `dispatcher.pools`
  is ticket work; `scheduler.resources` is jobs and chat turns; the merger
  is tracked deliberately-later. The same truth in CONTEXT, architecture and
  configuration's two field rows.
- **Sessions and origins (C4, C32a).** Worker sessions carry **no** aivi
  metadata; channel turns, jobs and dreaming stamp `metadata.aivi.origin`.
  architecture.md's "SDK's Service.discover()" is aivi's own tolerant
  discovery now, and the version says the pinned family (2.0.18).
- **`aivi_jobs` back end (C1, C3).** The tool rides `POST /tools` like every
  served tool; `POST /jobs` is the same operation for API clients.
- **requirements.md and roadmap.md revised, not frozen (C6–C14).** Lane/app
  mapping rows marked superseded, the per-project lock row corrected, QMD
  stated as selected, team-not-project routing, milestone 6 and 7 told as
  built, "Next, in order" rewritten to what is actually left (the forge
  walkthrough, the live round trip, then v1 rc on the operator's word).
- **`plans/templates/orchestrator.md` deleted (C16), its four dependents
  retargeted** to `docs/orchestrator.md` (which owns the run contracts) —
  and its never-built ideas parked in
  [ticket-workflow](ticket-workflow.md): triage as a worked lane, the
  ticket subagent, the `autonomous` skip label.
- **Records told straight (C29, C30).** client-aivi.md keeps its decisions
  and now says which boxes the CLI refactor and setup work replaced: no
  `/v1/` prefix exists (paths repointed), the roles column landed, `server
  create` folded into `setup`, box 8 superseded by `@aivi/plugin/api`, box
  11's JS build ticked (Node-only), box 9 (soul API) still genuinely open.
  remote-exec.md says **built**; the cli-refactor index names what genuinely
  waits: the D22 dev-home nuke and the branch's own merge.
- **Seeding and commands (C17, C22, C24).** `linear.agent` defaults to
  `assistant` (not "aivi's name"); all five seeded agent files are listed
  where two were; `/link` joined the command lists in discord.md and
  slack.md.
- **Vocabulary (D1, D6, D8).** orchestrator.md's basics gained lines for
  **the walk**, **the board**, **unheard**, **strike**, **the assistant**
  (retiring "the librarian" — repointed everywhere it was used) and
  **follower (historical)**. The CONTEXT fact-map's two "work-pull flow"
  rows are one plain row. The dispatcher's turn-lease design is marked
  designed-not-built (only the orchestrator asks the dispatcher today; the
  steer/queue delivery lives in the channel engine) — the unbuilt design
  stays on the page, labelled.
- **Typos and riddles (D3–D5, D7, D9).** "processess", "a assistant" ×2,
  "groomer"→"product", the missing-words clause, §9's number; "the wrap-up
  ruling" now says its content at first use, `@clack/prompts` is named
  before its marks are, "his nuance" is "the operator's distinction".

## Disposition

(operator's call on each. Findings were struck as they landed — the
task-board rule. The full findings text was never committed before its
repair, so the section above is the record: what each finding was, and
what it became.)
