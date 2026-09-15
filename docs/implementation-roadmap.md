# aivi: implementation roadmap

Current architecture: one `aivi serve` hosts configured modules and shared services. Discord is in-process; QMD document indexing and keyword search are implemented. Conversation export and semantic retrieval remain follow-up work.
Implementation update: the optional Discord adapter was brought forward at the user’s request. Its DM/thread routing, fixed librarian, durable inbox, shared capacity leases, and operator recovery are implemented; live Discord/OpenCode validation remains outstanding. See `discord.md`.
Proposed 13 September 2026. Based on requirements v0.8 and the subsequent discussion of project-scoped search. This proposes implementation order and technical defaults; it does not change confirmed product behavior. No implementation or runtime validation has been performed for this roadmap.

## Recommended starting architecture

Start with a useful librarian inside native OpenCode. Add aivi capabilities there before connecting external channels. Discord and Linear remain optional adapters; neither should be necessary to start or use the core.

| Component | Proposed responsibility |
| --- | --- |
| OpenCode v2 | Sessions, transcript history, agent execution, subagents, providers, permissions and native UI |
| `@aivi/host` | TypeScript/Node application and CLI; configuration, knowledge operations, durable tasks, resource coordination and recovery |
| Thin OpenCode plugin | Expose aivi tools in native sessions and provide the session-aware hooks needed by the host |
| Ordinary OpenCode agents/skills | Librarian behavior, dreaming procedure, project worker instructions and approved reusable skills |
| aivi SQLite database | aivi-owned operational state and indexes/cursors; no edits to OpenCode's database |
| Knowledge documents | Authoritative core/team memory and project documents in configured locations |
| QMD | First retrieval implementation to try; its search index remains derived |
| fnox | First secrets integration to reuse |
| Browser module | One managed Chrome profile, browser tooling and tab ownership |
| Optional adapters | Discord messages and Linear webhooks translated into existing core operations |

Keep this in one repository with a few clear modules. `@aivi/host` can expose a small typed client/contracts entrypoint for the OpenCode plugin and other integration code. Split published packages only where runtime loading or optional dependencies require it. Do not create an independent plugin registry or load Discord/Linear dependencies when those adapters are disabled.

