# Localization and brand

Status: idea from the owner (2026-09-15). Not scheduled; collect what has to
move before picking a mechanism.

## Wanted

- Every sentence a person reads from aivi should be translatable: channel
  notices (queued, going offline, could not start, could not finish, restart
  recovery), command replies (`/status`, `/context`, `/new`, `/search`), the
  progress placeholder phases (`⏳ thinking…`, `🔧 …`, `✍️ writing the answer`),
  job report texts (`describeOutcome`), the CLI's human-facing notes, and the
  speaker prefix the agent sees (`[Discord message from …]`).
- One locale per installation to start (`locale` in `aivi.json`, default
  `en`); per channel or per person later, once identities are linked
  ([people](../people.md)).
- **Brand**: the name "aivi" is hard-coded in messages, session titles, the
  `aivi` tool namespace, slash command prefixes, `metadata.aivi`, and the
  agent files. Store the display name once (`brand: "aivi"` in config) and use
  it in everything a person reads; identifiers (`metadata.aivi`, table
  prefixes, tool ids) stay as they are, since they are contracts, not copy.
- Agent files are the owner's prose and stay untranslated by aivi; the example
  agents can ship in more than one language if wanted.

## Constraints

- Strings live next to the code that uses them today; the mechanism (message
  catalogue per package, ICU plurals, or plain functions per locale) should
  not add a build step or a framework. Plain TypeScript objects keyed by
  locale, one per package, are enough at this size.
- Log events and error codes stay English: they are read by operators and
  agents, and grepped.
- Dates in messages already carry `UTC`; a locale also decides the format.
