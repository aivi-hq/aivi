---
'@aivi/plugin': minor
'@aivi/tracker-linear': minor
---

**Linear becomes the follower.** The tracker seam grows `resultShown` (the
adapter's own word for "the result was rendered"), `apply`, and an optional
`closingNote`; `tracker-linear` subscribes to the orchestrator's run events
and pays its ceremony itself — **result → closing note → move → unassign** —
each step asking Linear's real state first, so a half-landed ceremony says
nothing twice. Its pairs (agent session ↔ OpenCode session ↔ ticket) live in
its own `tracker_linear_run_links` table; a delivery failure stays owed in
memory and the boot pass re-derives the list from its own pairs. The closing
note puts the ending on the **ticket** as a comment linked to the agent
session, so a person reads the answer without opening the session.

The listener default flips to **on**, and Linear's plugin section keeps only
`teams` (and `workspaceId`): lanes moved to core. Two board fixes: the
client sorts workflow states by **type group, then position** (Linear scopes
`position` within a group — sorting by it alone interleaved Done and Canceled
before a late `started` lane), and the setup wizard **never writes closed
states** into the lanes array; a run ending in the last configured lane
moves nowhere and a person closes the ticket.
