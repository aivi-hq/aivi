# Self-knowledge

Status: draft (2026-09-27). Part of the [templates program](index.md). Needs
[cli-refactor](../cli-refactor/index.md) phase 3 (the plugin list and the
composed schema); otherwise independent. Parent: [index.md](index.md).

## The goal

The assistant knows what is installed and can use it: answer "how do I map
lanes?", explain when a `linear.md` subagent applies, and *do* the
configuration. The operator's bar: **"anything in config.json — ideally you
never go in there yourself."** This is an `llms.txt` for aivi itself, but an
honest one: indexed from the authoritative sources, not a generated summary
of them.

## The `manual` source kind

- Each installed package's docs directory becomes a knowledge source, kind
  `manual`, **indexed straight from the source — no copying** (copying drifts
  and is fragile; the index stays rebuildable, the sources stay authoritative).
- Sources carry **tags with the package name**, so a search narrows to
  `manual` + `@aivi/linear` and never drags in company docs, project docs,
  dreaming memory, or transcripts. The same kind filter that already keeps
  `conversation` out of the way does the excluding; knowledge about the
  company stays unpolluted by knowledge about the install.
- The kind carries `configuration.md` too — it owns the config schema, which
  is what knowing "everything in config.json" needs on the *knowing* side.
- An upgrade refreshes the assistant's self-knowledge for free: the index
  re-reads the sources.
- Which docs exist follows the **`aivi-plugins` list** in
  `<home>/app/package.json` — the install record — not the presence of a
  config block (cli-refactor D9 ended "a block enables its module"). A
  disabled plugin is still installed, and its docs are still what the
  operator needs while debugging the disablement, so the list indexes
  regardless of the enablement flag.

## The config-editing tool

The *doing* side, deliberately deterministic — the assistant does not raw-edit
the file:

- A host tool takes a patch, validates it against the **composed closed
  schema** — the core envelope plus the enabled plugins' `configSchema`s, the
  same composition the boot order makes (manifest → compose → parse) — and
  writes the live `config.json`, or refuses with the validation error. A
  patch naming an unlisted plugin's block fails as "configured, not
  registered", for free.
- The composed editor schema at `<home>/state/cache/schema.json` (D10) is
  the assistant's readable map of what config *can* say; the `manual` kind
  carries the prose (`configuration.md`), the cache file carries the exact
  shape.
- On success it says whether the change needs a restart to land — the
  announce-before-disconnect discipline of D13, reduced to one sentence.
- Secrets stay out of it entirely: `.env`/fnox territory, as always.
- zod is the referee either way: the assistant *knows* the schema from the
  `manual` docs and *applies* through the tool; a wrong belief fails
  validation instead of corrupting the config.
- It mutates the operator's live file, so it deserves its own gating, like
  `aivi_jobs` is gated. The `operator` role store is there waiting (cli-refactor
  D16 gave it its first customer); which gate is right is an open question.
- Not to be confused with the planned `configure` command: that edits the
  *client* config on a laptop; this edits the *home's* `config.json` on the
  server, for the assistant's operator.

## Open questions

- How the docs directories of installed packages are registered as sources
  (discovery from the `aivi-plugins` list, presumably; where the package tag
  lives on a source).
- Live config *values*: read through the host API for the assistant (today
  `aivi status` shows some; a full read may need an endpoint or tool).
- The tool's gating: the `operator` role exists (D16) — every operator? only
  the assistant's own sessions? a config switch like `scheduler.agentSchedules`?
- Whether knowledge-as-optional-plugin (phase 3's follow-up) lands before
  this and moves the `manual` kind's machinery along with the knowledge
  module.
