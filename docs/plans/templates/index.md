# Templates program

Status: two pieces built 2026-10-03 — the [scaffolding](scaffolding.md)
agent files ship with the home, and [self-knowledge](self-knowledge.md) is
complete (`manual` sources and `aivi_config`); the lane-map proposal stays
open. Before that: crystallizing (2026-09-29, with the operator): scheduled
into the [v1 rc line](../../roadmap.md#next-in-order-of-intent), sequence and
the linear.md supersession recorded below. From a vision conversation
(2026-09-27); reconciled 2026-09-27 with
[cli-refactor](../cli-refactor/index.md) (built on the branch): it owns
`@aivi/plugin`, the `aivi-plugins` list, the `@aivi/<kind>-<name>` naming,
and the enablement rule; this program builds on that floor.

## The goal

Install aivi, install a ticket-system plugin, scaffold the config with a
template, and from that moment triage, refine, and delegate tickets.
Templates are the last mile; the program is really about the machine a
template scaffolds.

## The pieces

| Piece | What it is |
| --- | --- |
| [orchestrator.md](../orchestrator.md) | The platform-neutral ticket orchestrator's run contracts: run states, worker tools, the completion and question contracts, recovery, the adapter seam — built and owned there since 2026-10-02; this program's design-history copy was retired 2026-10-03, its never-built workflow ideas parked in [backlog/ticket-workflow.md](../../backlog/ticket-workflow.md). |
| [scaffolding.md](scaffolding.md) | Templates proper: plain agent files (product, dev, review) plus a proposed lane map, offered at setup and at ticket-system install. Written once, then yours. |
| [self-knowledge.md](self-knowledge.md) | The assistant knows what is installed, learns it from plugin docs (the `manual` source kind), and edits `config.json` for you through a validated tool. |

## Decisions that span the pieces

- **The adapter translates; the orchestrator decides.** An adapter knows its
  platform in both directions (webhooks in, ticket mutations out, state-name
  lookup). Weights, ordering, capacity, worktrees, guards, and the exit
  contract are orchestrator policy and never appear on the adapter side.
- **One label**, configurable name, meaning "delegator no touchy" (today's
  HITL label). Only humans clear it; the label-change webhook retriggers
  automatically (verified live 2026-09-26).
- **Workers are platform-blind.** A worker knows its instructions and its
  exit report, never Linear or GitHub or Jira. The Product agent is the one
  exception by convention: it edits ticket descriptions, and does so through
  a ticket subagent, not by knowing the platform itself.
- **Templates are example files.** Written once, no identity afterwards, no
  uninstall or upgrade machinery. Editing the written files is the whole
  configuration.
- **The orchestrator ships with the host, inert until wired** — confirmed
  2026-09-29 over a separate package: you can never install the host
  without it, and the host is the core (the `@aivi/core` name is a
  historical accident; the host is what's core). Its plumbing lives in a
  neat directory in the host; the contracts plugins code against live in
  `@aivi/plugin/tracker` and `@aivi/plugin/forge`, like every other kind.
  A name for the machinery is open. It is **not a plugin**: no
  `aivi-plugins` entry; tracker plugins register with it at module start
  the way tools claim on the `ToolRegistry` (D18).
- **Capabilities are what the orchestrator asks about — never how the
  tracker delivers** (ruled 2026-09-29). "Agent session" is not a
  capability; it is how Linear delivers updates, and every tracker
  decides its own delivery. "Delegate" is `assign` at the seam, and
  Linear decides that assign means delegate. What *is* a capability: a
  fact the orchestrator needs and cannot compute — branch name, whether a
  PR exists. Each capability has a fallback chain for trackers that lack
  it (branch: config `branchNameStrategy` → tracker's reported branch name
  → `feat/<ticket>` with a counter on conflict). The list grows with each
  tracker added and is deliberately small until then.

## Template ≠ plugin

Decided 2026-09-27 by the operator: the word is **template**, chosen because
`packages/cli/templates/agents/` is already where the seeded assistant and
dreamer files live — the name points at the mechanism that exists, not a new
one. A **plugin** is an installed capability with a runtime, listed in
`aivi-plugins`; a **template** is files copied once, with no runtime and no
list entry. The docs keep the two words apart the same way every day:
*install a plugin, apply a template.*

## Sequence — the v1 rc line (ruled 2026-09-29, reordered the same day)

cli-refactor phases 1–3 are the floor and they are **built** (unmerged
branch `refactor/single-cli-command`); D22 (no migration, `dev/` gets
nuked) removes every compat burden from the rebuilds. Forge-github was
moved **in front** of the tracker work so review facts would exist for
the orchestrator; the operator reversed that the same day — building
the orchestrator on the **base flow** (ticket → conversational agent →
tracker update) and adding the forge afterwards is build-test-solve
instead of pre-design, and the forge path cannot be tested before the
no-forge flow exists. The Linear rebuild still splits in two steps —
the tracker first, then the orchestrator:

1. **Compose-projects fix**: plugins contribute project-section
   schemas; `linear.lanes` leaves core's `projectSchema`. Direction
   ruled: project config is a **core concept** (projects are core like
   the host and the orchestrator); a project can be configured with a
   **forge type**, a lane can be configured to **use the forge** —
   which is what makes the worktree stuff happen.
2. **Tracker extraction**: Linear speaks through the adapter seam
   (`@aivi/plugin/tracker`); the orchestrator vocabulary is defined by
   what Linear's extraction needs, honoring reported capabilities and
   falling back where a tracker lacks one.
3. **Orchestrator extraction**: the machinery — lanes, guards, dispatch,
   capacity, worktrees, the exit contract, the label — moves out of the
   tracker into the host, inert until a tracker registers, **proven on
   the base flow** first: tracker → agent → tracker with a conversational
   worker, no worktree, no forge. The live gates in
   [plans/linear.md](../linear.md) are dropped as history; the module
   is rebuilt to this design, not verified against the old one.
   **Live gate (ruled 2026-09-29)**: after 1–3, a simple todo board
   runs **research-type tickets** end to end — and the architecture is
   the point: simple to read, open to extension (the purpose of the
   whole refactor). Forge-github (4) starts only when that passes.
4. **Forge-github**: the forge joins the proven orchestrator as the
   configurable path it is — worked wake examples written while
   building, not invented before it. The contract lands in
   `@aivi/plugin/forge`. GitHub-as-ticket-system stays a possible
   future tracker, separate.
5. **Knowledge as a plugin** (cli-refactor's standing follow-up).
6. **A last look at jobs.**
7. **Tag v1 rc** — with everything above landed; changesets and the
   bump calls are made once, at the end (operator's ruling: the whole v1
   rc is one release, no RC dist-tags before users exist).

Self-knowledge needs the registry (built) and can land any time after.

## What supersedes what (closed 2026-09-29)

- **[linear.md](../../linear.md)** owns Linear's behavior **until the
  extraction lands each piece**; it is not edited ahead of the code.
  After the extraction it keeps the adapter's life — app/face/primary,
  webhook families, signature verification, the setup installer, the
  Linear MCP forwarder, and the Linear *spellings*: `delegate` is how
  Linear says "assigned", agent-session activities are how Linear delivers
  updates, lane states are Linear workflow states.
- **This page (orchestrator.md)** owns the machinery's design and the
  behavior changes ruled 2026-09-29: branch-keyed worktrees updated from
  the forge, the wrap-up report turn, the HITL park-and-restart rule, the
  queue weights, review facts gathered from the forge at wake. It is
  **provisional by design**: more trackers will move details (the
  operator's words: "none of the docs are final").
- **plans/linear.md** keeps only the unverified facts (verify 3–5) and
  what waits past v1; the live gates die with the rebuild ruling above.
