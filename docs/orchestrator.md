# Work Pull Flow

This document describes the concepts of the orchestrator and the dispatcher.

It attempts to outline the responsibilities of each system and the direction of work.

**Status (2026-10-02):** the design the operator wrote after thinking about it
for a very, very long time, with the rulings from its conversation folded in
(where folded, they are marked). It **owns** lanes, priority, queue lanes,
pools, leases and the dispatcher; the build checklist that shrinks as these
land is [plans/orchestrator.md](plans/orchestrator.md). The run contracts —
the tracker's stages, the worker's tools, completion, questions and recovery —
live here too; the workflow ideas that were never built (triage as a worked
lane, the ticket subagent) are parked in
[backlog/ticket-workflow.md](backlog/ticket-workflow.md).

**The yardstick:** [plans/orchestrator-reference.md](plans/orchestrator-reference.md)
is the operator's own copy of this design, kept for course checks. It is
**never written by us**; when this doc and it disagree, the difference must
be a marked ruling or this doc is wrong.

## Overview

Many concepts touch the flow of work, but two systems are responsible for actually doing it.

| Part             | Job                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** | Manages work priority, prepares worktrees, and is the glue between trackers, forges and workers.                              |
| **Dispatcher**   | Manages capacity through leases and monitors for sessions in limbo. It is the only part that knows how much capacity is left. |

The orchestrator never counts capacity itself. It asks the dispatcher for a lease and, once one is granted, works with it.

The dispatcher is a central system, and the orchestrator pulling work is
only one of the things it is designed for. Today it is the only user:
**ticket work** draws `dispatcher.pools`. Jobs, dreaming and chat turns —
Discord, Slack and the Linear assistant — still draw the older
`scheduler.resources` from the store's own leases. The two systems coexist;
folding them into the dispatcher's one pool set — including the turn lease
below — is tracked deliberately-later in
[plans/orchestrator.md](plans/orchestrator.md).

## The basics

Let's cover some of the terminology used in this document.

- **Lane:** where a ticket is in the workflow. This is an orchestrator concept, designed to mirror how trackers organize work.
- **Session:** an OpenCode session. It outlives individual turns and leases. A session is created in a pool and keeps that pool for its whole life. A session does not consume capacity on its own.
- **Lease:** the right to occupy one slot in a pool.
- **Capacity and pool:** a pool has a fixed number of slots: its capacity. An active lease occupies one slot.
- **Claim**: the orchestrator record for an active ticket lease. It mirrors a session lease.
- **Blocked:** the ticket is waiting on a human answer or another ticket. An unclaimed blocked ticket is not picked up.
- **The walk:** the orchestrator's eligibility pass — it reads the board's lanes right to left and their tickets top to bottom, and starts a worker where a lane names an agent and a lease is granted. It is woken by events (a webhook, a run's ending, an explicit wake), never by a timer.
- **The board:** the tracker's live state as the walk reads it — lane membership, labels, delegates. "The board is the memory" (ruled 2026-10-02): anything people must be able to check lives there, never only in the host's database.
- **Unheard:** a queued request given its lease back before it was ever delivered — the claim's guard caught that its ticket took a run through another door while the request waited; no second worker starts.
- **Strike:** one attempt in the dispatcher's bounded kill sequence (`dispatcher.killAttempts`) against a session that went silent. After the last strike the dispatcher gives up on the session, not the slot; the loose worker becomes a person's business — the ending says so loudly.
- **The assistant:** the agent people speak to on channels and Linear (`assistant.md`, seeded at `<home>/.opencode/agents/`). Older pages call it **the librarian**; that name is retired here — it is the same agent.
- **Follower (historical):** the 2026-10-01 design's name for the tracker module that listened to the orchestrator's run events. The stage rulings replaced it the same day — a tracker now **answers stages** (`initWork`, `startWork`, `endWork`, …) instead of following events. Old checklist lines about "the follower" or "the follower-era" mean that superseded design.

## Orchestrator

The orchestrator is the thing that allows tracker activity (e.g. webhooks) to initiate work.
It is responsible for managing priorities, maintaining the flow of tickets, and making sure work is done in the right place.

The orchestrator organizes and prioritizes work requested by trackers.

### Tickets

Trackers translate their tickets to normalized tickets for the orchestrator. Every ticket has a lane: where the ticket is in the workflow (used to decide priority).

A ticket can also be **blocked**: it is waiting on a human answer (e.g. linear elicitation, or a HITL label) or another ticket. Blocked tickets are never picked up.

### Lanes

A tracker maps its lanes to orchestrator lanes to allow for prioritization.

The order of the lanes in the config is left to right. It is also the priority order: lanes further to the right are treated as closer to done and are picked from first when capacity becomes available.

By default, workflow movement follows that same order. A lane can override its next or previous lane, so lane position defines priority even when the transition path is not strictly neighbouring lanes.

**Ruled 2026-10-02:** the config key for a lane's name stays **`name`** (the
operator agreed `lane.lane` is weird; everything else in this document's
vocabulary stands), and **closed states are never configured** — the tracker
recognizes them by type, so Done, Canceled and Duplicate are not lanes in
the array. A run ending in the last configured lane moves nowhere: a person
closes the ticket.

