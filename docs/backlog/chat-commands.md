# Chat commands and conversation controls

Status: idea. Collect wishes here before implementing.

## Today (Discord)

`/new` (fresh session next message), `/status` (this conversation's pending
turns), `/search query [project]` (knowledge search without a model turn).
Global commands can take up to an hour to appear after `aivi discord register`.

## Wanted

- `/context`: what the current session knows — agent, model, message count,
  which knowledge sources are in scope, token usage if OpenCode exposes it.
- `/model`: show (and maybe switch, per conversation) the model. Today the
  model comes from the agent file; per-conversation switching would go
  through `session.switchModel`, which exists in the v2 API.
- `/agent`: deliberately not offered for Discord (one librarian per bot). If
  multiple personalities are wanted, prefer per-channel agent config over a
  runtime switch.
- `/stop` or `/cancel`: abort the running turn for this conversation
  (`session.interrupt`), release its lease.
- `/jobs`: upcoming schedules and recent outcomes (ties into the jobs ticket).
- `/help`.
- Reactions or a short acknowledgement when a message is queued behind other
  work, so a wait is distinguishable from silence. Note: the bot currently
  lacks the Add Reactions permission in the test server; the invite/permission
  checklist in docs/discord.md must include it before relying on reactions.

## Design notes

- Commands are adapter UI over host operations. Keep the operation in the host
  (or OpenCode) and the command as a thin translation, so Slack gets the same
  set for free.
- Anything that changes behaviour (model switch, cancel) must respect the same
  access policy as messages, and be audited on the turn/session.
