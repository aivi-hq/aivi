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

The checkout is always `<home>/projects/<id>`; the directory name is the id
(`^[a-z][a-z0-9_-]*$`; anything else must be renamed). **A clone is a
registration**: aivi discovers projects as the directories of
`<home>/projects` (symlinks to directories count, dotfiles and plain files do
not) when it loads its config. aivi writes nothing inside a checkout: a
repository needs no aivi file and works the same outside aivi. `<home>/memory`
and `<home>/memory/<id>` are created when the knowledge service starts and are
always registered as `memory` sources (core and per project, both with source
id `memory`, which is reserved).

## Configuration

Most projects need no configuration at all. `projects.<id>` in `aivi.json`
only overrides:

```json
{
  "projectDefaults": {
    "knowledge": [
      { "id": "docs", "path": "docs" },
      { "id": "adr", "path": "docs/adr", "kind": "decision" }
    ]
  },
  "projects": {
    "legacy": { "knowledge": [{ "id": "wiki", "path": "wiki" }] },
    "archived": { "enabled": false }
  }
}
```

- `projectDefaults.knowledge` is the company-wide convention for what a
  repository's `docs/` holds. What is shown above is the built-in default, so
  most homes never write it. A project with its own `knowledge` replaces the
  defaults; paths are relative to the checkout.
- `enabled: false` keeps the checkout but hides the project from indexing,
  memory and `projects list`.
- An override for a project that is not checked out fails `config check`: it
  is a typo or a missing clone, and both deserve a message.
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
  `knowledge_search` and `aivi_sources`, and learns which projects exist on
  demand through `knowledge_projects`. It never claims or edits a checkout.
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
project (`memory/<id>/facts.md`). The host makes every memory home exist,
allows `facts.md` and `proposals/*` in each, and names them in the prompt
([dreaming](dreaming.md)). Project memory is a project source, so it is found
with that project's scope and, like every project source, when no scope is
given.

## Adding, listing, renaming, removing

```sh
aivi projects add https://github.com/acme/website.git   # clones into projects/website
aivi projects add git@github.com:acme/api.git --id backend
aivi projects list
aivi projects remove website          # checkout gone, memory stays
aivi projects purge website           # shows what would go, deletes nothing
aivi projects purge website --confirm # deletes memory/website (and a lingering checkout)
```

`add` is `git clone` plus an id check (the id is the repository name,
lower-cased, unless `--id` says otherwise); it prints the sources the project
will have. The host reads the projects directory at startup, so restart
`aivi serve` after adding or removing. To rename a project, rename its
directory (and `memory/<id>` if the memory should follow). Old collections in
the search index are dropped by QMD at the next start and never searched, since
queries name their collections; the index is a rebuildable derivative, so
deleting `state/knowledge` reclaims the space.

**Removed is a state, not an absence.** A memory home with a `facts.md` and no
checkout is a removed project: `projects list`, `/v1/projects` and the
librarian's `knowledge_projects` show it with `removed: true` and only its
`memory` source, so "what did we decide for website?" still has an answer, and
the librarian says the project is gone. Nothing is forgotten until someone runs
`purge --confirm`, which is the one destructive command here. `enabled: false`
is different: the checkout stays and the project is hidden entirely, memory
included.