| Type            | How it is recognized            | What happens                                                                           |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| **Worker lane** | Has an `agent`                  | A worker does the work here.                                                           |
| **Queue lane**  | `queue: true`                   | Holds tickets that are ready to enter the next worker lane when capacity is available. |
| **Human lane**  | No `agent` and no `queue` flag  | Only a human moves tickets out of here.                                                |
| **Closed lane** | Marked as closed by the tracker | Finished. Never picked up. E.g. Done, Canceled, Duplicate in Linear.                   |

A lane cannot be both a worker lane and a queue lane, and should fail loudly when this is the case.

Lane semantics as built (folded from the 2026-10-01 design doc, 2026-10-02):

- A tracker state named by **no lane** is not a lane: nothing is picked up
  there, and a ticket whose run is working there goes **silent** — the run
  stops and no further updates are sent for it.
- **A stop moves nothing.** A person who stopped the work left the ticket
  where they wanted it; the orchestrator does not second-guess them. What a
  stop does take back is its own: a worktree the run made is torn down
  (ruled 2026-10-03) — uncommitted work and local commits go with it, what
  was pushed stays pushed — and the worker's OpenCode session stays for
  inspection.
- A lane may say `worktree: true`: its worker gets its own git worktree on
  the ticket's branch (built 2026-10-02; the crossing to `origin` is the
  forge's, injected). Default false — the worker works in the project's
  checkout itself.
- Whether a ticket (or a blocker) is **finished** travels on the neutral
  contract as a boolean verdict; each tracker decides which of its states
  mean closed. The decision code never sees the words.

**Example flow**

| Lane                      | Type         | What happens here                                                                              |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Triage                    | Worker lane  | A worker refines the new ticket.                                                               |
| Backlog                   | Human lane   | The ticket waits for human prioritization and approval.                                        |
| Todo                      | Queue lane   | The ticket is approved and waiting for capacity before being moved to In Progress on capacity. |
| In Progress               | Worker lane  | On capacity: a worker picks up the ticket or processes feedback (injected, never fetched).    |
| Review                    | Worker lane  | On capacity: a worker reviews the changes.                                                     |
| Test                      | Worker lane  | On capacity: a worker tests the changes.                                                       |
| Release                   | Human lane   | On capacity: a human approves and ships.                                                       |
| Done, Canceled, Duplicate | Closed lanes | Nothing.                                                                                       |

#### Moving tickets

The orchestrator can move a ticket to the **next** or **previous** lane using the tracker, never anywhere else. Humans can move a ticket anywhere.

By default, next and previous are the neighbouring lanes. A lane can override this with optional `next` and `previous` settings.

