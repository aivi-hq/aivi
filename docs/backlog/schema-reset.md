# Schema reset at first release

Status: idea, agreed 2026-09-15. Do it once, right before the first release.

## Idea

While aivi is unreleased, every schema change is an additive migration step
(host `PRAGMA user_version` 1→5, Discord namespace steps 1→3). That history is
noise for anyone installing a released version: they will never have a v1
database. At release, collapse the steps into one `CREATE TABLE` set per
namespace and start counting from 1 again.

## When picked up

- Collapse `Store`'s version steps into a single v1 that creates the final
  shape; same for each adapter's `migrate(namespace, steps)` list.
- Delete the "schema v1 upgrades in place" test and replace it with one that
  proves a fresh database is created at version 1 and that a *newer* database
  is refused (that check stays).
- Keep `Store.migrate` and the `PRAGMA user_version` mechanism: released
  versions need additive steps from then on so nobody loses `state/aivi.sqlite`
  on update. Only the pre-release history is dropped.
- Development databases (`example/state`, `~/.aivi/state`) are deleted and
  recreated by their owners; say so in the release notes.
