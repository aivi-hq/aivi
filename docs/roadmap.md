# Roadmap

Status per milestone as of 2026-10-03. The original milestone plan (13 September
2026) proposed this order; what follows is where each stands. Product
requirements are frozen in [requirements.md](requirements.md); decisions in
[architecture.md](architecture.md); ideas not yet scheduled in [backlog/](backlog/).

| Milestone | Status |
| --- | --- |
| 0. OpenCode boundary | **Done, live-verified** on OpenCode 2.0.3, the family since pinned at 2.0.18 ([opencode.md](opencode.md)). Repeat with `npm run live:opencode`. |
| 1. Native assistant and minimal core | **Done.** Plugin tools, CLI, schema-validated config, fnox/`.env` secrets. |
| 2. Scoped knowledge search | **Done** for documents: QMD keyword search, kinds, scope never widens on unknown IDs. Conversation export and semantic retrieval not started. |
| 3. Durable tasks and dreaming | **Done.** SQLite + Croner scheduler, leases, restart recovery, reporting, dreaming with `facts.md` and proposals. Agent-created jobs (`aivi_jobs`), one-offs, outcomes re-entering conversations, per-run abort, definitions vs runs, misfire grace and retention as a system job added 2026-09-15 and live-verified on Discord and Slack ([architecture.md#jobs-and-runs](architecture.md#jobs-and-runs)). |
| 4. Browser hands | **Done, smoke-verified** against headless Chrome (2026-09-15). Login takeover, extensions, and recovery paths still to exercise live. |
| 5. Discord adapter | **Done, live-verified** on the target server: DMs, channels, threads, typing, slash commands, job reports. Lifted onto the channel contract 2026-09-15; live re-check pending. |
| 5b. Slack adapter | **Done, live-verified** on the owner's workspace 2026-09-15: DMs, mention → thread, `/spider-status`, ⏳/👀 reactions, job outcomes re-entering a thread, report threads adopting the job session ([slack.md](slack.md)). |
| 6. Worker lifecycle without Linear | **Built tracker-neutral** (2026-10-02): the orchestrator and dispatcher in the host know `tracker` and `forge` roles, never Linear; worktrees and the forge are injected paths, not preconditions. What has never run is a worker with **no** tracker at all. |
| 7. Native Linear AgentSessions | **Built, live rounds green** (2026-10-02): delegation → worker in the checkout or its own worktree → activities → response, follow-ups, stop, HITL refusal ([linear.md](linear.md)). The forge walkthrough and the last live round trip are open: [plans/linear.md](plans/linear.md). |

## Live gates

Mock tests do not establish these; each has its own command.

- OpenCode: `npm run live:opencode -- --plugin "$PWD/dev"`
  (passed 2026-09-15, including `session.list` ordering and the `.env` guard).
- Browser: `npm run smoke:browser` with Chrome installed (passed 2026-09-15).
- Discord: `serve` against a test server (commands register at start).
  Progress (passed live 2026-09-15): with `progress: "status"` a message
  gets a `⏳ thinking…` placeholder that changes while the agent works
  (`🔧 …`, `✍️ writing the answer`) and disappears when the answer is posted;
  with `"tools"` the tool calls are listed beneath; a failing turn leaves the
  notice in the placeholder's place. Not yet seen live: `/model` (autocomplete
  and a pinned answer), `/stop` on a running turn, interjection and `/queue`, `/jobs`, `/help`.
- Linear: the base flow ran live (2026-10-02, question round + answer +
  close green on the operator's host); the forge walkthrough and the round
  trip over a real PR are the open gates
  ([plans/linear.md](plans/linear.md#live-gates)).
- Slack: create the app from the manifest in [slack.md](slack.md#setup),
  `serve` with both tokens, then a DM, a mention in a channel, a follow-up in
  the thread, a report into `reportChannels`, a reply in that thread,
  `/<prefix>-status` and `/<prefix>-search`. Progress (passed live 2026-09-15):
  the same placeholder in the thread through `chat.update`, deleted
  with `chat.delete` when the answer lands, alongside the ⏳/👀 reactions.
  Not yet seen live: the five new commands (the manifest must be re-applied
  first).

## Next, in order of intent

Projects are done (2026-09-15, [projects.md](projects.md)): discovered from
`<home>/projects`, described from the home, per-project memory, add/remove/purge.
The Linear module is built (2026-09-19) with the pool as the capacity and the
worktree as an opt-in isolation — the default worker works in the project's
checkout; there is no per-project lock; running maintenance
only when idle stays an idea
([backlog/projects-and-capacity.md](backlog/projects-and-capacity.md)).

1. **The v1 rc line** (ruled 2026-09-29; what is left was settled 2026-10-03).
   Built since the line was drawn: the CLI refactor (merged on this branch),
   the compose-projects fix, the tracker extraction, the **orchestrator
   extraction** (the machinery in the host knows `tracker`/`forge` roles and
   is proven on the base flow), **forge-github** (the registry, the sync
   crossing, `aivi_pr`, the worktree with the forge's fetch injected), the
   dispatcher with its pools and leases, the **templates program's**
   scaffolding and self-knowledge (2026-10-03). What is left: the **forge
   walkthrough and live round trip** on the operator's host (one real PR,
   one thread resolved, the stop and the feedback loop seen live) →
   **knowledge as a plugin** → **a last look at jobs** → tag v1 rc, on the
   operator's explicit word. The
   reversal: forge had been moved in front so review facts would exist
   for the orchestrator; the operator ruled it the other way —
   pre-designing the forge-carved system is harder than building,
   failing and solving as we go, and the forge path cannot be tested
   before the no-forge base flow exists. Most assistant work in tickets
   is skills, tools and MCPs on an agent (email included — not a new
   capability); the forge is the exception that earns core ceremony.
   The [templates program](plans/templates/index.md) owns what the setup
   scaffolds.
2. Installation and updates for other machines; the home layout it must
   produce is now fixed.

Channels are decided (2026-09-29): discord and slack stay; **email** and
**calendar** (joining Google Meet) come later; the Signal/Telegram research
([backlog/research-channels.md](backlog/research-channels.md)) stands as
research, not a queue. Remote-access hardening is decided as enough for
now (2026-09-29): the bearer token is the account story; per-device tokens
and SSO come when asked for.

## Decisions to make early, and decisions to defer

| Set early | Can wait until its milestone |
| --- | --- |
| OpenCode owns execution and history; aivi owns operational coordination | Retrieval tuning and semantic search |
| Stable core/project/source/session identities | Browser credential-fill mechanism |
| Typed plugin/core boundary, with optional channel adapters | Discord message UX beyond the current commands |
| Clear read/write capabilities for assistant, maintenance and workers | Per-device tokens and SSO, when asked for |
| Schema migrations and restart reconciliation from the first persistent operation | Memory decay after we observe real usage |
| Local-model resource accounting before scheduled inference | |

Each milestone adds its own operating checks and concise documentation, and
tests the boundary it introduces: scoped retrieval, restart recovery, resource
ownership, or external event reconciliation.
