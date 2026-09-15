# Projects

aivi is one digital team. The **org** has its knowledge (handbook, decisions,
memory) and a generalist agent, the librarian in the example home, that knows
the org and knows *about* every project. A **project** is a repository the team
works on. Its knowledge lives in the repository (`docs/`), is indexed so the
librarian can search it, and what dreaming learns about a project is kept as
that project's memory in the home.

## Where things are

```
<home>/
  aivi.json                 org config; projects and the docs convention
  projects/<id>/            one clean git checkout per project
  memory/facts.md           org memory
  memory/<id>/facts.md      that project's memory
```

The checkout is always `<home>/projects/<id>`; the directory name is the id.
aivi writes nothing inside a checkout: the home describes the project, so a
repository needs no aivi file and works the same outside aivi. `<home>/memory`
and `<home>/memory/<id>` are created when the knowledge service starts and are
always registered as `memory` sources (core and per project, both with source
id `memory`, which is reserved).

## Configuration

```json
{
  "projectDefaults": {
    "knowledge": [
      { "id": "docs", "path": "docs" },
      { "id": "adr", "path": "docs/adr", "kind": "decision" }
    ]
  },
  "projects": {
    "acme": {},
    "legacy": { "knowledge": [{ "id": "wiki", "path": "wiki" }] }
  }
}
```

- `projects` is an object keyed by id (`^[a-z][a-z0-9_-]*$`). A registered
  project must be checked out; `config check` fails otherwise.
- `projectDefaults.knowledge` is the company-wide convention for what a
  repository's `docs/` holds. What is shown above is the built-in default, so
  most homes never write it. A project with its own `knowledge` replaces the
  defaults; paths are relative to the checkout.
- A directory that a repository does not have (no `docs/adr`) is skipped with
  a `knowledge.missing` log line, not an error.
- **A file belongs to the most specific source that contains it.** `docs/adr/*`
  is `decision`, the rest of `docs/` is `doc`; nothing is indexed twice or under
  two kinds. This is resolved once, when the index is configured: the outer
  collection ignores the inner one's subtree.
- `projects.<id>.linear` (`workspaceId`, `projectId`, `lanes`) is validated
  ahead of the Linear module; nothing reads it yet
  ([configuration](configuration.md#linear-mapping-validation-only)).

## Who works in a project

- **Channels talk about projects, never in one.** A Discord or Slack
  conversation runs the module's agent in the home; it reads projects through
  `knowledge_search` and `knowledge_sources`, and learns which projects exist on
  demand. It never claims or edits a checkout.
- **Workers work in a project.** Linear's worker agents (milestone 7) run in
  `<home>/projects/<id>` with the lane's mapped agent. One active agent per
  project and maintenance-when-idle are designed but not built
  ([projects-and-capacity](backlog/projects-and-capacity.md)).
- A checkout is an OpenCode location of its own: a session in
  `projects/acme` does not see `<home>/.opencode/agents/`. Where worker agents
  are defined is settled with the Linear module.

## Memory

One dreaming run reviews every conversation since the last run; there is one
bag of conversations, not one per project, because channels carry no project.
The dreamer decides where a fact belongs: the org (`memory/facts.md`) or a
project (`memory/<id>/facts.md`). Today the host allows writes to the org
memory only ([dreaming](dreaming.md)); widening the boundary to every project's
memory home and naming the projects in the prompt is the next step
([project-memory](backlog/project-memory.md)). Project memory is a project
source, so it is found with that project's scope and, like every project
source, when no scope is given.

## Adding a project

Today: `git clone <url> <home>/projects/<id>`, add `"<id>": {}` to `projects`,
restart `aivi serve` (or run `aivi knowledge index`). A one-command
`aivi projects add <git-url>` is planned.