For example, a successful review goes to test, a failed review goes to In Progress. But a failed test should go back to In Progress as well, not Review:

```json
{
  "lanes": [
    { "name": "Backlog" },
    { "name": "Todo", "queue": true },
    { "name": "In Progress", "agent": "dev", "worktree": true },
    { "name": "Review", "agent": "dev", "worktree": true },
    {
      "name": "Test",
      "agent": "test",
      "worktree": true,
      "previous": "In Progress"
    },
    { "name": "Release" }
  ]
}
```

#### Queue lanes

A queue lane holds fresh work that is ready to enter the next worker lane. It is marked in the config with `queue: true`:

```json
{ "name": "Todo", "queue": true }
```

The queue's next lane, either by order or through the `next` override, must be a worker lane. Any other configuration is invalid.

For simplicity: think of the queue lane as an extension of the worker lane. It's just split into a separate tracker lane.

When the orchestrator processes a worker lane, it considers eligible tickets already in that lane first. Once those are exhausted, it continues with the queue lane as the bottom of the same work list.

For each ticket taken from the queue, the orchestrator acquires a lease, moves the ticket into the worker lane, creates its claim, and starts a worker immediately. The resulting lane-change webhook is ignored because the ticket already has a claim for that lane.

In the example flow, a human moves a ticket from Backlog into Todo, which means "this is approved and prioritized for pickup."

A queue lane has no `agent`. Nothing is worked on while a ticket sits in it.

This keeps fresh work and started work separate. In the example flow, tickets already in In Progress are picked up before tickets waiting in Todo. Rework therefore goes before fresh work without needing any special priority rule.

A workflow can have at most one queue lane. Queue lanes are optional: without one, a human can move tickets directly into the worker lane instead.

The setup wizard asks for the queue lane as **one question after all lanes are configured** (ruled 2026-10-02): a select of the configured lanes, plus `-- None --` — not a question per lane.

#### Turn end

A worker's turn should end with a report: the completion tool or a question to a person. A turn that ends with neither is not taken at its word — OpenCode's records decide.

A turn ended is `session.execution.succeeded` followed by `orchestrator.turnEndDebounce` (default **5 seconds**) of no new execution, and an empty read of the session's unanswered questions (forms). A new execution cancels the judgement outright. A queued prompt and a pending permission never reach this test: both hold the execution open, so no ending event fires while they wait. Only true silence earns the **nudge** — the operator's editable `nudge` prompt, bounded in number, and once the budget is spent the run fails visibly: ended its turn without reporting — and the ticket moves like any failure.

A worker's **permission prompt** is answered by aivi, not by a person: the contract says a blocked worker asks on the ticket, so the orchestrator rejects the request at once with the operator's editable `permission-denied` words, naming `aivi_ask`. Only watched sessions — aivi's own workers — are answered; a person's session is never watched, and its prompts stay the person's.

An execution that **fails** — a model that would not load, a provider that died — is not a turn end: the session speaks no more, so there is nothing to judge and nobody to nudge. The run fails visibly with the wire's own words, and the ticket stays where the person can see it, because the worker never got to work on it.

## The dispatcher

The dispatcher manages configured resources through capacity pools.
It creates sessions and grants leases that allow other systems to use those resources.

### Capacity pools

Capacity is limited per **pool**, not per lane.

A pool has a name, a model, a capacity, and an optional fallback pool. Pools belong to the dispatcher and are configured once for the whole installation, not per project.

