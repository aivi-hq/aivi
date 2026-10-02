# Discord polish

Status: ideas parked; the second item is a measured behavior from the dev home
(2026-09-28), the first is the older widget idea kept for when it is wanted.

## Deleted messages still get answered

A message that opens or steers a turn and is then deleted by its author is
still answered: the queue holds the text, and the reply lands as if nothing
happened. Measured on the dev home 2026-09-28 — the author queued a message,
deleted it while the turn ran, and the bot replied to the deleted message
after the turn finished.

When picked up:

- Watch `messageDelete` (discord.js emits it) and mark the matching queued
  turn withdrawn before its turn starts; a turn already running finishes —
  the reply is what the person asked for with the messages that followed.
- Decide the answered case deliberately: editing the reply to note the
  question was deleted, or deleting the reply too. A thread others have
  joined argues against silence; a DM argues for it.
- The same question exists on Slack (`message_deleted` event) — one host-side
  rule in the turn runner, not per-platform improvisation
  ([channels.md](../channels.md#feedback-and-recovery-shared)).

## Widgets as an agent capability

Status: idea, parked 2026-09-15 while jobs are built ([architecture.md](../architecture.md#jobs-and-runs)).

Let an agent ask a structured question in Discord with native components
(buttons, select menus, modals) instead of prose, and receive the answer as
validated data. First use: confirming a schedule the librarian is about to
create ("every weekday or every day?", "results here or in #reports?").

Why it is parked: a tool call that pauses on a Discord interaction is a new
mechanism: the tool must wait for a user event, survive a host restart with
the question still open, and time out sensibly. For jobs the same outcome is
reached with good defaults (results back to the asking session, host
timezone) plus the tool echoing the parsed schedule and its next occurrences
so the librarian can confirm in one line. Widgets are worth building once a
second use case needs structured input from a person in chat.

When picked up:

- Model it as an aivi tool (`aivi_ask` or similar) in the plugin namespace,
  answered by the Discord module; the host stores the open question and its
  answer so a restart does not lose either.
- One question at a time per thread; an unanswered question expires and the
  tool returns "no answer" rather than blocking the turn forever.
- Alternative for exact input without a model: a code-only `/schedule` slash
  command with a modal. Rejected for now because it would be a second entry
  point next to the tool.
