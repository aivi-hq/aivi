# Projects, one agent per project, and quiet-time maintenance

Status: idea from the owner (2026-09-14); pre-research wanted.

## Projects

- A project is a git repository checked out on the server. aivi's config
  registers it (`projects[]` with `aivi.project.json` inside for knowledge
  sources; later the Linear lane mapping). Nothing else needs a copy of that
  registry: the OpenCode plugin asks the host (`aivi_sources`), agents work in
  the checkout.
- Adding a project should be one command (or one chat request in editor mode):
  clone, register, index.

## Capacity

- One active agent per project at a time (a simple lock keyed by project);
  git worktrees may later allow parallel work in one repo.
- Dreaming and indexing are maintenance: they should run when no agent is
  working, from the same queue, rather than at a fixed cron regardless of load.
  Today they share the `local-model`/`maintenance` pools but nothing expresses
  "only when idle".

## Questions

- Is "idle" measured from aivi's own leases only, or also from interactive
  OpenCode sessions on the server (`session.active`)?
- Do maintenance tasks have a deadline ("run tonight, but no later than 06:00
  even if busy")?
- How does a per-project lock interact with Discord conversations that only
  read a project?

## Research

Researched 2026-09-14. Companion to the research in [jobs.md](jobs.md); only the
facts relevant to locking and idleness are repeated here.

### What the code already has

- Capacity is one table plus one union query. `scheduler.maxConcurrent` bounds
  the sum of `jobs` in `running|blocked` and every row in `resource_leases`;
  `scheduler.resources[pool]` bounds the same sum per pool
  (`Store.capacityUsage`, `packages/host/src/store.ts:282`). `claim()` walks
  queued jobs in due order and skips any whose pool is full; `acquireLease()`
  reserves a pool slot for non-job work inside one `BEGIN IMMEDIATE`
  transaction, letting the caller flip its own state in `onAcquire`.
- Conversation turns are that non-job work: `ConversationStore.claim` takes
  lease `<module>:<turnId>` in `config.resource` (default `local-model`) and
  releases it in `sent()`; a failed turn blocks the lease instead
  (`packages/host/src/channel/store.ts`). Blocked leases survive restarts
  (`blockLeasesOwnedBy`).
- A job or lease has exactly one `resource`. Nothing records *which project*
  a job touches; `opencode.prompt` and `dreaming` carry a `directory`, `shell`
  a `cwd`, and `projects[]` in `aivi.json` carries each project's `directory`.
- Both drivers poll: the host ticks the scheduler every `pollMs` (1 s), Discord
  its engine every 500 ms. There is no "idle" notion anywhere; the closest is
  `capacityUsage()` returning no rows.
- `dreaming.md` already lists "a queue-aware schedule that waits for quiet hours
  instead of a fixed cron" as future work.

### What others do

- OpenClaw's heartbeat is the only "run when quiet" primitive found: monitor
  turns "defer while the main queue or automation work is busy, another run for
  the same agent is active, or the target session has active or queued work"
  (<https://docs.openclaw.ai/automation>). Ordinary automations do not defer.
- Hermes has no idle policy. Overlap is prevented per job (an in-flight guard,
  "already running" refusals) and globally by `cron.max_parallel_jobs`; a job
  may pin a `workdir`, and "each agent run binds its workdir to that run's
  unique task identity" so concurrent runs in different directories do not
  collide (<https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>).
  Neither project locks a repository.
- OpenCode v2 exposes per-session state and a live event stream
  (<https://opencode.ai/v2/docs/build/client/>) and a durable per-session inbox
  (<https://opencode.ai/v2/docs/api/session/v2-session-inbox-list>), but no
  per-directory lock and no notion of "server idle". Events are live-only with
  no replay, so idleness cannot be reconstructed from them after a restart. The
  v2 client documentation fetched for this note did not show a `session.active`
  operation; whether one exists must be confirmed at the live boundary
  (`npm run live:opencode`), not assumed.

## Recommendation

### Projects

Keep `projects[]` as the only registry. "Add a project" is one operator command
(`aivi projects add <git-url> [--id]`: clone under a configured `projectsDirectory`,
append to `aivi.json`, run `knowledge.index`) and is not needed for the lock or
idle work below; do it when the Linear adapter needs it.

### One active agent per project: a pool with limit 1

Do not add a lock table. A project lock *is* a resource pool with limit 1, and
the store already enforces pool limits atomically for jobs and leases. What is
missing is that one unit of work may need two pools (`local-model` and the
project). Smallest change:

1. Schema v5: `jobs.project TEXT NULL`, `resource_leases.project TEXT NULL`.
2. `capacityUsage()` additionally emits `'project:' || project` rows for the
   same job states and for every lease; `claim()`/`acquireLease()` check the
   project pseudo-pool with limit 1 next to the named pool. About twenty lines.
3. Derive, never type: at `loadConfig`, a task whose `directory`/`cwd` resolves
   inside a registered project's directory gets `project: <id>`. Anything
   outside every project (the librarian directory, `system.check`,
   `knowledge.index`) has `project: null` and takes no project slot.
4. Discord: the librarian's `directory` is not a project checkout, so turns
   keep `project: null`. This answers the third question: conversations that
   only *read* a project (through `knowledge_search`) never take the lock;
   only work executing *in* the checkout does, and AGENTS.md already says
   Discord does not execute project work.

Config shape (optional; the default is what most installations want):

```json
{ "projects": [{ "id": "acme", "directory": "../acme", "concurrency": 1 }] }
```

`concurrency` defaults to 1 and is the future knob for worktrees. It is not
added to `scheduler.resources`; the pseudo-pool name `project:<id>` is reserved
and rejected there. Blocked work keeps the project locked until `jobs resolve`,
exactly like a pool slot today.

Should OpenCode's own interactive sessions count? Not for the lock. aivi cannot
take a lease on behalf of a human at the TUI, and refusing to queue an agent
because the operator has the repo open would surprise more than it protects.
The lock is between things aivi starts; git itself and the human remain
responsible for the rest.

### Maintenance only when idle

Express it on the schedule, enforce it in `claim()`:

```json
{
  "id": "dreaming",
  "cron": "0 22 * * *",
  "timezone": "Europe/Amsterdam",
  "resource": "local-model",
  "when": { "idle": true, "deadline": "06:00" },
  "task": { "kind": "dreaming", "…": "…" }
}
```

- Semantics: the occurrence is materialized at 22:00 as today (one outstanding
  per schedule, coalesce unchanged). While `when.idle` applies, `claim()` only
  takes the job when `capacityUsage()` is empty: no running or blocked job, no
  lease, across *all* pools. At `deadline` (next wall-clock time after the
  occurrence, in the schedule's timezone) the idle requirement lapses and the
  job competes for capacity normally. No deadline means it waits as long as
  needed.
- Smallest change: `jobs.idle_until INTEGER NULL` (same schema step as above),
  set by `materializeDue` from `when`; `claim()` adds
  `AND (idle_until IS NULL OR idle_until <= ? OR <no active rows>)`. `when` is
  validated with `cron`/`timezone` in `scheduleSchema`. `knowledge.index` and
  `dreaming` schedules in the examples get `when: { idle: true }`.
- "Idle" means aivi's own leases and jobs only. Native OpenCode sessions are
  not consulted in the first version: a human typing in the TUI is not
  competing for the `local-model` pool unless that model is the shared local
  one, and even then the cost is contention, not corruption. If live
  verification shows a usable per-session busy signal, add
  `when.idle: "aivi" | "aivi+native"` with the native check as a *soft*
  condition (skip this tick, never block), keeping the deadline as the
  guarantee.
- Hysteresis (idle for at least N minutes before starting) is deliberately
  left out; the deadline already bounds worst-case lateness and Discord's
  queue is served one turn per channel, so a maintenance job slipping in
  between two turns costs one waiting turn, which the pool already implies.

### What to defer

- Worktrees: parallel agents in one repository become `concurrency: N` plus a
  worktree allocator that hands each job a path; the pseudo-pool stays the
  same. Nothing above blocks it.
- Native-session busy detection (`session.active` or equivalent): verify on
  the live installation first.
- Idle hysteresis and a `last_active_at` marker.
- Per-project idle ("run project X's indexing when *X* is idle") is just
  `when.idle` plus the project pseudo-pool; add when a project-scoped
  maintenance task exists.
- Multi-machine or network-filesystem coordination: out of scope per
  `architecture.md`.

### Order of work

1. Schema v5 (`project`, `idle_until`), derivation in `loadConfig`, pseudo-pool
   accounting in `capacityUsage`/`claim`/`acquireLease`, tests at the store
   boundary with two projects and one pool.
2. `when` on `scheduleSchema`, `materializeDue` sets `idle_until`, example
   configs updated, `dreaming.md` "Later" paragraph resolved.
3. `projects[].concurrency` (accept only `1` until worktrees exist).
