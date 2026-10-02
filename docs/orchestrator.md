# Work Pull Flow

This document describes the concepts of the orchestrator and the dispatcher.

It attempts to outline the responsibilities of each system and the direction of work.

**Status (2026-10-02):** the design the operator wrote after thinking about it
for a very, very long time, with the rulings from its conversation folded in
(where folded, they are marked). It **owns** lanes, priority, queue lanes,
pools, leases and the dispatcher; the build checklist that shrinks as these
land is [plans/orchestrator.md](plans/orchestrator.md); the follower-side
contracts (completion, questions, recovery, the adapter seam) live in
[plans/templates/orchestrator.md](plans/templates/orchestrator.md).

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

The dispatcher is a central system, and the orchestrator pulling work is only one of the things it is used for.

The Discord bot, the dreamer, jobs, the librarian, and so on ask the dispatcher for leases in the same way.

All of these systems draw from the same pools, so nothing can bypass the limits.

## The basics

Let's cover some of the terminology used in this document.

- **Lane:** where a ticket is in the workflow. This is an orchestrator concept, designed to mirror how trackers organize work.
- **Session:** an OpenCode session. It outlives individual turns and leases. A session is created in a pool and keeps that pool for its whole life. A session does not consume capacity on its own.
- **Lease:** the right to occupy one slot in a pool.
- **Capacity and pool:** a pool has a fixed number of slots: its capacity. An active lease occupies one slot.
- **Claim**: the orchestrator record for an active ticket lease. It mirrors a session lease.
- **Blocked:** the ticket is waiting on a human answer or another ticket. An unclaimed blocked ticket is not picked up.

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

Lane semantics as built (folded from the follower-era design doc, 2026-10-02):

- A tracker state named by **no lane** is not a lane: nothing is picked up
  there, and a ticket whose run is working there goes **silent** — the run
  stops and no further updates are sent for it.
- **A stop moves nothing.** A person who stopped the work left the ticket
  where they wanted it; the orchestrator does not second-guess them.
- A lane may say `worktree: true`: its worker gets its own git worktree once
  a forge gives them. Default false — the worker works in the project's
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
| In Progress               | Worker lane  | On capacity: a worker picks up the ticket or processess feedback (injected, never fetched).    |
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

There are two lease types:

|                       | **Turn lease**                                   | **Session lease**                    |
| --------------------- | ------------------------------------------------ | ------------------------------------ |
| **Used by**           | Discord, Slack, jobs, the librarian, the dreamer | The orchestrator, for ticket work    |
| **Request means**     | Run this prompt                                  | Give the caller direct use of a slot |
| **Who sends prompts** | The dispatcher                                   | The caller                           |
| **Session**           | Created or resumed by the dispatcher             | May be attached immediately or later |

#### Turn lease

A turn lease asks the dispatcher to run a prompt.

When granted, the dispatcher claims a slot, creates or resumes the session, and runs the prompt.

If that session already has an active turn lease, no new lease or slot is needed. The prompt is delivered through OpenCode using `steer` by default, or `queue` when requested.

OpenCode owns queued input. The dispatcher does not keep its own turn counter or message queue.

A turn lease ends when the session is no longer present in `/active` and its inbox is empty. (Both endpoints verified live against the OpenCode service, 2026-10-01: `GET /api/session/active`, `GET /api/session/:id/inbox`.)

The default is `steer` (ruled 2026-10-02: "Default will be steer, and the slash commands therefor become queue instead of steer"): the `/steer` command dies and `/queue` takes its place.

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

### Dispatcher queue

When capacity is unavailable, lease requests can wait in an in-memory queue for the pool.

A queued request is not a lease and holds no capacity. When capacity becomes available, the dispatcher creates the lease and notifies the caller.

The queue is deliberately ephemeral. Restarting the dispatcher clears it; callers simply submit requests again for work that is still relevant.

Callers must cancel pending requests when the work becomes invalid. For example, the orchestrator cancels one when its ticket is moved or blocked. Cancellation only loses that request's place in the queue.

Queue request IDs and cancellation state may also remain entirely in memory.

**Ruled and built 2026-10-02.** A service registers one callback namespace
with the dispatcher; a full pool only waits for a service that has
registered to hear — a lease granted to nobody would be a leak, not a
queue, so an unregistered service gets the plain `full` refusal. When the
dispatcher fulfils a waiting request it re-checks the work **before
starting**: a walk request starts wherever the ticket sits now, a
delegation only for the lane it was delegated in — a ticket moved while it
waited is the person's next act, and the walk reads it fresh — and either
way the lease that does not fit goes straight back. A person's move on a
queued ticket cancels its request through the follower, and a queued
delegation keeps its Linear pair while it waits: when the lease lands, the
run attaches to the session the delegator already spoke in.

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

Before starting the work, the orchestrator checks that the ticket is still eligible for the lane the request was made for. If it is not, the lease is released.

Otherwise, the orchestrator creates the claim and prepares the work. This may include preparing the worktree and forge state before attaching a session to the lease.

For a ticket from a queue lane, the claim is for the worker lane it is entering. The orchestrator moves the ticket into that lane before starting the worker. The resulting lane-change webhook is ignored when the ticket already has a claim for that same lane.

When work finishes, the orchestrator moves the ticket as instructed, releases the lease, and clears the claim.

There is **no merged queue across platforms**: each tracker's order stays
its own; when a slot frees, the orchestrator collects ready candidates from
every service, sorts once by the rules above, and takes the top. No
platform's ordering leaks into another's.

If the dispatcher ends a lease, the orchestrator clears the corresponding claim.

**Ruled and built 2026-10-02.** A ticket a person stopped stays off the
walk's list until that person acts again — a move of the ticket, or a
fresh run. The board may still hold the ticket (a stop leaves it where
the person left it), but the follower remembers the stop and leaves the
ticket off what it offers: the walk never hands a fresh worker to work a
person just stopped. The memory survives restarts — an ending that
arrived while nobody followed carries it into the new process.

**Ruled 2026-10-02.** Picked-up work has no agent session — nobody
delegated it — and its ticket is owed its ceremony all the same: the
closing note and the lane move are said with the installation's own
credentials (the primary app), and the worker's question arrives as a
ticket comment, the OpenCode form remaining the durable record of the
wait. The plan is the one thing a sessionless run does not show; the
lane it moves in says enough. Endings that arrived while nobody was
listening are rendered at boot from the orchestrator's own record,
through the follower's read watermark; a rendering that fails leaves the
watermark where it stands and the next boot tries again. The narrow gap
this leaves — a stop landing exactly inside a module restart while the
host lives, before any follower could remember it — is a known
observation for the live round, not a silent claim of closure.

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

- **Q:** What happens when a user assigns a delegate directly in a tracker such as Linear?

- **A:** Hard error (ruled 2026-10-02, replacing this section's earlier reading). A human assigning a delegate is always an error: if there were capacity, the pull would have picked the ticket up anyway; if there is none, the assignment cannot run — "no capacity". If the ticket sits in the wrong lane it goes to the assistant, and very likely errors there too, so the preventative error is the smart thing at delegation time. **Not built yet:** it lands with the dispatcher era, whose same logic family also covers mentions in comments. Until then the delegation entry point keeps working as today (a claim + lease request from inside the module — aivi's own listener delegation is not a human assignment).

- **Q:** How does the dispatcher notify services that a lease is ready?

- **A:** Each service has a callback namespace. When a queued request becomes a lease, the dispatcher calls that service with the request and lease IDs. The callback is also a wake for the service to look for more work.
