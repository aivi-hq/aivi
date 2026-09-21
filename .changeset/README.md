# Changesets

Versions are **fully independent per package**. Before merging a PR with
user-facing changes, run `npx changeset` and describe them: pick every package
that changed and a bump level (patch/minor/major). On merge to `main`, CI
opens a **Version PR** that consumes those files, bumps the versions, writes
the changelogs and updates internal `@aivi/*` ranges. Merging that PR
publishes every changed package to npm with provenance.

Internal `@aivi/*` dependencies use caret ranges, so a dependency release
that stays in range does not force a dependent release; crossing a range
bumps the dependent automatically.
