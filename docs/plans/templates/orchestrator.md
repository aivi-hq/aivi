# The ticket orchestrator

Status: draft (2026-09-27). Part of the [templates program](index.md). Lands
after [cli-refactor](../cli-refactor/index.md) phases 1–3; the adapter
contract lives in `@aivi/plugin/tracker`. Parent: [index.md](index.md).

## What it is

Everything the Linear module does today except speaking Linear: lane matching,
the delegate guards, worktree lifecycle, capacity and dispatch, the worker
exit contract, and the label. Extracted into host-shipped machinery that is
inert until a tracker adapter registers. Linear becomes the first adapter;
GitHub Issues and Jira are future adapters spelling the same vocabulary
differently.

## The adapter seam

An adapter is a translator in both directions and nothing else:

- `laneStates(team)` — lane name → the platform's real workflow states, so a
  proposed mapping can be validated against what exists.
- `createStates(missing)` — optional; opt-in with an explicit yes per team,
  never silent.
- `candidates(lane)` — ready issues in a lane, in the platform's own order,
  each with the facts needed to build a worker's first message.
- `apply(outcome)` — translate a platform-neutral outcome (move to lane X,
  add/remove label, leave a comment) into the platform's mutations: Linear
  `Cancelled`, GitHub `Closed`, Jira Done-with-reason.
- `events` — normalized signals: issue entered lane, label changed, delegate
  changed. Everything downstream keys off these, never off raw webhooks.

Deliberately **not** on the adapter: weights, ordering, capacity, worktrees,
the exit contract. GitHub-as-ticket-system is its own adapter plugin;
GitHub-as-repo-host (branches, PRs) is separate plumbing, the only repo host
today, with the choice kept reversible.

The seam's home follows cli-refactor's rules: the contract is the content of
the `@aivi/plugin/tracker` subpath (D6: subpath before package; the kind gets
its first content when the extraction lands it), and the Linear package is the
renamed `@aivi/tracker-linear` (D20). The tracker plugin is enabled the registry
way — listed in `aivi-plugins` (D9) — and at module start it registers with
the host-shipped orchestrator, which itself has no list entry: there is
nothing to disable until a tracker is installed, because an unwired
orchestrator does nothing.

## Lanes, three kinds

- **Agent lane** (`Triage`, `Dev`, `Review`): maps to an OpenCode agent; an
  issue entering it gets worked.
- **Queue lane** (`Todo`): no worker. Entry, or a freed lease, dispatches the
  top candidate. Auto-dispatch is optional: an unmapped `Todo` means fully
  human-driven delegation.
- **Human lane** (`Backlog`, `Release`): `null`. The orchestrator is silent —
  no comment, no move. Humans own priorities and the check that the assistant
  understood the assignment.

Per-project agent overrides (`.opencode/agents/` in the checkout) keep
working; a project can point `triage` at a different file than the org-wide
one.

## Dispatch and capacity

- **No stored queue.** The queue is the platform: lane membership plus the
  platform's own order (Linear's manual rank is exactly "human prioritized
  top to bottom"). A human reordering tickets in the UI is picked up on the
  next sort for free.
- The sort runs **when a lease frees, when an issue enters a queue lane, and
  at serve start** — never on a timer.
- The orchestrator owns the weights: in-flight (anything to the right of
  Todo) outranks fresh pickups; ties break on time-in-queue, stamped by the
  orchestrator when it first sees a candidate. Making the weight calculation
  the orchestrator's, behind a clear interface, was a deliberate decision.
- **Capacity is the existing pool** (pool size = max concurrent workers; 1 is
  the honest local-model setting). In-flight priority is nearly free: an
  in-flight worker grabs a lease the moment its trigger event lands, so a
  waiting pickup cannot outrank it.
- **Across platforms there is no merged queue.** Each tracker's order stays
  its own; the pool is the shared capacity; when a lease frees, the
  orchestrator collects ready candidates from every adapter, sorts once by
  (weight, time-in-queue), and takes the top. A second tracker never starves
  the first, and no platform's ordering leaks into another's.

## Worker lifecycle

- **Always a fresh session**: "here's a summary, go do work." Never a restored
  agent session. A **restored worktree** is a different thing: worktrees are
  keyed by branch (Linear hands us the branch name) and re-used when work
  concerns review comments.