```json
{
  "dispatcher": {
    "pools": {
      "default": {
        "model": "mlx-serve/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit",
        "capacity": 2,
        "fallback": "overflow"
      },
      "worker": {
        "model": "anthropic/claude-opus-5.5",
        "capacity": 2
      },
      "overflow": {
        "model": "z-ai/glm-5.3-flash",
        "capacity": 5
      }
    },
    "timeouts": {
      "idle": "1h",
      "prepare": "5m"
    }
  },
  "projects": {
    "example-project": {
      "lanes": [
        {
          "agent": "product",
          "name": "Triage"
        },
        {
          "name": "Backlog"
        },
        {
          "name": "Todo",
          "queue": true
        },
        {
          "name": "In Progress",
          "agent": "dev",
          "pool": "worker",
          "worktree": true
        },
        {
          "name": "Review",
          "agent": "dev",
          "worktree": true
        },
        {
          "name": "Test",
          "agent": "test",
          "pool": "worker",
          "worktree": true,
          "previous": "In Progress"
        },
        {
          "name": "Release"
        }
      ]
    }
  }
}
```

- A worker lane, (or a channel, or jobs etc) can name a pool. Lanes that name none draw from the `default` pool.
- The pool determines the model when a session is created. The agent owns the behavior: prompt, tools, and so on. If both specify a model, the pool wins. **Ruled 2026-10-02:** the only time an agent file's model wins is in a lane whose pool names **no model**.
- Fallback chains must not contain cycles and must name pools that exist.
- `timeouts.idle` applies to all leases with a session. It is how long a lease may go without activity on its session before the dispatcher treats it as abandoned, kills the session, and takes the slot back. The default is 180 minutes. It measures silence, not total duration: a turn that runs for an hour but keeps producing activity is healthy.
- `timeouts.prepare` applies to leases that have no session. This is the time in which a distributed lease needs to be provided with a session before being revoked.

**Simplest setup:** one `default` pool and no `pool` on any lane. One number caps the whole installation.

**Which pool a ticket counts against:** the pool of the worker lane where the work happens.

#### Fallback

If the preferred pool is full, the dispatcher can grant a lease from its `fallback` pool when one was configured. That fallback may use a different model.

**Fallback only applies when creating a new session.**

A session keeps the pool it was created in. A lease that resumes an existing session therefore has to use that session's original pool.

If that pool has no free slot, the dispatcher cannot grant the lease, even if a fallback pool has room. Running the session in another pool would mean changing the model and losing the existing (prefill) cache. For orchestrator tickets, this requirement does not block the whole lane. The orchestrator skips that ticket and continues looking for other eligible tickets in the lane (until both the pool, and fallback pool, have been depleted).

#### Default pool

When no pool is configured, capacity is not moderated. No pool configuration is treated as unlimited capacity. This is the default behavior (ruled 2026-10-02).

#### Nesting

Fallback pools may themselves also have fallback pools as long as it does not result in a cyclical configuration. This allows for a tiered pool system.

### Leases

A lease holds one slot in a pool. It may exist before a session does.

There are two lease types; only the second is built:

|                       | **Turn lease** (design)                           | **Session lease** (built)            |
| --------------------- | ------------------------------------------------ | ------------------------------------ |
| **Used by**           | Discord, Slack, jobs, the assistant, the dreamer | The orchestrator, for ticket work    |
| **Request means**     | Run this prompt                                  | Give the caller direct use of a slot |
| **Who sends prompts** | The dispatcher                                   | The caller                           |
| **Session**           | Created or resumed by the dispatcher             | May be attached immediately or later |

#### Turn lease — designed, not built

A turn lease would ask the dispatcher to run a prompt. Nothing sends such a
request yet: the services named above run their turns through their own
machinery against `scheduler.resources`, and the steer-versus-queue delivery
this section's rulings settled lives today in the channel engine
([channels](channels.md)), not in the dispatcher.

When granted, the dispatcher claims a slot, creates or resumes the session, and runs the prompt.

If that session already has an active turn lease, no new lease or slot is needed. The prompt is delivered through OpenCode using `steer` by default, or `queue` when requested.

OpenCode owns queued input. The dispatcher does not keep its own turn counter or message queue.

A turn lease ends when the session is no longer present in `/active` and its inbox is empty. (Both endpoints verified live against the OpenCode service, 2026-10-01: `GET /api/session/active`, `GET /api/session/:id/inbox`.)

