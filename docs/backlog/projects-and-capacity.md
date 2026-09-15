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
