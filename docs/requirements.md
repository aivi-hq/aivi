# aivi: requirements

Product requirements (v0.9; 2026-09-13, worker lifecycle revised 2026-09-16). Decisions taken since live in [architecture.md](architecture.md); implementation status in [roadmap.md](roadmap.md).

## 1. Product

An always-on OpenCode installation acts as an employee with several roles, shared knowledge, and tools for acting on that knowledge. People can talk to its agents directly. Configured events and schedules can also initiate work.

The product name is aivi. Keep its core small and close to ordinary OpenCode: favor focused dependencies, low memory use, fast operation and native extension mechanisms. Reuse is selective, not an aim to support every possible backend or integration. A thin core integration, with a working package name such as `@aivi/host`, can expose knowledge and aivi-specific capabilities to OpenCode plugins/tools. Exact package boundaries remain a technical-design choice; do not create a separate general-purpose plugin framework.

OpenCode owns sessions, message history, and agent execution. The host connects external inputs to those sessions and coordinates work through OpenCode's existing interfaces. It adds channel/ticket associations, delegation and worker state, and searchable indexes derived from OpenCode history. OpenCode also supplies subagents, providers, permissions, skills, tools, and project configuration. The runtime target is OpenCode v2. Its official installation and integration documentation is available; a specific build must be pinned and its required behavior validated before implementation depends on it.

The initial host is a Mac server. Platform-specific dependencies should be identified during technical design. Humans continue using ordinary OpenCode on their own development machines with the same company and project agent definitions.

Linear automation is an optional capability. An installation can provide chat, memory, browser access, and scheduled work without configuring Linear or registering coding projects. This also makes an individually operated assistant a possible configuration of the product.

## 2. Concepts and configuration

| Concept | Requirement |
| --- | --- |
| Installation | One operated worker environment with its own configuration, knowledge, credentials, and browser profile. |
| Project | A local directory with project-specific OpenCode and aivi configuration. For Linear automation, register it against a Linear workspace and project; a default workspace may simplify registration. Manual project use does not require Linear. |
| Agent | An ordinary OpenCode agent resolved from company/global or project configuration. Agent definitions remain usable in plain OpenCode. |
| Worker eligibility | Only explicitly configured worker agents participate in automatic Linear delegation. Other agents can be available through direct conversation or agent delegation. |
| Lane mapping | Each configured lane selects one Linear app. These mappings belong to project configuration. Many lanes may select the same app. A lane does not independently select an OpenCode agent. |
| App mapping | Separate installation configuration links each configured Linear app to exactly one OpenCode agent identifier. Each OpenCode agent identifier may be linked to at most one Linear app. Resolve the agent's definition using the target project's normal OpenCode configuration. |
| Session | An ordinary OpenCode session. Direct native OpenCode conversations retain native agent switching. Discord conversations use one installation-configured OpenCode agent and have no agent switching, project-work context or aivi ticket ownership. An automated worker keeps its assigned OpenCode agent for its entire run. It may invoke configured subagents without switching its own agent. |
| Work ownership | A ticket has at most one owning worker run at a time, and a project has one active worker at a time (a lock, later a limit). That worker can use its configured subagents. |
| Linear ownership | The human assignee remains responsible for the issue. The Linear app acts as its delegate. A new automatic assignment requires the issue to have no existing delegate and no pending worker. |
| Human identity | Incoming messages retain sender identity for attribution, replies, and configured access. The current scope has shared installation knowledge, without separate personal memory profiles. |

Discord uses one installation-configured OpenCode agent, initially the librarian. Users cannot switch agents in Discord. The librarian answers questions and researches across accessible core and project knowledge; it does not perform project work or launch workers on behalf of a Discord conversation. It may consult specialists such as Linear and GitHub agents for information, but delegated tool access must preserve this project-read-only boundary. Each specialist owns its configured MCP/tool access; consultation does not require giving the librarian every specialist's tools. Native OpenCode remains the interface for direct manual work and native agent selection.

Company agent definitions can be checked out into the normal global OpenCode configuration location. Project definitions live with the project. Host-specific routing configuration supplements those definitions. Plain OpenCode remains a supported way to run the same work interactively.

Names such as librarian, developer, reviewer, or groomer are configurable choices. There is no fixed catalogue of lane names, workflow stages, or worker agents. Use the term "OpenCode agent" consistently for agent definitions and identities; "browser profile" and fnox's own profile terminology refer to their respective products.

The routing relationship is many lanes to one application, then one app to one OpenCode agent. For example, development and review can both select `dev-app`, and the separate app mapping links `dev-app` to `developer`. A second Linear app cannot also map to `developer`. Lane and ticket context determine the job; they do not change that app-to-agent mapping. Validate duplicate agent assignments and unresolved app references before activating the configuration. Project-specific definitions of the mapped agent still follow OpenCode's ordinary configuration discovery.

