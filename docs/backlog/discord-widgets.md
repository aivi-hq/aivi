# Discord widgets as an agent capability

Status: idea, parked 2026-09-15 while jobs are built ([jobs.md](jobs.md)).

## Idea

Let an agent ask a structured question in Discord with native components
(buttons, select menus, modals) instead of prose, and receive the answer as
validated data. First use: confirming a schedule the librarian is about to
create ("every weekday or every day?", "results here or in #reports?").

## Why it is parked

A tool call that pauses on a Discord interaction is a new mechanism: the tool
must wait for a user event, survive a host restart with the question still
open, and time out sensibly. For jobs the same outcome is reached with good
defaults (results back to the asking session, host timezone) plus the tool
echoing the parsed schedule and its next occurrences so the librarian can
confirm in one line. Widgets are worth building once a second use case needs
structured input from a person in chat.

## When picked up

- Model it as an aivi tool (`aivi_ask` or similar) in the plugin namespace,
  answered by the Discord module; the host stores the open question and its
  answer so a restart does not lose either.
- One question at a time per thread; an unanswered question expires and the
  tool returns "no answer" rather than blocking the turn forever.
- Alternative for exact input without a model: a code-only `/schedule` slash
  command with a modal. Rejected for now because it would be a second entry
  point next to the tool.
