# Project-scoped memory and a narrower dreamer

Status: idea from the owner (2026-09-15); design wanted before code.

## Today

Dreaming has one memory directory, configured on the task, that must sit inside
a core knowledge source. The dreamer reads the transcript and that directory,
may edit `facts.md` and `proposals/*` there, and nothing else. It knows
nothing about projects: a conversation about the `acme` repository ends up in
the same `facts.md` as a conversation about lunch.

`projects[]` in `aivi.json` registers a directory per project and reads
`aivi.project.json` inside it for knowledge sources. There is no notion of
"where this project's documentation lives" and no per-project memory home.

## Wanted

- `projects[].docs` (default `${directory}/docs`): the documentation directory
  of a project. Used for knowledge indexing defaults and for the dreamer's read
  boundary.
- A memory home per project (`${docs}/memory` or a configured path) next to the
  global one, so facts about a project live with the project and travel with
  the repository.
- The dreamer's permissions derived from that configuration: read the project's
  docs and memory, write only the project's memory files; the global memory
  home for everything else. Nothing outside those directories, as today.
- Routing: which conversations belong to which project? Candidates are the
  session's `location.directory` (jobs and future Linear workers) and, for
  Discord, an explicit channel → project mapping. Unmapped conversations go to
  the global memory.

## Questions

- One dreaming run per project, or one run that writes to several memory
  homes? One run per project keeps the permission set static per session and
  matches "one active agent per project"
  ([projects-and-capacity](projects-and-capacity.md)); it costs one model call
  per project with new conversations.
- Should project memory be a core knowledge source automatically (searchable by
  the librarian) or a project source (searchable only in that project's scope)?
- Does the `docs` default belong in `aivi.json` or in `aivi.project.json`? The
  project file is the natural owner; `aivi.json` should not need to know the
  layout of a repository.

## Constraints already decided

- The host only enforces boundaries; what is memorable stays in the agent
  definition.
- Memory is files inside knowledge sources, never system-prompt state.
- Permission resources are canonical paths (`realpath`).
