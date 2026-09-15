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
| 3. Durable tasks and dreaming | **Done.** SQLite + Croner scheduler, leases, restart recovery, reporting, dreaming with `facts.md` and proposals. Agent-created jobs (`aivi_schedule`), one-offs, outcomes re-entering conversations, per-job abort added 2026-09-15; Discord parts await their live gate ([backlog/jobs.md](backlog/jobs.md)). |
| 4. Browser hands | **Done, smoke-verified** against headless Chrome (2026-09-15). Login takeover, extensions, and recovery paths still to exercise live. |
| 5. Discord adapter | **Done, live-verified** on the target server: DMs, channels, threads, typing, slash commands, job reports. |
| 6. Worker lifecycle without Linear | Not started. |
| 7. Native Linear AgentSessions | Not started; configuration validation exists. |

## Live gates

Mock tests do not establish these; each has its own command.

- OpenCode: `npm run live:opencode -- --plugin "$PWD/example"`
  (passed 2026-09-15, including `session.list` ordering and the `.env` guard).
- Browser: `npm run smoke:browser` with Chrome installed (passed 2026-09-15).
- Discord: `aivi … discord register` then `serve` against a test server.

## Next, in order of intent

1. Live Discord gate for the jobs work (re-entry turns, report threads,
   `/status`), then enable `scheduler.agentSchedules` in the private home.
2. Projects as pools and maintenance only when idle
   ([backlog/projects-and-capacity.md](backlog/projects-and-capacity.md)).
3. Project-scoped memory and a per-project dreamer boundary
   ([backlog/project-memory.md](backlog/project-memory.md)).
4. Installation and updates for other machines
   ([backlog/installation.md](backlog/installation.md)).
5. Remote access hardening (per-device tokens, SSO via reverse proxy), then
   milestone 6 and 7.

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
