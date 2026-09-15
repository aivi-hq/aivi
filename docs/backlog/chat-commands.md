# Chat commands and conversation controls

Status: idea. Collect wishes here before implementing.

## Today (Discord and Slack)

`/new` (fresh session next message), `/status` (this conversation's pending
turns, next jobs, recent runs), `/context` (agent, model, messages, tokens,
cost, knowledge in scope; built 2026-09-15 on `describeConversation` in the
host), `/search query [project]` (knowledge search without a model turn).
Global Discord commands can take up to an hour to appear after
`aivi discord register`.

## Wanted

- `/model`: show (and maybe switch, per conversation) the model. Today the
  model comes from the agent file; per-conversation switching would go
  through `session.switchModel`, which exists in the v2 API.
- `/agent`: deliberately not offered for Discord (one librarian per bot). If
  multiple personalities are wanted, prefer per-channel agent config over a
  runtime switch.
- `/stop` or `/cancel`: abort the running turn for this conversation
  (`session.interrupt`), release its lease.
- `/steer`: send this message into the running turn with `delivery: "steer"`
  instead of queueing behind it. Ordinary messages stay `queue`. OpenCode owns
  both modes and the inbox (`session.inbox`), so this is a one-flag change in
  `runTurn` plus the command.
- `/jobs`: upcoming schedules and recent outcomes (ties into the jobs ticket).
- `/help`.

## Design notes

- Commands are adapter UI over host operations. Keep the operation in the host
  (or OpenCode) and the command as a thin translation, so Slack gets the same
  set for free.
- Anything that changes behaviour (model switch, cancel) must respect the same
  access policy as messages, and be audited on the turn/session.