The default is `steer` (ruled 2026-10-02: "Default will be steer, and the slash commands therefor become queue instead of steer"); the built echo of that ruling is interjection-by-default in the channels.

#### Session lease

A session lease gives the caller direct use of one slot.

The lease may be created with an existing session already attached. Otherwise it starts without a session, allowing the caller to prepare (e.g. orchestrator setting up a worktree which is required to provide the directory).

The caller then provides the agent, directory and optional existing session ID. The dispatcher creates or resumes the session and attaches it to the lease.

A lease without a session expires after a preparation timeout `timeouts.prepare`.

Once a session is attached, the caller talks to it directly. The lease remains until released or expired.

#### Ending a lease

A lease ends when:

1. a turn lease finishes;
2. a session lease is released;
3. preparation times out; or
4. an attached session exceeds `timeouts.idle`.

When expiring an attached session, the dispatcher kills it before freeing the slot. If the kill cannot be confirmed, the slot remains unavailable.

Ending a lease does not delete its session.

If the dispatcher ends a lease itself, it notifies the owner. For ticket work, the orchestrator then clears the claim that mirrors it.

**Ruled and built 2026-10-02.** The monitor is one timer per lease, aimed
at a known instant — the prepare window from the grant, the idle window
from the last sign of life — and nothing else. Every grant, every session
and every activity signal re-aims that one timer; there is no interval and
no poll anywhere in the dispatcher. The timeouts watch leases whether or
not pools count them: a silent worker dies at its idle clock even in
unlimited mode, because the timeout is about the work, not the accounting.
An unconfirmed kill keeps the slot unavailable and the next look is a
known instant, not a poll: the retry strikes again — at most
`dispatcher.killAttempts` times (default **3**, ruled 2026-10-02) — until
the kill confirms. After the last strike the dispatcher gives up on the
session, **not** on the slot: the lease ends, the capacity returns, and
the ending carries the machine-readable `kill-unconfirmed` code. The
tracker that owns the ticket says so loudly — its platform's help mark —
and a person goes looking. A worker may still be loose; that is a
person's war now, not the dispatcher's. After a restart the survivors' clocks
run from their **stored** activity — a silence that began before the
restart is timed from where it began. The boot pass that reads OpenCode's
reality **defers whole** when OpenCode cannot be reached at all — including
when discovery finds no service to build a client against
(`lifecycle: "discover"`, none registered): the host boots and serves, the
leases stand untouched, and their clocks arm as they would for any silence.

### Dispatcher queue

When capacity is unavailable, lease requests can wait in an in-memory queue for the pool.

A queued request is not a lease and holds no capacity. When capacity becomes available, the dispatcher creates the lease and notifies the caller.

The queue is deliberately ephemeral. Restarting the dispatcher clears it; callers simply submit requests again for work that is still relevant.

Callers must cancel pending requests when the work becomes invalid. For example, the orchestrator cancels one when its ticket is moved or blocked. Cancellation only loses that request's place in the queue.

Queue request IDs and cancellation state may also remain entirely in memory.

**Ruled and built 2026-10-02.** A service registers one callback namespace
with the dispatcher; a full pool only waits for a service that has
registered to hear — a lease granted to nobody would be a leak, not a
queue, so an unregistered service gets the plain `full` refusal.
**Fulfilment does not re-check eligibility (ruled 2026-10-02): cancel-on-
move is the mechanism.** A person's move on a queued ticket cancels its
request the moment the webhook lands — the wait is the plan, not a
question. Each entry carries its own plan: a walk entry names its lane and
whether the ticket was a queue pickup; a push entry rides with the
tracker's summary and directory. What slips through a race ends in the
claim's guard — a ticket that took a run gives the lease back unheard,
never a second worker — and a lane that vanished with the wait is said
loudly while the lease goes back.

## The tracker's stages

