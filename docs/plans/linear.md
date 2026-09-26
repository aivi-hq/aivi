# Linear module: what is left

Status: the module is built and [linear.md](../linear.md) owns the behaviour.
This file keeps only what no document could settle — the six verifications
and the live gates — plus the open build items and the deliberately-later
list. The build checklist, the vocabulary and the decisions are history:
the behaviour docs own what is, and git owns how it got built (this file was
shrunk 2026-09-26). Where a step below says "lock released" or "serialize",
the single-app rework (2026-09-19) replaced that: worktrees isolate, the
pool is the capacity, one worker per issue is the redelivery guard.
Requirements this serves: [requirements.md](../requirements.md) §2, §4, §5.

## Verify (facts no document could settle; each gates the work that needs it)

- [ ] **verify 1** (setup detail, not a blocker) Whether an app authorised
      only through `client_credentials` also receives `AgentSessionEvent`
      webhooks, or whether Linear needs one browser-based (`actor=app`)
      authorisation per app to create the workspace webhook. Either way the
      tokens come from client credentials; the answer decides one paragraph
      of setup in [linear.md](../linear.md).
- [ ] **verify 2** `agentSessionCreateOnIssue` + `issueUpdate(delegateId)` by
      the app itself: does a `created` webhook follow, or must the module
      start the worker from the mutation result? (The build assumes the
      latter is safe either way: the mutation result starts it, a later
      `created` for the same session id is a dedupe no-op.)
- [ ] **verify 3** `agent.list` with
      `directory: <home>/projects/<id>/worktrees/<x>` returns agents from
      `<home>/.opencode/agents/` and prefers the worktree's
      `.opencode/agents/` file of the same name. Record the result in
      [projects.md](../projects.md).
- [ ] **verify 4** The `stop` signal's payload shape (`agentActivity.signal`),
      `Issue.branchName` in the session payload or by query, and the
      delegate-removed notification (`issueUnassignedFromYou`) as they arrive
      today; the Webhooks schema explorer is the reference.
- [ ] **verify 5** An app user can be delegated issues in every mapped team,
      including a **private** team the app user has not joined; if membership
      is required, the setup says to add each app to every mapped team.
- [ ] **verify 6** The Issues data-change payload carries `teamId`. Routing
      does not depend on it (the module re-reads the issue from the API), but
      confirm it once.

## Live gates

The module has never been run live end to end. The per-step gates merged
into one list (2026-09-26); record results in [roadmap.md](../roadmap.md).

- [ ] One app receiving both webhook families on one route; a misrouted
      delivery seen and logged (`linear.logMisroutes`).
- [ ] A mention answered by the assistant (`linear.agent`).
- [ ] An issue delegated by hand → acknowledging `thought` → ephemeral
      progress activities → `response`; a follow-up prompt continues the
      worker's own session.
- [ ] A delegation whose lane maps an agent runs it; a delegation into an
      unmapped lane refused and un-delegated, the delegate left un-taken.
- [ ] A stop request → `error` activity naming the worktree and the OpenCode
      session, `stopped` turn, capacity released, worktree kept.
- [ ] The HITL label refusing a hand delegation and stopping a pending
      worker.
- [ ] Two workers in one project running concurrently in separate worktrees;
      a `worktree: false` lane running in the project checkout.
- [ ] `blockedBy` visibly holding a delegation back.
- [ ] The Linear MCP tools usable from a worker session, writes attributing
      to the app.
- [ ] An issue in a mapped team with no Linear project routes; one from a
      second mapped team works the same checkout.
- [ ] `projects.sync` fast-forwarding `source/` after a merge.
- [ ] `projects add <git-url> --linear PEC` and one interactive
      `projects create` against the real workspace (where verify 5 lands),
      plus one `--lane`/`--unlane` write.

## Open build items

- Worker session title `<identifier> <title>` and richer session metadata.
- Worktree pruning by age, never while its turn is pending — lands with the
  sweep ([linear-worktree-lifecycle](../backlog/linear-worktree-lifecycle.md)).

## Later, deliberately

- Graceful agent-first cleanup with deadlines
  ([requirements §4](../requirements.md#changes-while-work-is-active),
  [shutdown-hooks](../backlog/shutdown-hooks.md)) for effects a worktree
  does not contain (a test database migration); needs a way for the agent to
  report "cleanup complete" (a plugin tool) and a per-project definition of
  clean.
- More than one worker per project as a configured limit (worktrees already
  isolate them; the pool is the capacity).
- Per-project `worktree: { copy: [".env"], setup: ["npm ci"] }` for what a
  fresh worktree cannot regenerate.
- Permission prompts as `elicitation` (with `select`), answered through
  `prompted`.
- Agent plans (`agentSession.plan`) from the progress model's tool list;
  `externalUrls` once there is something to link to.
- Moving the issue to the first `started` state on delegation; moving on
  completion by configuration.
- Reading Linear's Inbox notification category for unassignment if verify 4
  shows it is the only signal.
