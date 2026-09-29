# The ticket orchestrator

Status: crystallizing (2026-09-29, with the operator). Part of the
[templates program](index.md). The behavior rulings of 2026-09-29 are
recorded here; the capabilities list and the extraction's details are
explicitly **provisional** — more trackers will move them. Sequence:
forge-github first, then tracker extraction, then this extraction.
Parent: [index.md](index.md).

## What it is

Everything the Linear module does today except speaking Linear: lane matching,
the delegate guards, worktree lifecycle, capacity and dispatch, the worker
exit contract, and the label. Extracted into host-shipped machinery that is
inert until a tracker adapter registers. Linear becomes the first adapter;
GitHub Issues and Jira are future adapters spelling the same vocabulary
differently.

**Glue, not a ticket-machine** (ruled 2026-09-29; the name is still up
for grabs). The orchestrator orchestrates *everything*: the seam between
tracker, forge, channels, and mail. A ticket need not touch a repository
at all — "research X, make a PDF, email it" — so the forge steps are a
**configurable path**, entered only when the ticket's project has a
forge, never a hardcoded route every worker walks
([forge-github.md](../forge-github.md)).

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
GitHub-as-repo-host (branches, PRs, review feedback) is separate plumbing —
the forge, `@aivi/plugin/forge` — and it lands **before** this extraction,
because review facts are gathered from the forge at wake (below).

**Capabilities: what the orchestrator asks; delivery: what the tracker
decides** (ruled 2026-09-29). The seam must not turn everything a tracker
does into a capability. Agent-session updates are not a capability —
updates go back platform-neutral and the tracker decides how to deliver
them (Linear informs the agent session; another tracker posts a comment).
`assign` is the neutral word; Linear spells it `delegate`. Capabilities
are the **facts the orchestrator needs and cannot compute**, each with a
fallback chain for trackers that lack it. Worked example, the branch name:
`project.branchNameStrategy` (config) → the tracker's reported branch name
(Linear: `Issue.branchName`) → `feat/<ticket>` with a counter on conflict.
Candidate list, provisional and deliberately small: branch name; whether a
PR exists and where (Linear can say; others need the forge to answer by
branch). Everything else earns its way onto the list when a second tracker
needs it.

The seam's home: the contracts plugins code against are the content of the
`@aivi/plugin/tracker` and `@aivi/plugin/forge` subpaths (D6: subpath
before package; the kinds get their first content from these extractions).
The machinery itself ships **in the host** — confirmed 2026-09-29: the host
is the core, and no install has the host without it — in one neat
directory; a name is open. The tracker plugin is enabled the registry
way — listed in `aivi-plugins` (D9) — and at module start it registers with
the orchestrator, which itself has no list entry: there is
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
  Confirmed 2026-09-29: the point is a **predictable processing order** —
  in-flight first; when one finishes or parks behind the HITL label, the
  freed capacity takes the next in order.
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
  **keyed by branch** (ruled 2026-09-29, superseding today's
  `<agent session>` directory naming), and before a worker starts on a
  restored worktree the orchestrator brings it up to date with the forge —
  recovery is an update, not a new checkout.
- The orchestrator calls the worker with the ticket summary, the branch, and
  the worktree ready (or restored).
- Guards before spawning, all of them today's listener rules: lane mapped, no
  active delegate, no needs-human label, not natively blocked.
- **The worker never talks to a human live** (ruled 2026-09-29). When it
  is stuck it leaves a comment on the ticket and adds the HITL label; that
  parks the ticket. A human answers in a new comment and removes the label;
  the label-removal webhook then starts a **fresh session** in the recovered
  worktree, with the full ticket context — including the worker's question
  and the human's answer, which the fresh session reads from the ticket
  like any other fact. Resuming the *asking* session on the answer webhook
  was rejected: the orchestrator is deterministic code and cannot know a
  trigger is an answer, and guessing is the fragile kind of clever.
  Revisit post-v1.
- Reviews go through **the forge, not the ticket platform**: comments are
  left and answered on the PR, so a ticket's history in Linear stays
  decisions-and-why.

## The exit contract

A worker does work and reports what it did; the orchestrator is the one that
updates the ticket.

- **The schema instruction rides at session start** — *finish your turn
  by answering following this schema exactly, no other text* — and the
  orchestrator validates the turn's closing message (ruled 2026-09-29,
  refining the earlier dedicated-turn ruling). A failed validation is
  re-asked in a dedicated turn carrying the schema — the worry that a
  long session forgets the instruction is now caught by validation
  instead of hope.
- The report is **platform-neutral** (ruled 2026-09-29: the worker does
  not report a lane — success or failure is its knowledge; the
  orchestrator knows the lanes to either side from its own config and
  makes the move). It carries what the orchestrator needs to act:
  `{outcome, comment}`, plus **the PR message** and **any deviations**
  when the ticket touched a repository (the forge path is configurable,
  not every ticket has a forge). The orchestrator executes through the
  adapter: a plain write to the ticket, no re-read to "catch lying" —
  the orchestrator is deterministic code, and what it writes is what is
  true.
- The report is validated by the orchestrator; a parse error is echoed and it
  retries, max a few tries.
- **Fallback on failure**: needs-human label + a comment saying the worker
  finished but could not report + an error + the session named, so the
  operator can read what was actually said in the host.
- The orchestrator guarantees a visible signal always: ticket moved, label
  added, or comment left. Never silence.
- **Resolved 2026-09-29: no tool.** The operator's ruling — a tool
  cannot link back to the orchestrator without plumbing, and a tool call
  is itself an instruction; the schema-at-start + validated closing
  message + re-ask above is the mechanism.

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

- **Resolved 2026-09-29 — what wakes review when PR comments arrive:**
  nothing does, and nothing needs to. The tracker leads and holds the
  working state: the reviewer finishes by moving the ticket (back to Dev),
  and the lane webhook wakes the next worker. Review feedback is not a
  wake signal — it is a fact gathered **from the forge** as part of
  collecting everything before a worker wakes (Linear helps: telling us a
  PR exists is one of its reported capabilities).
- The name of the machinery itself (host directory, vocabulary).
- The capabilities list, by design, grows with each tracker added — every
  entry needs its fallback chain spelled out before a second tracker
  ships.
- The `autonomous` label's real name, and whether the skip is lane-config or
  label-config.
- Whether the wrap-up turn takes its lease from the worker's pool or the
  conversation pool.