**Ruled 2026-10-02.** Orchestrator and tracker are one division of labour
said as an interface (module authors meet `Tracker` at `@aivi/plugin`, the
package that **declares** it; the host imports the contract from the kit and
follows it — the flip of 2026-10-02): the orchestrator
orchestrates and never learns what a ticket platform is; the tracker
tracks and answers for its platform alone. A tracker module registers ONE
`Tracker` — the board the walk reads (`projects`, `tickets`, `moveTo`,
`ticketLane`) and
the stages every run walks through:

1. **`initWork`** — the slot is in hand and the run is claimed: open the
   ticket on the platform and answer with its **work entry**: the
   **summary** the worker starts with, and the ticket's **branch name**
   where the platform names one (Linear's `Issue.branchName`). Linear's
   delegate mutation creates the agent session and Linear's own answer
   serves as the summary; the tracker records the pair and posts a first
   word ("preparing the workspace"). A `worktree: true` lane gets its own
   git worktree on exactly that branch before the session opens — the
   crossing to `origin` is the forge's, injected; a lane that wants a
   worktree whose tracker named no branch fails the run visibly.
   **Awaited**: failure fails the run visibly and the slot goes back.
2. **`ready`** — the worker's session exists and its environment is
   ready: where the tracker joins the run to the pair `initWork` opened.
   A render.
3. **`startWork`** — optional: the task went in and work is turning. A
   platform whose session shows its own life (Linear watches its agent
   sessions) says nothing here.
4. **`question`** — the worker asked a person and parked. Required of
   every tracker: the OpenCode form is the durable record of the wait,
   but only the tracker knows what a question looks like on its platform.
   Options are **suggestions**: the form's field takes free text too
   (`custom`, live 2026-10-02 — a person typed "IMAGINATION" where the
   worker had listed map/globe/painting, and a strict field refused the
   reply and stood unsettled), so the record closes with the person's
   own words.
   A render.
5. **`plan`** — optional: the working plan, whole as it stands. A render.
6. **`endWork`** — the run ended: say so where people read, in the shape
   the platform gives endings. **Awaited**; a permanent failure here does
   **not** hold the ticket — the tracker marks it for a human in its
   platform's words (help is on the way), and the orchestrator moves and
   releases anyway.

Before the ending move the orchestrator asks the board where the ticket
sits (`ticketLane`, ruled 2026-10-02). If it is gone from the board, or
sits somewhere that is neither the lane the run worked nor the target, a
person moved it — normally while the webhook that would have ended the run
was missed — and **their move wins**: the owed move is spent, never undone,
and the log says so plainly. The walk's claim move asks nothing first: the
claim read the board a breath ago.

The lifecycle stages (`initWork`, `endWork`) are awaited — their failure
is the run's failure, said visibly; the renders (`ready`, `startWork`,
`question`, `plan`) are fire-and-forget — a platform that cannot show a
thing loses nothing the orchestrator cares about, and the tracker retries
its own renders, in its own time, from its own outbox.

