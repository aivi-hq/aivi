# Job identity: what an id is for

Status: open question, raised by the owner while reviewing the config shrink
(2026-09-18). Not scheduled; settle before the desktop job list exists, since
that surface will print whatever this decides.

## The mechanic today

- A job's `id` is the **stability key** for restart reconciliation: same id and
  unchanged definition keeps its next occurrence, changed resets it, gone from
  config pauses it. Not a database row id — rows have their own.
- Runs point at their job by that id, so history reads "the nightly job ran"
  rather than "an anonymous row ran".
- The host derives two ids from settings (`retention`, `projects-sync`) and
  reserves those names in `jobs[]` while the settings are on; two system
  definitions sharing an id is fatal at startup.
- One string plays three roles: reconciliation key, what runs point at, and
  the display name in every list and report.

## The questions

- **What should identify a job, for whom, and when does that identity change?**
  Display name and identity are probably different things (a job's title can
  change freely; its identity must not).
- **Derived ids** (a module seeding `linear.sweep` as a schedule) make the
  entanglement visible: the id carries dots, and renaming the operation would
  orphan its history. Should derived schedules own a namespace instead?
- **Collisions**: config ids are checked against `retention`/`projects-sync`
  only. A hand-written job colliding with a *module-derived* system id is not
  checked today; should the general config-vs-system check exist?
- **Vocabulary** (owner ruling 2026-09-18): *jobs* and *runs* are the only
  user-facing terms; *task* is the payload and never triggered. The config
  field name `jobs[].task` is the last place a person meets the word — a
  rename there is wide and breaking, so it waits for a deliberate decision.
- **Why JSON for crons at all** (owner, 2026-09-18): `scheduler.retention`-style
  schedules live in `aivi.json` because the file is the reconciliation source —
  syncJobs keys off ids to know what survived a restart. But the desktop vision
  edits frequency from a UI, which writes through the API into SQLite. If the
  dashboard becomes the editor, does the config file keep schedules at all, or
  shrink to bootstrap? This decides where definitions live, and the identity
  rules above change shape with the answer.