The host uses the native [OpenCode client](https://opencode.ai/v2/docs/build/client/); the plugin uses [OpenCode's extension interfaces](https://opencode.ai/v2/docs/build/plugins). Keep installation-wide scheduling outside location-scoped plugin setup. Native session context must be resolved from the actual session, not assumed from the directory in which a plugin instance loaded.

The milestones below decide the remaining process boundaries through small working examples. In particular, QMD can be embedded or shared as a local service; use one model runtime per installation rather than accidentally creating one per conversation. Its [library and MCP interfaces](https://github.com/tobi/qmd) permit both approaches.

## Milestone 0 — Establish the OpenCode boundary

**Build:** A minimal integration fixture on the actual Mac, using a pinned OpenCode v2 build and the existing local model setup. Load a tiny native plugin, connect through the client, create a session, invoke one tool, observe output and reconnect after a restart. Exercise an active session receiving a steering request while a second session remains usable.

**Architecture decisions:** Record the supported v2 build, host-to-runtime transport/authentication, plugin loading, and the identifiers used for sessions, projects and aivi runs. Probe a long-running child command and cancellation to identify the boundary needed for worker termination later. An unresolved hard-kill strategy blocks automated workers, not development of read-only knowledge features.

**Done when:** We can use the same native session from OpenCode and the integration fixture, preserve its history across restart, and explain which lifecycle operations are native versus aivi-owned. Produce a short decision record and a repeatable smoke check, not a general runtime abstraction.

## Milestone 1 — Native librarian and minimal aivi core

**Build:** An ordinary librarian agent, the thin plugin, a small host CLI, schema-validated installation/project configuration, and fnox integration for the first required credential. Expose only a few useful operations: inspect available knowledge sources and core status initially. Native OpenCode remains the UI. Set up database migrations when the first aivi-owned persistent records are introduced.

**Architecture decisions:** Define stable project IDs independently of directory paths. Separate core knowledge configuration from project paths and from future Linear registration. Define the small typed boundary between plugin and host, including session identity, knowledge scope and clear failures when the service is unavailable. Keep role behavior in agent/skill files rather than burying prompts in host code.

The librarian's project access is informational. Plan the same capability boundary for the future Discord adapter, including specialist delegation. OpenCode subagents can have their own permission policies, so a parent's restrictions alone are insufficient. [Permission semantics](https://opencode.ai/v2/docs/permissions)

**Done when:** The librarian is usable in ordinary OpenCode, reads configured core/project material, and does not need Discord or Linear. A developer's ordinary project agents still work without adopting aivi's automation layer.

## Milestone 2 — Scoped knowledge and conversation retrieval

**Build:** Connect QMD to configured documents and a derived export of relevant native conversation history. Expose a small knowledge tool interface: search, read the source passage, and inspect freshness. Support project-only, project-plus-core, selected projects and all accessible sources. Return project/source attribution on every result.

**Architecture decisions:** Choose collection/metadata layout, stable document and conversation references, accepted repository branch versus run-local material, and update/deletion behavior. Cross-project librarian conversations may concern several projects; do not force every session into one project merely because workers have a working directory. Assign scope at the appropriate document/passage level or retain general history as such.

Use OpenCode history/export interfaces for initial backfill and reconciliation. Its client event stream is live-only and does not automatically reconnect or replay missed events; events alone cannot maintain the index reliably. [Client event behavior](https://opencode.ai/v2/docs/build/client/)

Try QMD's documented model defaults. Measure answer quality, warm/cold latency and peak memory with representative company notes, two projects and conversations. Include similar decisions in different projects, superseded facts, and unanswered questions. Verify selective filters still retrieve the desired material; scoping correctness and ranking completeness are different checks. Choose shared-process versus library integration here, based on lifecycle and model loading behavior. Avoid building a replacement retrieval engine without an observed shortcoming.

**Done when:** The librarian answers a question from the correct project, can deliberately broaden its search, cites original material, finds pre-compaction conversation details, and recovers an accurate index after a restart. Editing or deleting a source is reflected without treating the index as authoritative memory.

## Milestone 3 — Durable tasks and dreaming

**Build:** Introduce the persistent job queue and schedules, first callable through aivi's CLI or native plugin. Add a dreaming agent/skill that reviews a configured interval of conversation history, reconciles existing memories and writes useful durable facts to configured destinations. Provide status, pause, cancel and inspection operations in the existing interfaces.

**Architecture decisions:** Separate a task definition, each execution attempt, its native session, and its reporting destination. Persist next occurrence, processed-history cursor, ownership, result and pending delivery. Define timezone, overlap, missed-run and retry policies. A native/local result destination comes first; Discord is added later without changing task records.

Configure capacity at the shared inference-resource level as well as limiting active runs. Native interactive sessions and subagents can consume that capacity too. Establish how OpenCode activity, plugin hooks and the model server's own queue participate before claiming a global concurrency guarantee. Memory extraction, embeddings and reranking must be accounted for when they share hardware. Start with conservative configurable limits, then tune on the machine. Cleanup signals bypass ordinary job admission; dependent subagents must not deadlock behind their waiting parent.

Dreaming writes need source references, deduplication, and a way to distinguish new facts from corrections or uncertain interpretations. Files and database cursors are not one atomic transaction: make writes repeatable and recoverable before advancing the processed boundary. Project ADRs follow the project's document workflow. Skill proposals remain outside active discovery until approved; use the existing repository review workflow rather than inventing an approval UI.

**Done when:** Scheduled work waits behind occupied capacity, survives a restart, produces one reconciled outcome, and remains inspectable. Dreaming remembers a useful fact without duplicating it on retry or converting an abandoned proposal into a decision. A missed schedule does not trigger an uncontrolled backlog.

**First usable release:** Native OpenCode librarian + scoped retrieval + durable tasks + dreaming. Use this regularly before expanding the number of integrations.

## Milestone 4 — Browser hands

**Current status:** Initial MCP-backed host service and native tool implemented.
Persistent launch/existing/attach modes, scoped tabs, explicit page routing,
bounded operation queue, and manual focus are present. The target-machine
Chrome/extension/login gate is still open; automatic popup/download ownership,
secret injection, and restart ownership reconciliation remain follow-ups.
See [browser setup](browser.md).

**Build:** Add the persistent installation-owned Chrome profile and Chrome DevTools MCP integration, with session-owned tabs, downloads and human takeover. Connect secret references through the chosen fnox/browser mechanism as needed. Reuse existing browser tools; write only ownership and lifecycle glue.

**Architecture decisions:** One browser-profile owner; explicit page routing; ownership of popups/downloads; reconnect behavior; pause/resume around login; cleanup boundaries for shared cookies versus session resources. Credentials must stay out of ordinary model inputs and captured tool output. Browser capabilities vary by role: project workers may test, while the Discord librarian remains informational and cannot gain write capability through browser or specialist delegation.

**Done when:** Two sessions can browse independently using the shared authenticated profile and an installed extension. Closing one session's resources does not disturb the other. Login takeover, browser restart and stale page references have demonstrated recovery behavior.

## Milestone 5 — Discord adapter

**Build:** A bot adapter around the existing librarian. Bind DMs and threads to native sessions, add a new-session command, preserve sender attribution, and deliver replies/attachments and permitted scheduled reports. Include reconnect handling, duplicate-message protection, rate limits and output formatting.

**Architecture decisions:** Channel identity and authorized senders, whether each destination permits new proactive sessions, pending delivery after restart, and which informational tools are exposed. No agent switching, project execution, or project-selection UI. Selecting a project for a question changes retrieval scope only. Direct project work stays in OpenCode.

**Done when:** The same knowledge behavior works in native OpenCode and Discord. Several conversations use the one configured Discord agent with separate histories. `/new` retains old searchable history. Scheduled reports obey destination settings, and disabling Discord leaves the core functioning.

This milestone can follow milestone 3 if shared knowledge chat becomes more valuable than browser work. It must not become a prerequisite for core functionality.

## Milestone 6 — Automated worker lifecycle without Linear

**Build:** Launch a worker from a local aivi command against a disposable project, with its configured OpenCode agent fixed for the run. Implement workspace/resource ownership and the approved agent-first rollback protocol. Exercise successful completion, steering, cleanup, hard termination, and human repair before adding webhooks.

**Architecture decisions:** Resolve the execution-isolation question from milestone 0. Choose shared versus separate worker runtime processes based on whether termination can be targeted and verified. Keep the runtime handle separate from the durable native session ID. Define project setup, external resource tracking and clean-state verification. Use a generic work key so a later Linear issue ID can claim the same mechanism without making all tasks tickets.

**Done when:** The worker can undo a test database migration before managed teardown, and successful work retains its results. Cleanup deadlines survive restart. Failure or hard termination blocks replacement until repair; unrelated sessions continue and the interrupted session remains inspectable. Repeated local commands cannot create overlapping owners for the same work key.

This is the prerequisite for unattended coding, independent of Linear. A worktree alone does not establish the required process or external-state isolation.

## Milestone 7 — Native Linear AgentSessions

**Build:** OAuth app installations, authenticated webhook ingress, project registration, native delegation/session reporting, and reconciliation around the worker lifecycle already implemented. Add HITL and configured graceful/immediate-stop triggers.

**Architecture decisions:** Maintain two connecting configurations: project lane → Linear application; installation application → unique OpenCode agent. Several lanes may reuse an app; another app cannot reuse its mapped agent. The human stays assignee. Persist inbound receipts and claims before side effects; reconcile uncertain API results and host restarts.

Validate same-app transitions between lanes and the native AgentSession creation sequence. Resolve the open interpretation of Linear's Stop signal before exposing it; do not silently reinterpret the approved graceful-cleanup behavior. Report acceptance/waiting promptly even when local execution capacity is full.

**Done when:** A lane event creates exactly one owning run through the expected delegation/session flow. Duplicates, rapid lane changes, delegate changes, HITL, restart and cleanup failure preserve ownership rules. Native sessions report progress/questions/results. Removing the Linear adapter leaves the assistant and scheduler intact.

## Decisions to make early, and decisions to defer

| Set early | Can wait until its milestone |
| --- | --- |
| OpenCode owns execution and history; aivi owns operational coordination | Worker process isolation, resolved before milestone 6 ships |
| Stable core/project/source/session identities | QMD process layout and retrieval tuning in milestone 2 |
| Typed plugin/core boundary, with optional channel adapters | Browser transport and credential-fill mechanism in milestone 4 |
| Clear read/write capabilities for librarian, maintenance and workers | Discord message UX in milestone 5 |
| Schema migrations and restart reconciliation from the first persistent operation | Linear OAuth/webhook choreography in milestone 7 |
| Local-model resource accounting before scheduled inference | Memory decay after we observe real usage |

Each milestone should add its own operating checks, backups and concise human documentation. Test the boundary introduced by that milestone: scoped retrieval, restart recovery, resource ownership or external event reconciliation. Avoid both a large up-front framework and postponing recovery until the end.

## Suggested next action

Confirm this order and the proposed TypeScript/Node + thin OpenCode plugin + aivi SQLite baseline. Then implement milestones 0 and 1 as the first small working slice. Select QMD based on milestone 2's results rather than expanding the memory-provider catalogue in advance.
