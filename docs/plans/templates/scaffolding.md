# Template scaffolding

Status: **agent files built 2026-10-03** — the worker files ship and seed
with the home; the lane-map *proposal* stays open. Part of the
[templates program](index.md). Parent: [index.md](index.md). Supersedes
[backlog/agent-presets.md](../../backlog/agent-presets.md).

## What it is

The thing you install: plain agent files plus a proposed lane map, so a fresh
aivi can triage, refine, and delegate on day one. The analogy the operator
endorsed: what "new project" example files are in every other tool.

## The shape

- **Built 2026-10-03:** the base agent files live in
  `packages/cli/templates/agents/` — `assistant.md` and `dreamer.md`
  (aivi's own roles) and **`product.md`, `dev.md`, `review.md`** (the lane
  workers) — and `aivi setup` seeds all five into `<home>/.opencode/agents/`,
  never overwriting what exists. The worker files carry the *judgement*:
  voice, the returning-work posture line, the review posture ("Request
  changes for problems. Comments for nits."), and the permission denials an
  unattended run needs (no desktop browser, no native `question` widget;
  triage and review deny `edit` and `shell` because they read). The
  *mechanics* stay in the orchestrator's first prompt — the files never
  restate the tool contract, so one place owns it (and the operator can
  edit those texts: `<home>/prompts/`, see
  [git-workflow.md](../git-workflow.md#prompts--the-guidance-the-operator-can-edit)).
  A manifest proposing lane → agent mappings is **not** built: the lane
  wizard asks live, per state, from the pick-list these files fill.
- **Written once, then plain files.** No template runtime, no tracked "installed
  template" identity, no uninstall command, no `template upgrade`. Uninstalling is
  "delete these files, unmap these lanes", which the docs say. Editing the
  written file is the whole configuration.
- Template agents **can** reference a ticket subagent (shipped optionally by the
  platform plugin); they must not require it. The product file is written for
  the case where the tracker's tools are in reach, and says what to do where
  they are not.

## The flow

In cli-refactor's world, `aivi install tracker-linear` writes the three facts
at once — npm dependency, `aivi-plugins` list entry, config block — and its
`./setup` owns the screen with the runner's own clack. The template flow is the
tail of that install, and of `aivi setup`.

1. **Built 2026-10-03.** `aivi setup` seeds the five base agents — assistant,
   dreamer, product, dev, review — and never overwrites what exists.
2. Installing a ticket system proposes the lane map: the template manifest is
   matched best-effort against the team's **real** states (read through the
   adapter's `laneStates`), after checking what the team already has.
   **Not built as a manifest**: the wizard asks per state directly, and the
   seeded worker files are what its pick-list offers.
3. The operator accepts or customizes — the lane wizard does this per state
   (built: the pick-list, `-- None --`, the worktree question, the one queue
   question, closed states never written). Missing states may be **created** with
   one explicit yes per team, and the flow always prints exact manual
   instructions as the alternative. Never silent. *(Creation is not built:
   the wizard says when a board has no states and stops.)*
4. The installer asks "which agents do you want to work in Linear (by default
   this is Product):" and patches those agent files accordingly. **Not built** —
   and it may be obsolete: the lane wizard already asks who works each lane,
   which is the same question from the other end.
5. Output is a formatted summary of the mappings and a quick "writing to
    config.json". **No diffs** — the operator knows what to look for, and can
    later ask the assistant instead ([self-knowledge.md](self-knowledge.md)).

The lane map itself lands in the **core** ordered array `projects.<id>.lanes`
(the array *is* the workflow; the per-platform blocks hold only platform
facts), owned per platform by the operator — the template only proposes. The
lane-proposing flow is now **role-driven and names no plugin** (built
2026-09-29): `aivi projects add` walks core's systems (forge, then tracker),
runs each configured plugin's `./setupProject`, and writes what each hands
back — the Linear flow shows the convention and asks only for lanes it leaves
open, exactly as before but without `--linear`. The template flow is that
machinery, generalized and better advertised.

## Captured requirements

- **Copyable posture lines for agent files** (built 2026-10-02). The
  automated texts aivi speaks are editable through `<home>/prompts/`
  ([git-workflow.md](../git-workflow.md#prompts--the-guidance-the-operator-can-edit));
  an agent file that wants the posture as its own words copies them from
  here. For a worker that answers reviews:

  > If this is returning work, with unresolved comments, process feedback by
  > either agreeing (do the work) or disagreeing (leave a grounded comment);
  > both use aivi_respond_feedback.

  And for a review lane:

  > Request changes for problems. Comments for nits.

  These are guidance, not contract: the completion gate stays posture-blind
  whatever the agent file says.
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