## 3. Conversations, knowledge, and tools

- OpenCode is the initial native chat interface. Discord is the first shared knowledge/chat interface, exposing a deliberately limited subset of OpenCode session capabilities. A DM has a current session; a new channel thread starts a separate session. All Discord conversations use the same configured OpenCode agent, but do not share one conversation history. Shared conversations preserve the identity of each speaker.
- A new-session command creates fresh OpenCode conversation context and updates the channel-to-session association. The old session and durable memory remain available as described in section 5.
- Direct native OpenCode conversations retain native agent selection and switching. Discord exposes neither agent switching nor project-work session selection. Manual use does not create a ticket or claim a worker run. Automated workers cannot switch their assigned agent; resolve it through the selected Linear app's mapping at run creation.
- Project execution uses the relevant project's directory and configuration through native OpenCode or Linear automation. The Discord librarian may search and inspect multiple projects to answer a question without moving its conversation into a project worker session. Reading a project's documents does not grant permission to edit it, run its operational tasks, or use write-capable specialist tools.
- OpenCode's existing session/message history is the authoritative transcript. Reuse it through the supported API/SDK; transcript exports are also candidates for indexing. A derived search index can be rebuilt from that history. The host does not implement a parallel session engine or independent authoritative transcript store. Research confirms SQLite-backed v2 storage and documented history/export interfaces; JSONL is not an integration assumption.
- Retrieval must support keyword search and semantic retrieval where useful. FTS5, embedding models, and storage for derived indexes and host state are implementation choices for the next phases.
- QMD is explicitly shortlisted for evaluation across both configured knowledge documents and derived conversation-history exports; it is not limited to chat history. Selection depends on reliability, retrieval quality, peak memory, latency and dependency footprint. No retrieval backend has been selected yet.
- Durable memory contains only facts and decisions that change future behavior. Temporary findings belong in searchable history, daily notes, or nowhere.
- Lasting project knowledge belongs in repository documentation, such as architecture decisions and research notes. Retrieval should retain its source and project context.
- Knowledge source paths are configurable at installation/core scope and separately per project. Core sources hold company information and shared working conventions; project sources hold the project's documents, preferably in its repository. Both scopes are available when working on that project. Preserve source and scope in results; retrieving material does not promote it into standing instructions or accepted decisions. Conversations remain useful for recovering details and detecting patterns without becoming authoritative project documents.
- Editable agent instructions/persona files and custom skills are supported. Memory updates may be automatic. Agents can develop proposed skills; human approval is required before those changes become active. Instruction-editing authority follows configuration. Updating the platform's own code is outside the self-maintenance feature.
- Browser control uses an installation-owned persistent profile with extensions and authenticated sessions. Tabs are associated with their owning sessions so concurrent work and cleanup can be managed. The profile's login state is shared by its tabs.
- Browser access includes human login/takeover and a way to supply credentials without putting their values in model context or conversation logs. The actual mechanism will be selected after evaluating browser options.
- Secrets management is an explicit capability. Evaluate reusing fnox, already used with the team's ordinary OpenCode workflow, as the first candidate. Support installation and project configuration, resolving secrets for the relevant host integrations, worker tools and browser actions without making their values conversational content. Unattended access, injection boundaries and renewal behavior belong to technical design; do not build a new vault by default.
- LSP is not required for the initial product and does not block adoption of OpenCode v2. Reuse it when available upstream; ordinary compiler, typecheck and lint tools are sufficient in the meantime.
- Scheduled and recurring tasks can start configured agent work and deliver results to configured destinations. New event sources, action tools, and notification destinations should be straightforward to add.
- Configure whether the host may proactively initiate a new session at each destination, such as a Discord channel, and where results are delivered. Starting a session and reporting a result are separate policy choices. Queued work must be rechecked against current destination settings before dispatch.
- Local models are a first-class target. Configure active-work concurrency and queue excess work rather than spawning overlapping sessions when capacity is occupied. Periodic maintenance must respect the same resource limits; no unconditional model-driven heartbeat that creates competing work. Persist pending work across restarts and avoid accumulating duplicate occurrences of the same periodic job according to its configured overlap policy.

### Discord session controls

Keep the adapter close to OpenCode: a new-session/reset command creates a fresh native session with the same configured Discord agent. There is no `/agent` or `/project` control in the initial Discord interface. Wider agent selection and project execution through Discord are explicitly deferred. Native OpenCode remains usable directly with its full native controls.

