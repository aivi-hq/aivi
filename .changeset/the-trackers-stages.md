---
'@aivi/core': minor
'@aivi/host': minor
'@aivi/plugin': minor
'@aivi/tracker-linear': minor
---

**The tracker's stages: the interface lands, the events die.** The
orchestrator and the tracker are now one division of labour said as an
interface: a tracker module registers ONE `Tracker` — the board the
eligibility walk reads (`projects`, `tickets`, an idempotent `moveTo`) and
the stages every run walks through: `initWork` (open the ticket on the
platform, return its **summary**), `ready`, `startWork?`, `question`,
`plan?`, `endWork` (the closing words, awaited). The typed run-event bus is
gone: no subscribing, no emitting; the lifecycle stages are awaited — their
failure is the run's failure, said visibly — and the renders are
fire-and-forget, retried by the tracker from its own outbox. The old
conversation-keyed adapter contract is renamed `PlatformAdapter` and keeps
its `@aivi/plugin/tracker` subpath.

The ending walks the operator's order: `endWork` speaks first, the
orchestrator then moves the ticket where its lane order chose — a move that
misses retries at known instants and from the next boot, the debt living in
the run's row until it lands — and **lastly** the lease returns. The worker's
first prompt is the orchestrator's composition: a neutral line naming
project, lane and checkout, the ticket's summary, and the worker contract.

The walk is the only door for board work, and every run gets a real agent
session: Linear's `initWork` delegates the ticket to its own app and the
mutation's answer carries the session, so questions, plans and endings all
render in the platform's own shapes — the sessionless ceremony, the read
watermark and the stop-memory are dead. A stop **releases** the ticket back
to the board; "not that one again" is the HITL label's job alone. A hand
delegation gets one fixed refusal — work reaches the orchestrator through
the board, not through a delegation — and the listener's delegation on a
lane move dies: a lane change is a wake and nothing more. Fulfilment
re-checks nothing: a person's move on a queued ticket cancels its request
the moment the webhook lands.

A session that will not die is struck at most `dispatcher.killAttempts`
times (default 3) and then given up on — **not** on the slot: the capacity
returns and the ending carries the machine-readable `kill-unconfirmed`
code, which the tracker says loudly on its platform. And a closing that
fails does not hold the ticket either: a person hears of it the moment it
fails (the human label rides the ticket, help is on the way), the move
lands and the slot comes back anyway, the closing owed to the next wake
and the next boot. `linear.listener` is gone from the config; the wizard's
queue question never offers a lane that names an agent.
