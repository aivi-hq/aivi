# Identity linking and verification

Status: idea, not scheduled. Discuss before designing.

## Problem

aivi should know who it is talking to across channels so a person can ask
"what did I discuss last week" without pulling in other people's conversations.
Discord, Slack, GitHub, and email each have their own identifiers. There is no
privacy boundary in this system (it is a shared hub), but there must be an
attribution boundary.

## Current behavior

A person is whoever the channel says they are. Discord messages carry the
Discord user id into OpenCode session metadata; nothing links that id to a
person or to other channels.

## Direction

- Introduce a `person` record with a stable id and a set of linked identities
  (`discord`, `slack`, `github`, `email`).
- Email is the anchor identity: it is stable and reachable from GitHub, Slack,
  and Discord profiles.
- Verification by one-time code: aivi emails a code, the person pastes it into
  the chat where they made the claim, and the identity is linked.
- Knowledge indexed from conversations carries `person` so retrieval can filter
  by it.

## Open questions

- Where does the person registry live: config file (operator-managed) or aivi
  database (self-service linking)?
- Which mail sender does aivi use; does aivi get its own mailbox?
- Can linking be done through OpenCode-native mechanisms instead of custom code?
- Should dreaming write per-person memory files, or is `person` only a filter
  on indexed conversations?
