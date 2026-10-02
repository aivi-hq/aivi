# Template scaffolding

Status: draft (2026-09-27). Part of the [templates program](index.md). Builds
after [orchestrator.md](orchestrator.md), whose lane kinds and guards it
scaffolds. Parent: [index.md](index.md). Supersedes
[backlog/agent-presets.md](../../backlog/agent-presets.md).

## What it is

The thing you install: plain agent files plus a proposed lane map, so a fresh
aivi can triage, refine, and delegate on day one. The analogy the operator
endorsed: what "new project" example files are in every other tool.

## The shape

- A template is a folder shipped with the CLI (in the spirit of
  `packages/cli/templates/agents/`): agent files — **Product, Dev, Review**
  to start, the minimal set — plus a manifest proposing lane → agent
  mappings. Maybe a smaller second template (Product + Dev only) later. One is
  plenty for now.
- **Written once, then plain files.** No template runtime, no tracked "installed
  template" identity, no uninstall command, no `template upgrade`. Uninstalling is
  "delete these files, unmap these lanes", which the docs say. Editing the
  written file is the whole configuration.
- Template agents **can** reference a ticket subagent (shipped optionally by the
  platform plugin); they must not require it.

## The flow

In cli-refactor's world, `aivi install tracker-linear` writes the three facts
at once — npm dependency, `aivi-plugins` list entry, config block — and its
`./setup` owns the screen with the runner's own clack. The template flow is the
tail of that install, and of `aivi setup`.

1. `aivi setup` optionally installs the base agents (it already seeds the
   assistant and the dreamer and never overwrites what exists).
2. Installing a ticket system proposes the lane map: the template manifest is
   matched best-effort against the team's **real** states (read through the
   adapter's `laneStates`), after checking what the team already has.
3. The operator accepts or customizes. Missing states may be **created** with
   one explicit yes per team, and the flow always prints exact manual
   instructions as the alternative. Never silent.
4. The installer asks "which agents do you want to work in Linear (by default
   this is Product):" and patches those agent files accordingly.
5. Output is a formatted summary of the mappings and a quick "writing to
   config.json". **No diffs** — the operator knows what to look for, and can
   later ask the assistant instead ([self-knowledge.md](self-knowledge.md)).

The lane map itself lands in `config.json` (`projectDefaults.tracker-linear.lanes` /
`projects.<id>.tracker-linear.lanes`), owned per platform by the operator — the
template only proposes. The lane-proposing flow is now **role-driven and
names no plugin** (built 2026-09-29): `aivi projects add` walks core's systems
(forge, then tracker), runs each configured plugin's `./setupProject`, and
writes what each hands back — the Linear flow shows the convention and asks
only for lanes it leaves open, exactly as before but without `--linear`. The
template flow is that machinery, generalized and better advertised.

## Captured requirements

- `aivi projects add` **detects which systems are installed** — it walks the
  roles against the `aivi-plugins` list (D8/D9) and the configured
  `./setupProject` contributors, offering per-system configuration instead of
  a baked-in `--linear` (built 2026-09-29; see
  [forge-github.md](../forge-github.md) for the contributor contract).
- Project-level `.opencode/agents/` overrides keep working throughout.
- Template files ship with `@aivi/cli` (the only bin), in the spirit of its
  `templates/agents/`; the tracker plugin may separately ship optional ticket
  subagent files. Nothing of a template lives in the plugin runtime.

## Open questions

- The manifest's exact format (it is read at install time only — nothing
  reads it at runtime).
- Which of the seeded example agents earn their keep over a season; Review
  earns it day one, a `junior-dev`-style agent probably does not.
