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
Modules are explicit packages with a small start/stop contract; this is
ordinary TypeScript composition, no NestJS, decorators or service locator.

## One application, contained modules

`aivi serve` starts the HTTP API, scheduler, knowledge service, and configured
modules together. Discord and Slack are package boundaries, not deployment
boundaries; a future Linear module will receive webhooks through the same host
listener and use the same services. Only a configured module loads its SDK, and
only enabled search loads QMD.

Modules receive a `HostServices` object containing the loaded installation
config, store, knowledge service, optional browser service, an `opencode()`
client factory, a structured logger, the shutdown signal, the `channels`
registry where chat modules register ([channels](channels.md)), `wake()` and
`fail()`. They return an asynchronous `stop` function. They call shared
services directly, rather than calling the host over HTTP from inside the same
application.

`fail()` aborts the whole host and is reserved for conditions the host cannot
run without (an unreliable store). A module's `start` may throw
`ConfigurationError` for what only the operator can fix; anything else is
retried with backoff while the module shows as `degraded`, because an optional
module must never take the knowledge server and scheduler down
([operations](operations.md#startup)).

Adapters keep their own tables in the host database under a name prefix and
declare them through `Store.migrate(namespace, steps)`, which versions them
independently of the host schema. Host tables are only reached through `Store`
methods; shared capacity uses `acquireLease`/`releaseLease`/`blockLease`.

OpenCode plugins live inside the native runtime, so they use the host's
authenticated API. `knowledge_search` reaches the same service used by the
channels' search commands and scheduled indexing jobs; `aivi_jobs` reaches the
same store the CLI edits.

What happens at startup, tick and shutdown, and how runs end, is described for
operators in [operations](operations.md).

## SQLite and Croner

SQLite stores job definitions (`jobs`), their runs (`runs`: task snapshot,
ownership, result, timing), leases and audit history. The host schema is
versioned (`HOST_SCHEMA_VERSION` in `store.ts`; today 7, where definitions
and executions were separated and every one-off got a definition of its own)
and adapters version their own namespaced tables through `Store.migrate`.
Channel modules store their inbox and session mappings in the same database
that way (`<module>_turns`, `<module>_sessions`; [channels](channels.md));
a turn claim and its lease are atomic.
Croner is only a timezone-aware date calculator. The host loop sleeps until the
next due instant (`Store.nextDue`: the earliest future occurrence of an active
job, recurring or one-off), and is woken early when the queue changes: the
jobs tool, a run or Discord turn releasing capacity, or the CLI poking
`POST /v1/wake` after it wrote to SQLite (and says so when the host cannot be
reached). Nothing periodic exists: no safety-net interval, no polling. No
in-memory timer holds state, so a crash or restart has nothing to reconcile. A tick does not invoke a model unless a queued task requests one.

`BEGIN IMMEDIATE` transactions serialize job creation, materialization of due
occurrences into runs, and run claims. Unique keys on definitions deduplicate
identical requests. A partial unique index allows only one outstanding run per
job. WAL enables readers while the daemon operates. Node's built-in SQLite
avoids a separate native addon.

This is a single-machine design. A singleton owner and PID prevent competing
daemons on one database. PID reuse is treated conservatively as an existing
owner; an operator may need to investigate it. Do not share the database between
machines or use a network filesystem as a coordination mechanism.

Misfire is one rule: an occurrence either matched its time or it did not. A
due occurrence found within `misfire.graceSeconds` (60 by default) becomes a
queued run; one found later becomes a `missed` run, terminal, never executed,
reported like a failure, and the job advances past now. Downtime therefore
leaves one `missed` run per job for the whole gap, not one per skipped
minute, and running late is never silent. A maintenance job that should run
whenever aivi is back sets a large grace. Occurrences that arrive while a run
of the same job is still outstanding are skipped without a record. A task
requiring every occurrence needs an explicit new policy.
Croner defines DST behavior; use UTC when repeated/skipped local wall times are
undesirable. Store timestamps are UTC milliseconds.

## Ownership before execution

Run states are `queued`, `running`, `succeeded`, `failed`, `blocked`,
`cancelled` and `missed`. Queued cancellation has no external effects. A
running or blocked run occupies global capacity and its resource-pool slot.
Job states are `active`, `paused` and, for one-offs, `done` or `missed`.

An OpenCode submission saves an intended session ID before calling the server.
The request carries stable session/message IDs and job metadata. If a response
is lost, the operator has a reconciliation target. This does not promise
exactly-once external effects and there are no automatic dispatch retries.

One session driver (`runTurn`) serves jobs, dreaming and Discord: it verifies
a final answer from the native context rather than trusting idleness.
Unattended turns auto-reject permission prompts by default, so a read-only
agent keeps going and the denial is recorded. A failure before the prompt is
accepted (`TurnNotStarted`) means nothing ran: runs end `failed`, Discord
turns are discarded and their capacity released. Anything after that which
cannot be verified (timeout, failed turn, changed agent, host shutdown
mid-turn) blocks; `runs resolve` records the operator's decision and neither
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
knowledge search, optional permission-gated browser operations, and one job
mutation: `POST /v1/jobs`, the back end of the `aivi_jobs` tool.
`/health` is public; everything else requires the bearer token unless
`host.auth.mode` is `none`. The jobs route is a deliberate revision of the
earlier "no job mutations over the API" rule (2026-09-15): it is limited to what
an agent may do for a person who asked (its own agent and directory by default,
a report the destination accepts, no other task kinds, refused from job
sessions) and can be switched off with `scheduler.agentSchedules: false`; the API still
exposes no prompts, secrets, or ticket control.
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
without inspecting content. Messages aivi submits carry the same shape; a job
outcome brought back into a conversation is a message with origin `job-result`.

## Jobs and runs

Definitions (`jobs`, recurring or one-off) and executions (`runs`) are separate
tables; one grace rule decides matched or missed; retention is a system job.
The facts live in [configuration.md](configuration.md) and
[operations.md](operations.md); the research that informed them in
[research/jobs-2026-09-14.md](research/jobs-2026-09-14.md). Deliberately not
built until someone asks twice:

- Standing sessions per job (memory across runs belongs in files; if ever
  wanted: `session: "standing"`, a session id derived from the job id,
  OpenCode's inbox for ordering).
- Retries after the model or the process was reached.
- Digests and a "home channel".
- Executable allow-lists for scripts; `[SILENT]`-style markers (the librarian
  reading a re-entered result *is* the silence mechanism).
- Natural-language time parsing in aivi (the model translates; the tool
  echoes the next occurrences).
- Structured confirmation widgets in Discord ([discord-widgets](backlog/discord-widgets.md)).
- Per-user ownership of agent-created jobs: today every agent-created job is
  visible to and mutable by every caller the access policy admits; the owner
  accepted "jobs are the admin's responsibility" for now.
- A per-occurrence record of every missed minute (one `missed` run per job
  per gap was chosen so a week of downtime is one line).
- Editing a definition in place (`update`); today it is remove and create.

## Open work

Status and order live in [roadmap.md](roadmap.md); unscheduled ideas in
[backlog/](backlog/). Findings from code reviews are in [review/](review/);
they are findings, not specifications.
