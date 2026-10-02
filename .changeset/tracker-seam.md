---
'@aivi/plugin': minor
'@aivi/tracker-linear': minor
---

**The tracker seam.** A new subpath, `@aivi/plugin/tracker`, is the contract
between aivi's ticket machinery and one ticket system. An adapter is a
translator and nothing else: it turns the platform's events into neutral
ones — `started`, `prompted`, `updated` on a *conversation*, which is what a
tracker calls one working session — and aivi's neutral asks back into the
platform's mutations: `issue`, `laneStates`, `assign`/`unassign`,
`startSession`, and `comment` in four kinds (`answer`, `progress`, `note`,
`outcome`) that each platform renders its own way. `idFor` and `parts` carry
a conversation across the border in both directions, so nothing outside the
adapter ever parses one. `createStates`, `candidates` and `apply` are
declared optional and unimplemented: they arrive with the dispatch work,
when the machinery starts asking pull-shaped questions.

`@aivi/tracker-linear` now splits along that line. `tracker.ts` is Linear's
translator — the apps and their credentials, the webhook endpoints and their
signatures, the GraphQL reads and mutations, the agent-session activity
types — and the only file where a Linear field name survives. `module.ts`
holds aivi's own machinery, the routing decisions, the delegate guards, the
listener's pickup and the worktree a lane's agent works in, and it speaks
only the `Tracker` contract. That machinery is the orchestrator waiting to be
extracted, and the worktree code moves with it.

Two things the seam made visible, both fixed. A ticket's data change arrives
before that ticket has a session of its own, so a conversation may be the
app's own feed and the adapter says so rather than demanding a session; and a
comment into a conversation that names no session is an error naming itself,
not an activity posted at an empty id.