- The orchestrator calls the worker with the ticket summary, the branch, and
  the worktree ready (or restored).
- Guards before spawning, all of them today's listener rules: lane mapped, no
  active delegate, no needs-human label, not natively blocked.
- Reviews go through **GitHub, not the ticket platform**: comments are left
  and answered on the PR, so a ticket's history in Linear stays
  decisions-and-why.

## The exit contract

A worker does work and reports what it did; the orchestrator is the one that
updates the ticket and the agent session.

- When the worker turn ends, the orchestrator runs one **wrap-up turn in the
  same session**: report what you did, answer with exactly this JSON shape.
  A tool was rejected as the carrier — deny-able by permissions, skippable,
  and it fires mid-session so it cannot report the final state.
- The report is validated by the orchestrator; a parse error is echoed and it
  retries, max a few tries.
- **Fallback on failure**: needs-human label + a comment saying the worker
  finished but could not report + an error + the session named, so the
  operator can read what was actually said in the host.
- The report is **platform-neutral** (`{outcome, lane, label, comment}`); the
  orchestrator executes it through the adapter. The ticket is re-read after
  acting, so a report that lies about a move is caught by reconciliation, not
  by trust.
- The orchestrator guarantees a visible signal always: ticket moved, label
  added, or comment left. Never silence.

## The label

One label, configurable name: "delegator no touchy". It parks a ticket with
questions and refuses delegation; it is cleared by humans only, and the
removal webhook retriggers automatically. Triage-and-refine and HITL are the
same label — one is just who wrote it.

## The workflow it drives

The operator's walkthrough, as understood:

- **Triage**: any ticket entering Triage (by a human, or by a worker's
  escape hatch — out-of-scope work spotted mid-flight) triggers the Product
  agent. It uses knowledge tools to make sense of the ticket and one of three
  exits: won't-fix with a good reason; refined and certain (it rewrites the
  ticket body, exits, the orchestrator moves it to Backlog); or unclear (the
  label + a comment naming the questions that must be answered to retry).
  99% of early triage will be the interactive form while ADRs accumulate.
- **Backlog is a human lane on purpose.** Nothing happens when a refined
  ticket lands there, until a human moves it to Todo. A configurable
  `autonomous`-style label may skip straight to Todo for obvious work
  (dependency bumps).
- **Todo is the queue lane**; the top ready ticket gets delegated to the Dev
  lane on freed capacity.
- **Dev** exits with a PR on GitHub and a move to Review, or back to Todo
  with the label and a comment (error, missing info, needs secrets).
- **Review** wakes a fresh review agent (a separate agent by default, though
  it is configurable to the dev agent) in the restored worktree. It owns the
  PR conversation. Back to Todo with review comments, or on to Release.
- **Release** is a human lane.

## Interactive mode

A human opens OpenCode on their own machine, picks the `product` agent, and
says "let's pick up ABC-123". The agent fetches and discusses the ticket
through a **ticket subagent** (a real OpenCode subagent, not bare MCP tools:
the Linear MCP is massive, and a subagent keeps that context out of the
conversation and answers immediately from prefill caches). No worktrees, no
aivi machinery — a normal session. Consequence for templates: **the same agent
file must work aivi-driven (worktree, branch, ticket handed in) and
human-driven (own checkout, no context handed in)**.

The escape hatch works the same way: workers create out-of-scope tickets into
Triage through the ticket subagent, so they need no platform tools — the
operator decides per agent file who gets which subagent. Ticket subagents may
ship as optional "adapter agent" files inside the platform plugins.

## Later, deliberately

- GitHub Issues and Jira adapters (the seam must prove they fit; GitHub
  Projects for lanes).
- A second repo host, if ever (nothing here should foreclose it).
- Carving the orchestrator into an installable unit, if shipping it always
  turns out to cost real weight.

## Open questions

- What wakes review when PR comments arrive after the review agent's first
  turn (GitHub events? a human moving the ticket back?).
- The `autonomous` label's real name, and whether the skip is lane-config or
  label-config.
- Whether the wrap-up turn takes its lease from the worker's pool or the
  conversation pool.
