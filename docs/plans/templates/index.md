# Templates program

Status: draft (2026-09-27), from a vision conversation with the operator. Not
scheduled, no owner. Reconciled 2026-09-27 with
[cli-refactor](../cli-refactor/index.md) (planned): it owns `@aivi/plugin`,
the `aivi-plugins` list, the `@aivi/<kind>-<name>` naming, and the
enablement rule; this program builds on that floor.

## The goal

Install aivi, install a ticket-system plugin, scaffold the config with a
template, and from that moment triage, refine, and delegate tickets.
Templates are the last mile; the program is really about the machine a
template scaffolds.

## The pieces

| Piece | What it is |
| --- | --- |
| [orchestrator.md](orchestrator.md) | The platform-neutral ticket orchestrator: lanes, guards, dispatch, capacity, worktrees, the worker exit contract. Extracted from the Linear module; Linear becomes an adapter. |
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
- **The orchestrator ships with the host, inert until wired** (the operator
  agreed with reservations: if it turns out to cost a lot, it can be carved
  into an installable unit later; the adapter seam is what makes that a
  `git mv`). It is host machinery, **not a plugin**: it gets no `aivi-plugins`
  entry, and tracker plugins register with it at module start the way tools
  claim on the `ToolRegistry` (the precedent cli-refactor cites in D18).

## Template ≠ plugin

Decided 2026-09-27 by the operator: the word is **template**, chosen because
`packages/cli/templates/agents/` is already where the seeded assistant and
dreamer files live — the name points at the mechanism that exists, not a new
one. A **plugin** is an installed capability with a runtime, listed in
`aivi-plugins`; a **template** is files copied once, with no runtime and no
list entry. The docs keep the two words apart the same way every day:
*install a plugin, apply a template.*

## Sequence

cli-refactor phases 1–3 (one CLI, the kit, the registry) are the floor: the
Linear rename to `@aivi/tracker-linear` (D20) and the registry loop (D9) must
be in before the module is rebuilt, and D22 (no migration, `dev/` gets nuked)
removes every compat burden from the rebuild. On top of that floor:

1. **Orchestrator first.** The Linear module is rebuilt to this design, not
   verified against the old one: the live gates in
   [plans/linear.md](../linear.md) are dropped as history, since the module
   has never run live end to end. The extraction is also where the adapter
   contract lands in `@aivi/plugin/tracker`: cli-refactor defers that subpath
   "when the first tracker beyond Linear exists", and the extraction is the
   moment there is something to put in it (the D6 subpath-before-package
   rule is honored — the kind's first content is the seam Linear itself
   implements).
2. **Scaffolding second**: it scaffolds what the orchestrator consumes.
3. **Self-knowledge** needs phase 3 (the plugin list and the composed
   schema), then can land any time.

## Open before build

- Which facts from these pages supersede `docs/linear.md` at build time, and
  what that page keeps.
