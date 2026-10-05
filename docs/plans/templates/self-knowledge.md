# Self-knowledge

Status: **built 2026-10-03** (both halves; what is left is at the bottom).
Part of the [templates program](index.md). Parent: [index.md](index.md).

## The goal

The assistant knows what is installed and can use it: answer "how do I map
lanes?", explain when a `linear.md` subagent applies, and *do* the
configuration. The operator's bar: **"anything in config.json — ideally you
never go in there yourself."** This is an `llms.txt` for aivi itself, but an
honest one: indexed from the authoritative sources, not a generated summary
of them.

## The `manual` source kind — built

- Each installed package's docs directory is a knowledge source, kind
  `manual`, **indexed straight from the source — no copying**: the file keeps
  its one owner, and `aivi upgrade` refreshes the words along with the code.
- **The sources arrive with the package**: `@aivi/host`,
  `@aivi/tracker-linear` and `@aivi/forge-github` ship `files: ["dist",
  "docs"]`. `configuration.md` lives in the host's docs (the repo keeps a
  pointer); the Linear and GitHub forge chapters live with the plugins whose
  schemas they own (`packages/tracker-linear/docs/linear.md`,
  `packages/forge-github/docs/github.md`).
- Registration is the install record: core's `loadConfig` reads the
  `aivi-plugins` list in `<home>/app/package.json` and adds every listed
  package's `docs/` directory as a core `manual` source — **regardless of the
  enablement flag**, because a disabled plugin's docs are what the operator
  needs while debugging the disablement. The package tag lives in the source
  id: `manual:<package>`; `kind: "manual"` plus the id is how a search narrows
  to one package's docs without dragging in company docs, project docs,
  dreaming memory or transcripts.
- An upgrade refreshes the assistant's self-knowledge for free: the index
  re-reads the sources.

## The config-editing tool — built

`aivi_config`, the host's own claim (docs/opencode.md, tool table):

- `action: read` answers the live `config.json` as written.
- `action: write` takes a key path (`["orchestrator","elicitationKeepAlive"]`)
  and a value, writes **one block** through core's `writeConfigBlock`, and
  must then load under the **composed closed schema** — core plus the
  installed plugins, the same composition the boot makes. A refusal restores
  the previous bytes and says why: zod is the referee, and a wrong belief
  fails validation instead of corrupting the config.
- `action: remove` deletes one block; removal needs no composed
  re-validation on purpose — every section is optional, and a repair must be
  able to walk broken pieces out in any order.
- On success the answer says how the change lands: the host reads
  `config.json` when it boots; `identity.name` is the watched exception.
- Secrets stay out of it entirely: `.env`/fnox territory, as always.
- **The gate is the claim**: `host.agentConfigEdits` (default on) — `false`
  and the tool is simply absent from the plugin, the way every capability
  that does not exist behaves. This settles the open question the same way
  `scheduler.agentSchedules` settled `aivi_jobs`.
- Not to be confused with the `configure` command (built 2026-09-29): that
  edits the *client* config on a laptop; this edits the *home's*
  `config.json` on the server, for the assistant's operator.

## What is left

- **Live config values in `aivi status`**: `aivi_config` read already answers
  this; fold the parsed config into `aivi status` only if the assistant (or a
  person) wants it there too.
- **Docs for the remaining packages**: every package that wants its chapters
  indexed adds a `docs/` directory to its `files`; the registration needs no
  change.
- Whether knowledge-as-optional-plugin (cli-refactor phase 3's follow-up)
  moves the `manual` machinery along with the knowledge module.