The librarian selects relevant knowledge sources from the question and can ask which project the user means. This is retrieval scope, not a change of working directory or execution authority. Existing destination settings still govern whether the host may initiate a new Discord conversation or post scheduled results. Receiving a report in Discord does not make that conversation a worker-control interface.

### Scheduled dreaming

Add a configurable dreaming task that reviews recent conversations, for example the day's history, to identify useful patterns, memories and durable facts. Reuse an ordinary OpenCode agent and aivi's existing scheduler; no separate always-running reflection service is required.

The task follows the existing memory-hygiene rule: preserve facts or decisions that change future behavior, not every event or summary. It should associate saved knowledge with its source conversations and core/project scope, reconcile existing memories, and avoid promoting guesses or abandoned work into accepted decisions. Memory writes use configured destinations and authority; repository ADRs remain governed by the project's document workflow. This maintenance task is separate from the Discord agent's project-read-only access.

Dreaming obeys configured time windows, concurrency and local-model capacity. It queues when occupied rather than competing with an active worker. Track the processed history boundary so a restart or repeated schedule does not reprocess everything or create duplicate memories. The schedule, timezone, agent/model and write policy belong to configuration. Memory decay remains a separate future feature, not implicit permission for dreaming to delete source history.

### Design candidates for local-model scheduling

In addition to the confirmed session/work limits, evaluate limits per inference endpoint or shared device. Parent agents, subagents, extraction, embeddings and reranking can compete for the same hardware. Count actual inference work where integration permits it; an idle session need not consume inference capacity. Establish priorities between interactive requests, queued automation and maintenance. Cleanup/control signals must reach their owning run without waiting behind ordinary queued tasks, and subagent scheduling must avoid a parent holding capacity while waiting for a child that cannot start. These details are design proposals, not a requirement to replace OpenCode's execution engine or the model server's scheduler.

## 4. Linear workflow

1. An issue webhook reaches the host.
2. The host resolves the registered project and reads its configuration and the issue's current state.
3. It resolves the lane's Linear app and that application's uniquely mapped OpenCode agent. It checks worker eligibility, human-intervention markers, the current delegate and any pending worker.
4. If eligible and without a delegate, it sets that Linear app as delegate. The human assignee remains responsible for the issue.
5. A native Linear Agent Session is created. Its webhook starts the corresponding OpenCode session with the application's mapped agent, the project directory and lane-specific task context. That automated worker keeps the same agent until its run ends.
6. Progress, questions, outcomes, and failures are reported through the native Agent Session. Human follow-up messages can reach the corresponding active conversation.
7. Completion and any subsequent lane transition follow project configuration. Interactive and automated execution use the same agent definitions.

For example, both a development lane and a review lane may select the same Linear app. That app maps to one OpenCode agent in the separate application configuration. Lane and ticket context determine the job. The implementation must establish the appropriate stage session even when the app and agent are reused; the exact Linear API sequence remains to be validated.

### Changes while work is active (revised 2026-09-16)

Every worker runs in its own git worktree of the project, on the branch name Linear computes for the issue; the project's clean checkout is never a working directory. That isolation is what makes stopping cheap.

Stop means stop, as for a cancelled CI job. A stop request from Linear, the human-needed marker added during execution, the issue leaving its mapped lane, or the delegate being removed all end the worker the same way: the running turn is interrupted, one final activity in the agent session says what happened and where the OpenCode session and the worktree are, the worker ends `stopped` and the project lock is released. The worktree and the native transcript stay for inspection; nothing is silently discarded and nothing is rolled back automatically.

`blocked` (the lock held until an operator resolves it) is reserved for a stop that cannot be verified: OpenCode unreachable while interrupting, or a restart finding a worker whose session still shows work in progress. Local host state decides that, regardless of what the delegate or the visible agent session state says.

Repeated or rapidly changing events must not launch overlapping owning workers. After a stop, routing uses the current issue state rather than replaying intermediate lanes.

A configurable human-needed marker (a label) blocks automatic delegation and is refused even when a person delegates the issue by hand; the refusal is explained in the agent session. A developer can take over with plain OpenCode and later remove the label.

Graceful agent-first cleanup (steering the worker to undo effects a worktree does not contain, such as a test database migration, before releasing) is a later upgrade, not a precondition; its design lives in [plans/linear.md](plans/linear.md). Linear's native stop signal is honoured as described above; there is no separate kill status or label.

## 5. Lifecycle rules

| Situation | Behavior |
| --- | --- |
| New-session command | Archive the old conversation and retain its searchability. Memory persists. Explicit deletion is a separate action. |
| Stop request, HITL label added, lane left its mapping, delegate removed | Interrupt the worker, post one final activity, end `stopped`, release the project lock. Worktree and session stay for inspection. |
| Stop cannot be verified | End `blocked`; the lock is held until an operator resolves it after inspecting the session. |
| HITL label present | No automatic delegation; a hand delegation is refused with an explanation. |

