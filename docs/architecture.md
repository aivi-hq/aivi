# Architecture decisions

## Keep OpenCode as the runtime

An installation is one always-on workstation. Native OpenCode remains usable
without aivi. Its global/project agents, providers, permissions, tools, skills,
and session storage remain authoritative. No replacement transcript format or
agent-profile system is introduced.

The host application runs separately from the native OpenCode plugin. Its own modules share one process. Loading a plugin must never
start another scheduler, create a daemon per session, or load embedding models.
The plugin uses `@aivi/host/client`, a fetch-only client. Future native
plugins can reuse that client without importing the SQLite store.

`@aivi/app` is the composition root: it loads configured modules and launches
`runHost`. The host owns the shared store, scheduler, native client, knowledge
service, optional browser service, API listener, startup, and shutdown. Discord receives those services in
its `start` method. Linear will be another in-process module with webhook routes
on the same listener, not another application server.

There is no general-purpose plugin registry, decorator system, or service locator.
Modules are explicit packages with a small start/stop contract. See
[application lifecycle](application.md).

## SQLite and Croner

SQLite stores schedules, job payloads, ownership, results, and audit history.
The host schema is versioned (`HOST_SCHEMA_VERSION` in `store.ts`; today 4)
and adapters version their own namespaced tables through `Store.migrate`.
Discord stores its inbox and session mappings in the same database that way;
its turn claim and lease are atomic.
Croner is only a timezone-aware date calculator. A short polling loop checks due
schedules; it does not invoke a model unless a queued task requests one.

`BEGIN IMMEDIATE` transactions serialize enqueueing, schedule materialization,
and job claims. Unique keys deduplicate identical requests. A partial unique
index allows only one outstanding occurrence per schedule. WAL enables readers
while the daemon operates. Node's built-in SQLite avoids a separate native addon.

This is a single-machine design. A singleton owner and PID prevent competing
daemons on one database. PID reuse is treated conservatively as an existing
owner; an operator may need to investigate it. Do not share the database between
machines or use a network filesystem as a coordination mechanism.

The current misfire policy is coalesce: schedule downtime produces one pending
occurrence, then advances to the next future time. Ticks arriving while that
schedule already has outstanding work are skipped. This suits maintenance and
dreaming; a future task requiring every occurrence needs an explicit new policy.
Croner defines DST behavior; use UTC when repeated/skipped local wall times are
undesirable. Store timestamps are UTC milliseconds.

## Ownership before execution

Queue states are `queued`, `running`, `succeeded`, `failed`, `blocked`, and
`cancelled`. Queued cancellation has no external effects. A running or blocked
job occupies global capacity and its resource-pool slot.

An OpenCode submission saves an intended session ID before calling the server.
The request carries stable session/message IDs and job metadata. If a response
is lost, the operator has a reconciliation target. This does not promise
exactly-once external effects and there are no automatic dispatch retries.

One session driver (`runTurn`) serves jobs, dreaming and Discord: it verifies
a final answer from the native context rather than trusting idleness.
Unattended turns auto-reject permission prompts by default, so a read-only
agent keeps going and the denial is recorded. A failure before the prompt is
accepted (`TurnNotStarted`) means nothing ran: jobs end `failed`, Discord
turns are discarded and their capacity released. Anything after that which
cannot be verified (timeout, failed turn, changed agent, host shutdown
mid-turn) blocks; `jobs resolve` records the operator's decision and neither
stops OpenCode nor undoes side effects.

### Two queues, one capacity

Discord turns are not host jobs, and this is deliberate. Jobs run in any order
in fresh sessions and report to a configured destination. Conversation turns
run in order within one thread, continue that thread's session, reply into the
thread, and must start within seconds. Folding them into the job table would
teach the scheduler what a conversation is. What the two share is capacity:
every turn takes a resource lease from the same pools as jobs
(`Store.acquireLease`), so the `local-model` limit holds across both.

Future worker cleanup must steer the agent first, retain the tools it needs to
undo its effects, then perform orchestrator cleanup and verify it. Configurable
timeouts/hard kill cannot imply a clean state. Failed cleanup blocks reassignment;
the native transcript remains inspectable. Native Linear Stop mapping is still
an integration decision, not implemented by this scaffold.

## Knowledge and permissions

Configured paths identify authoritative core and project documents. Search indexes
will be derivatives. Conversation history will be exported through native APIs,
with incremental checkpoints and references back to native sessions. No direct
dependency on OpenCode's internal database layout or an assumed JSONL layout.

The implemented QMD service owns one SDK store and a derived index under the
installation state directory. Startup refreshes documents when configured.
Keyword search and indexing serialize through a bounded queue. Modules/jobs call
the service directly; native OpenCode tools use the authenticated host API.

Source selection supports core only, selected projects, selected projects plus
core, and all configured sources. Unknown project IDs fail instead of broadening
the search. Scope is retrieval selection, not a multi-tenant security boundary.
Read permissions still belong to OpenCode. This installation uses shared team
knowledge, not per-human private memory.

The API listens on `host.bind` (loopback by default; a tailnet or LAN address
for a shared knowledge server) and exposes status, source discovery, scoped
knowledge search, and optional permission-gated browser operations. `/health`
is public; everything else requires the bearer token unless `host.auth.mode` is
`none`. It does not expose prompts, job mutations, secrets, or ticket control.
Per-device tokens and reverse-proxy SSO are future auth modes on the same
listener.
The operator CLI can inspect prompts and operates directly on local state.
Secrets come from the process environment, preferably resolved with existing
fnox configuration. aivi does not implement a vault.

## OpenCode connection

Verified against OpenCode 2.0.3 (see [opencode.md](opencode.md)): the background
service lives on a random port with basic auth, so the host uses the SDK's
`Service.discover()` instead of a configured URL, once per job or conversation
turn. Bearer tokens are rejected. Every session aivi creates carries
`metadata.aivi = { origin, … }` so dreaming and future conversation indexing
select sessions by origin (`discord`, `job`, `dreaming`, later `linear`)
without inspecting content.

## Open work

Status and order live in [roadmap.md](roadmap.md); unscheduled ideas in
[backlog/](backlog/). Findings from code reviews are in [review/](review/);
they are findings, not specifications.
