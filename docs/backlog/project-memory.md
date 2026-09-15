# Project-scoped memory in dreaming

Status: designed 2026-09-15 ([projects](../projects.md#memory)); the host side
is not built yet.

## Decided

- Project memory lives in the home, `<home>/memory/<id>/facts.md` beside the
  org's `<home>/memory/facts.md`, and is registered as that project's `memory`
  source automatically (built). The repository stays a clean checkout.
- One dreaming run, not one per project: channels carry no project, so there is
  one bag of conversations. The dreamer's judgement routes a fact to the org or
  to a project; the host only widens the write boundary.
- No channel → project mapping. Directory-based routing (a session's
  `location.directory` inside `projects/<id>`) only becomes relevant for worker
  sessions, which dreaming treats as noise today.

## Left to build

- `dream()` adds `external_directory` and `edit` allows (`facts.md`,
  `proposals/*`) for every project's memory home next to the org's, creates the
  directories, and lists the projects (id, memory path) in the prompt.
- The dreamer agent file gets a paragraph: a fact about one project goes to
  that project's `facts.md`; when unsure, the org's.
- The changed-files snapshot and the cursor cover all memory homes; the cursor
  key stays the org memory directory (one run, one cursor).
- Tests at the boundary: two projects, a transcript mentioning one, the
  permission set and the changed list.
