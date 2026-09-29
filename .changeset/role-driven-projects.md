---
'@aivi/core': minor
'@aivi/host': minor
'@aivi/plugin': minor
'@aivi/tracker-linear': minor
---

The core of aivi now knows **systems, not plugins**. Core spells the two
roles a project setup runs — `projectRoles = ['forge', 'tracker']` — and
never names who fills them. Everything `linear` lived on moved out of
core into `@aivi/tracker-linear`, which contributes its project sections
through the compose mechanism: the lane merge, the one-team-one-project
check, the section write and the lane-flag parsing are the tracker's now.

Core also **has no clone**: `addProject` and `projectIdFromUrl` are gone,
and `projects.ts` keeps only the directory operations (`removeProject`,
`purgeProject`). Cloning carries credentials, so it belongs to a forge —
the one that will exist as `@aivi/forge-github`.

A plugin can take part through a new subpath, `./setupProject`: a
contributor `{ role?, setup(ctx) }` that sets a new project up for its
role and hands back `{ id, section?, cloned? }`. `aivi projects add
[name]` is the runner: interactive, it walks the roles in order, offers
the configured candidates per role (none skips, one is used, several are
asked), runs the roleless contributors after the roles, and writes what
each hands back through one composed-validated write, reading none of it.
With no forge configured the project is **repo-less** — memory and
knowledge, an untracked `source/` that says so plainly. `projects create`
and the `--linear`/`--app`/`--lane`/`--unlane` flags are gone with it:
Linear's own contributor asks for teams and lanes instead.