The worker's **first prompt is the orchestrator's composition**: a neutral
line naming the project, the lane and the checkout, the ticket's summary
as the tracker returned it, the feedback-loop paragraph when the run
started with open review threads on its pull request (what it owes, named
once at the start: `docs/plans/git-workflow.md`), and the worker contract
explaining the tools.
The tools are the host's, so their explanation is core's, not any
tracker's — `firstMessage` on a board feed is dead: the tracker supplies
the ticket's words, never the worker's first message. The *guidance texts*
the composition fills — the worker contract, the feedback-loop opener, the
posture lines, the escalation form, the job-result re-entry — are the
operator's editable copies under `<home>/prompts/`, read at use
([configuration](../packages/host/docs/configuration.md#home)): the composition is code, the
words are theirs.

There is **no event bus**: the stages are the surface. A run's ending,
failure or question never arrives as an event somebody must subscribe to;
a tracker that leaves an optional stage unimplemented loses nothing, and
the orchestrator never learns who is Linear and who is Jira.

## How work gets picked

Anything that can change available work wakes the orchestrator: tracker events, completed work, and dispatcher callbacks.

On every wake, the orchestrator walks the lanes from right to left. Within a lane, tickets are considered top to bottom.

A ticket is eligible when:

- it is in a worker lane, or in that worker lane's queue;
- it has no claim;
- it is not blocked; and
- there is no pending lease request for it.

For each eligible ticket, the orchestrator requests a session lease for the worker lane's pool.

The dispatcher either accepts the request or refuses it. Accepted requests may become leases immediately or wait in the dispatcher's queue. Once a service already has a request waiting in a pool, further requests from that service for the same pool are refused.

A refusal means the orchestrator stops trying work for that pool during the current pass. It can still continue with work that uses other pools.

When the dispatcher creates a lease, it notifies the orchestrator and identifies the request it belongs to. This wakes the orchestrator again.

There is no eligibility re-check before starting (ruled 2026-10-02): the
wait is the plan, and the claim's own guard answers a race.

The orchestrator creates the claim and starts the run, in the operator's
order: a **queue pickup enters the worker lane first** (its webhook is a
wake and nothing more), the tracker's **`initWork`** opens the ticket on
the platform and returns the ticket's summary, and the orchestrator
composes the first prompt and turns the key. A lifecycle failure — the
lane that would not take the ticket, the platform that would not open it
— fails the run visibly and gives the slot back. An early failure (no
worker ever came up) does **not** wake the walk again: the pass that
claimed it is still walking, and a failure that woke itself would spin;
the next human event drives the retry, the same way a person retrying a
job does.

For a ticket from a queue lane, the claim is for the worker lane it is entering. The orchestrator moves the ticket into that lane before starting the worker. The resulting lane-change webhook is ignored when the ticket already has a claim for that same lane.

When work finishes the order is the operator's (ruled 2026-10-02): the
tracker's **`endWork`** says the closing words first and is awaited; then
the orchestrator **moves** the ticket where its lane order chose — a move
that misses retries at known instants and from the next boot, for the
tracker's move is idempotent and the debt lives in the run's row until it
lands; and **lastly** the lease returns.

There is **no merged queue across platforms**: each tracker's order stays
its own; when a slot frees, the orchestrator collects ready candidates from
every service, sorts once by the rules above, and takes the top. No
platform's ordering leaks into another's.

If the dispatcher ends a lease, the orchestrator clears the corresponding claim.

**Ruled and built 2026-10-02 (P1), amended 2026-10-03.** A stop **releases**
the ticket back to the board: nothing anywhere remembers it. The stop's
ending is said, the ticket stays where the person left it. "Not that one
again" is said on the board itself: the HITL label — a person's mark for
human hands — is the only thing that keeps a ticket off the walk's list,
exactly like a person moving it back to the human lanes. A stop-memory in
a database would be a second, invisible board state; the board is the
state. The amendment made the tracker live up to that sentence: a stop it
takes from a conversation or from a delegate removal puts the label on the
ticket **before** the run ends — the ending wakes the walk in the same
breath, and an unmarked stopped ticket in a worked lane came straight back.
A stop OpenCode would not answer the interrupt for ends
`stop-unconfirmed`: the run still ends — its lease and worktree are aivi's
to take back whatever OpenCode says — but the closing says a worker may
still be running and marks the ticket for a person, instead of claiming
"stopped at your request".

**Ruled and built 2026-10-02 (P6, P8).** The walk is the only door for
board work, and every run that gets a worker gets a real agent session:
`initWork` opens the ticket on the platform — Linear delegates to its own
app and the answer carries the session — so questions, plans and endings
all render in that session, in the platform's own shapes. There is no
sessionless ceremony and no read watermark: the pairs the tracker keeps
are the whole list its boot pass reconciles, and the lane moves are the
orchestrator's own debt — owed moves live in the run's row until they
land, and its boot pass re-drives them; the tracker's move is idempotent,
so a landed one lands twice as nothing.

Pending lease requests are cancelled when their ticket moves, becomes blocked, or otherwise stops being eligible.

## When a worker needs human input

If the tracker supports human interaction as part of the active agent session, such as Linear elicitation, the ticket remains claimed and the session continues normally. The ticket is not blocked.

**Ruled 2026-10-02:** the open elicitation **holds its slot** — orchestrator
territory — with a configurable timeout after which the lease is released:
`orchestrator.elicitationKeepAlive`, on the orchestrator's root config,
default **5 minutes**. It needs the waiting state to time against
(`awaiting_input` returns with it). When the human answers, the ticket
reacquires capacity and **resumes its existing session** — fallback never
applies to a resume, because the session keeps the pool it was created in.

**Built 2026-10-02.** The keep-alive's ending is a **release, not an
expiry**: nobody is killed, the session keeps its open form, and the claim
stands — the ticket waits without a slot, and no other worker takes it.
The answer's delivery is the orchestrator's, and its order is **OpenCode
first, the books second** (ruled 2026-10-03): the worker's prompt goes in
first, and only when OpenCode has taken the words does the run flip back
to `working` and the form close as the record. A prompt OpenCode refuses
moves nothing — the run stays parked on its open form, the keep-alive
re-arms as it stood, and the person hears the failure in the conversation
instead of silence; the answer is giveable again. (Flipping first bought
stuck runs: a failed queued delivery left a `working` run with no lease,
no turn and no clock, nothing timing it out until the next boot.) A raced
or late delivery whose books-guard missed — the other answer won, or a
stop landed in flight — says so in the log and touches nothing. A full
pool queues the reacquisition like any other
resume — the answer's words wait with the request and the person is told
the worker wakes when a slot opens; a refusal is said too, and the question
still stands. A stop reaches a parked run: stop means stop, even
mid-question. After a restart, a wait that survived the outage keeps
waiting — its keep-alive re-arms from the boot, since the silence during
the outage cost nobody a slot.

For trackers where human input happens outside the active session, the orchestrator releases the lease, clears the claim, and marks the ticket blocked.

When the human responds, the ticket is unblocked and the orchestrator is woken. The ticket then goes through normal priority and capacity handling again. Its existing session can be resumed when a lease is granted.

## Why it works this way

- **Finish before starting.** Lanes are processed right to left, and existing tickets in a worker lane are processed before its queue.
- **Fresh work stays separate.** The queue is the bottom of its worker lane, but remains a separate tracker lane for human prioritization.
- **The orchestrator decides priority.** The dispatcher only decides when capacity is available.
- **The dispatcher owns capacity.** Work cannot start without a lease.
- **Pending work is cheap to lose.** Dispatcher queue entries and the orchestrator's matching request state are ephemeral. A restart simply causes current tracker state to be evaluated again.
- **Active work survives restarts.** Claims and leases are persisted and can be reconciled.

## Anticipated questions

- **Q:** What happens when a person assigns a delegate directly in a tracker such as Linear?

- **A:** One fixed refusal (ruled and built 2026-10-02, P11). Work reaches
  the orchestrator through the board, not through a delegation: the walk
  starts a worker only when it takes the ticket itself, so a hand
  delegation gets the same plain answer whatever lane the ticket sits in,
  and the app removes itself as delegate. The only delegation not refused
  is the tracker's **own** — `initWork` delegating to its app — and that
  one never hears the refusal: its webhook is a redelivery the run's own
  guards fold away. A person's mention of the app in a comment is not a
  delegation; it is the project's assistant answering.

- **Q:** How does the dispatcher notify services that a lease is ready?

- **A:** Each service has a callback namespace. When a queued request becomes a lease, the dispatcher calls that service with the request and lease IDs. The callback is also a wake for the service to look for more work.
