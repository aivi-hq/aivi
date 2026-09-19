# Roadmap

Status per milestone as of 2026-09-15. The original milestone plan (13 September
2026) proposed this order; what follows is where each stands. Product
requirements are frozen in [requirements.md](requirements.md); decisions in
[architecture.md](architecture.md); ideas not yet scheduled in [backlog/](backlog/).

| Milestone | Status |
| --- | --- |
| 0. OpenCode boundary | **Done, live-verified** on OpenCode 2.0.3 ([opencode.md](opencode.md)). Repeat with `npm run live:opencode`. |
| 1. Native librarian and minimal core | **Done.** Plugin tools, CLI, schema-validated config, fnox/`.env` secrets. |
| 2. Scoped knowledge search | **Done** for documents: QMD keyword search, kinds, scope never widens on unknown IDs. Conversation export and semantic retrieval not started. |
| 3. Durable tasks and dreaming | **Done.** SQLite + Croner scheduler, leases, restart recovery, reporting, dreaming with `facts.md` and proposals. Agent-created jobs (`aivi_jobs`), one-offs, outcomes re-entering conversations, per-run abort, definitions vs runs, misfire grace and retention as a system job added 2026-09-15 and live-verified on Discord and Slack ([architecture.md#jobs-and-runs](architecture.md#jobs-and-runs)). |
| 4. Browser hands | **Done, smoke-verified** against headless Chrome (2026-09-15). Login takeover, extensions, and recovery paths still to exercise live. |
| 5. Discord adapter | **Done, live-verified** on the target server: DMs, channels, threads, typing, slash commands, job reports. Lifted onto the channel contract 2026-09-15; live re-check pending. |
| 5b. Slack adapter | **Done, live-verified** on the owner's workspace 2026-09-15: DMs, mention → thread, `/spider-status`, ⏳/👀 reactions, job outcomes re-entering a thread, report threads adopting the job session ([slack.md](slack.md)). |
| 6. Worker lifecycle without Linear | Not started. |
| 7. Native Linear AgentSessions | **Built, not live-verified** (2026-09-16): delegation → worker in a worktree → activities → response, follow-ups, stop, HITL refusal, project/issue locks ([linear.md](linear.md)). Listener and the rest: [plans/linear.md](plans/linear.md). |

## Live gates

Mock tests do not establish these; each has its own command.

- OpenCode: `npm run live:opencode -- --plugin "$PWD/example"`
  (passed 2026-09-15, including `session.list` ordering and the `.env` guard).
- Browser: `npm run smoke:browser` with Chrome installed (passed 2026-09-15).
- Discord: `serve` against a test server (commands register at start).
  Progress (passed live 2026-09-15): with `progress: "status"` a message
  gets a `⏳ thinking…` placeholder that changes while the agent works
  (`🔧 …`, `✍️ writing the answer`) and disappears when the answer is posted;
  with `"tools"` the tool calls are listed beneath; a failing turn leaves the
  notice in the placeholder's place. Not yet seen live: `/model` (autocomplete
  and a pinned answer), `/stop` on a running turn, `/steer`, `/jobs`, `/help`.
- Linear: not yet run live; the gate is listed in [plans/linear.md](plans/linear.md#7-documentation-and-live-gate).
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
The Linear module is built (2026-09-19) with worktrees as the isolation and the
pool as the capacity — there is no per-project lock; maintenance-when-idle
stays an idea ([backlog/projects-and-capacity.md](backlog/projects-and-capacity.md)).

1. Next channels once the research lands
   ([backlog/research-channels.md](backlog/research-channels.md)); Signal and
   Telegram will test the "conversation without threads" case.
2. Installation and updates for other machines
   ([backlog/installation.md](backlog/installation.md)); the home layout it
   must produce is now fixed.
3. Remote access hardening (per-device tokens, SSO via reverse proxy), then
   the Linear live gate (the module is built; what to exercise is in
   [plans/linear.md](plans/linear.md#11-the-single-app-rework-2026-09-19-built)).

## Decisions to make early, and decisions to defer

| Set early | Can wait until its milestone |
| --- | --- |
| OpenCode owns execution and history; aivi owns operational coordination | Worker process isolation, resolved before milestone 6 ships |
| Stable core/project/source/session identities | Retrieval tuning and semantic search |
| Typed plugin/core boundary, with optional channel adapters | Browser credential-fill mechanism |
| Clear read/write capabilities for librarian, maintenance and workers | Discord message UX beyond the current commands |
| Schema migrations and restart reconciliation from the first persistent operation | Linear OAuth/webhook choreography in milestone 7 |
| Local-model resource accounting before scheduled inference | Memory decay after we observe real usage |

Each milestone adds its own operating checks and concise documentation, and
tests the boundary it introduces: scoped retrieval, restart recovery, resource
ownership, or external event reconciliation.
