# The reference ticket workflow

Status: **backlog idea (2026-10-03)**, kept from the superseded design history
(`plans/templates/orchestrator.md`, deleted when the run contracts moved fully
into [orchestrator.md](../orchestrator.md)). The mechanics it described —
stages, worker tools, the question contract, recovery — are **built** and
owned there. What lives here are the workflow ideas that were never built,
so the templates program can find them when it grows past seeding agent files.

## Triage as a worked lane

A ticket entering **Triage** (by a human, or by a worker's escape hatch —
out-of-scope work spotted mid-flight) wakes the **product** agent. It uses
knowledge tools to make sense of the ticket and picks one of three exits:

- **won't fix** — closed with a good reason;
- **refined** — it rewrites the ticket body and the walk takes it onward;
- **unclear** — the `ask` tool fires and a person's hands are on it (the
  human label plus a comment naming the questions to answer).

Today nothing wakes a lane-entry agent: lanes are read by the walk when it
is woken, and a triage lane with an agent is worked like any other lane —
which means the walk would delegate a fresh ticket like any other ticket.
For this idea, entering Triage is the trigger, refinement is the work, and
the queue lane (Todo) is where refined tickets wait for a human or for
capacity.

- A configurable `autonomous`-style label could let obvious work (dependency
  bumps) skip the human's pass over the refined ticket. Its real name and
  whether the skip is lane-config or label-config were never decided.
- **Backlog is a human lane on purpose**: nothing happens to a refined ticket
  there until a person (or the label above) moves it on.

## Interactive mode: the ticket subagent

A human opens OpenCode on their own machine, picks the `product` agent and
says "let's pick up ABC-123". The agent fetches and discusses the ticket
through a **ticket subagent** — a real OpenCode subagent, not bare MCP
tools: the Linear MCP is massive, and a subagent keeps that context out of
the conversation and answers immediately from prefill caches. No worktrees,
no aivi machinery — a normal session.

- The escape hatch works the same way: workers create out-of-scope tickets
  through the ticket subagent, so they need no platform tools of their own.
- Consequence for the seeded agent files: the same file must work
  **aivi-driven** (ticket handed in) and **human-driven** (nothing handed
  in). Today's files carry judgement for both but name no subagent.
- Ticket subagents may ship as optional "adapter agent" files inside the
  platform plugins.

## Where each built fact went instead

- Run states, stages, worker tools (`aivi_work_complete`, `aivi_ask`,
  `aivi_plan`, `aivi_push`, `aivi_pr`), the completion and question
  contracts, recovery: [orchestrator.md](../orchestrator.md) and
  [linear.md](../linear.md).
- Lanes, queue lanes, pools, leases, the dispatcher:
  [orchestrator.md](../orchestrator.md) (owner), with the built checklist in
  [plans/orchestrator.md](../plans/orchestrator.md).
- The git workflow (push, PR, the feedback loop):
  [plans/git-workflow.md](../plans/git-workflow.md).