## 6. Operational requirements

- Reuse OpenCode's persisted sessions and retain the host's external associations and orchestration state needed to recover after a restart and explain what ran, why it ran, and its result.
- Handle repeated deliveries and retries without creating duplicate worker runs or blindly repeating completed external actions.
- Make blocked, failed, and interrupted work visible through the configured interfaces.
- An interrupted worker leaves its worktree and session inspectable; only an unverifiable stop holds the project lock.
- Provide housekeeping for completed runs, stale resources, history/index retention, and backups. Detailed policies belong to technical design.
- Keep credentials out of ordinary prompts and logs. Preserve configured OpenCode permissions and agent tool boundaries across direct and delegated execution.
- Allow chat, browser, memory, and scheduling capabilities to operate when the Linear/project integration is unconfigured.

These requirements describe behavior; they do not imply separate deployed services for each capability.

## 7. Initial scope boundaries

Included: an operated OpenCode worker installation reusing native sessions and history, Discord routing, shared knowledge and derived search, browser control, scheduled work, specialist delegation, and optional native Linear Agent Session automation. Linear/GitHub specialist agents can expose their own configured MCPs.

Deferred: Discord agent switching and project execution, custom chat/mobile UI, connected execution nodes on human machines, local/central profile synchronization, per-person private memories, and specific email, WhatsApp, travel, job-search, password-manager, or notification-provider integrations. Those examples establish future extensibility needs rather than initial connectors.

The platform does not automatically modify or redeploy its own source code.

## 8. Acceptance scenarios

1. A developer checks out company and project agent definitions and runs a project task using ordinary OpenCode.
2. OpenCode provides the native chat interface and Discord the first shared knowledge interface. Every Discord conversation uses one configured agent without switching or project execution; separate DMs/threads retain separate sessions. Native OpenCode retains agent switching, while automated workers keep their assigned agent throughout execution.
3. The Discord librarian consults a GitHub or Linear specialist for information without acquiring project-write or worker-launch capabilities through delegation.
4. Old conversations are retrieved from OpenCode history through a derived index without promoting all their contents into durable memory or maintaining another authoritative transcript store.
5. An actionable Linear issue without a delegate or unresolved worker state selects an application through the project's lane mapping, then starts the unique OpenCode agent linked to that application. Its human assignee remains responsible. A direct-only agent is not automatically selected as a worker.
6. Two lanes reuse the same Linear app, and therefore the same mapped OpenCode agent, while running the appropriate lane-specific jobs. Configuration linking a second app to that agent is rejected.
7. A lane changes during execution: the worker is stopped, its agent session shows why and where its worktree and OpenCode session are, the project lock is released, and repeated events never create overlapping owning workers.
8. A HITL-marked issue receives no new automatic delegation while a developer handles it interactively.
9. Separate sessions manage their own browser tabs while retaining the installation's browser profile and installed extensions.
10. An installation without Linear configuration still supports conversations, knowledge retrieval, browser tasks, and recurring work.
11. A HITL-labelled issue delegated by hand is refused with an explanation in the agent session.
12. A stop request from Linear ends the relevant worker only; other sessions remain unaffected and the interrupted session remains inspectable. A stop that cannot be verified leaves the worker blocked until an operator resolves it.
13. A project query can retrieve relevant company-wide guidance and that project's configured documents, with each result's source and scope retained.
14. A destination with proactive session creation disabled receives no host-initiated conversation. An enabled destination can receive scheduled work under its configured reporting policy.
15. With configured execution capacity occupied, additional automated work waits in a persistent queue; repeated periodic triggers do not create an uncontrolled backlog, and stop signals still reach the active run.
16. A dreaming task reviews the configured interval of conversation history, reconciles useful durable memories with their sources, and queues when local-model capacity is occupied. Retrying or restarting does not duplicate the same memory writes.

## 10. Future ideas: memory decay

Record memory decay as a bonus feature for later investigation, not an initial delivery requirement. Material that has not been useful for a long time may receive lower retrieval priority and eventually become a deletion candidate. No formula, interval or automatic deletion behavior has been chosen.

Design questions to revisit: what counts as meaningful use rather than merely appearing in search results; how importance or pinned decisions resist decay; how superseded facts differ from merely old facts; and how candidate review, archival and deletion interact with source documents and retained session history. A potential starting point is ranking decay and review candidates, while keeping source retention an explicit separate policy. Age alone should not silently delete an ADR or the only record of a decision.
