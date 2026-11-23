---
title: Projects and tickets
description: How aivi stores a project, maps a board to lanes, and works a ticket without touching the clean checkout.
order: 3
group: Use aivi
---

A project is the place where aivi does work. It holds a checkout, its own memory, and a set of worktrees. The tracker decides which ticket is ready. The project decides which agent works it and where the work happens.

## What a project is

Everything about one project lives under the aivi home:

```text
~/.aivi/
  projects/
    shop/
      source/       the clean git checkout
      memory/       facts and proposals for this project
      worktrees/    one worktree per worker that needs isolation
```

The directory name is the project id. It starts with a lowercase letter and may contain lowercase letters, digits, underscores and hyphens. A checkout is the registration: aivi discovers projects by reading the directories under `projects/`, and `aivi projects add` is the convenient way to create one.

A project with memory but no `source/` is a repo-less project. It has knowledge and its own memory, which makes it useful for research, writing and decisions that do not belong to a repository.

The checkout is ordinary git. aivi writes nothing inside it, and the repository works the same outside aivi. The `projects-sync` job fast-forwards the checked-out branch to its upstream and leaves local changes, detached heads and diverged histories alone.

## Add, list and remove

```sh
aivi projects add
aivi projects add website
aivi projects list
aivi projects remove website
aivi projects purge website
```

`projects add` is role-driven. Core asks the configured forge to clone the repository, then the configured tracker to map the board. Each plugin asks its own questions and writes its own section under the project. With no forge configured, the command creates a repo-less project and sets `sync: false` so the sync job stays away from it.

The built-in tracker and forge pages are [Linear](plugin-linear.html) and [GitHub](plugin-github.html).

`projects remove` deletes the checkout and worktrees but keeps the project's memory. `projects purge` shows what it would delete and does nothing without `--confirm`.

Restart the server after adding or removing a project:

```sh
aivi service restart
```

## Lanes

A lane is a board state with a job. The tracker's project section maps its states to lanes, and the order of the lanes is the priority order. Lanes further to the right are closer to done and are picked first when capacity frees up.

| Lane type | How to recognize it | What happens |
| --- | --- | --- |
| Worker lane | It names an `agent` | A worker takes tickets here. |
| Queue lane | It sets `queue: true` | Tickets wait here until a worker lane has capacity. |
| Human lane | It names no agent and is not a queue | Only a person moves tickets out. |
| Closed lane | The tracker marks it closed | Nothing is picked up. |

A lane cannot be both a worker lane and a queue lane. That combination fails loudly instead of choosing a behavior.

The lane config belongs to the tracker plugin. For a Linear project it sits under `projects.<id>.tracker-linear`:

```json
{
  "projects": {
    "shop": {
      "tracker-linear": {
        "lanes": [
          { "name": "Triage", "agent": "product", "worktree": true },
          { "name": "Backlog" },
          { "name": "Todo", "queue": true },
          { "name": "In Progress", "agent": "dev", "worktree": true },
          { "name": "Review", "agent": "review", "worktree": true },
          { "name": "Release" }
        ]
      }
    }
  }
}
```

The GitHub tracker writes its own section in the same place. The lane words are the board's states, so they differ between trackers.

### What the lanes produce

A ticket that enters a worker lane can start a run. The orchestrator checks the ticket's delegate, any human-needed marker, and whether another worker already owns it. If the ticket is eligible and the dispatcher grants a lease, the worker starts in the project.

The run carries the lane's context. It does not change the agent named by the lane, and the worker cannot switch agents midway. It can still use the subagents its agent file allows.

## Worktrees and stopping

A lane with `worktree: true` gives the worker its own checkout:

```text
~/.aivi/projects/shop/worktrees/inf-214/
```

The worktree sits on the branch the tracker names for the ticket. This keeps concurrent workers apart and gives a stop a clear boundary.

When a person stops a ticket, aivi interrupts the turn, posts one final activity, and ends the run. The worktree and its local commits are removed. Anything pushed to the remote stays. The OpenCode session stays available for inspection, so the transcript is still there.

A stop that cannot be verified ends `blocked` instead. The ticket stays held until an operator looks at the session and resolves the run:

```sh
aivi runs show RUN_ID
aivi runs resolve RUN_ID --outcome succeeded --reason "Inspected the session" --confirm-stopped
```

Do not resolve a blocked run just to clear the queue. Resolving it is a statement that you checked the external side.

## A human can always take over

A human-needed label blocks automatic delegation. A hand delegation of that ticket is refused too, with an explanation in the tracker. A developer can open the project in plain OpenCode, do the work, and remove the label when the ticket is ready to return to the board.

The board is the memory of what happened. aivi keeps its own run records for the audit trail, but the visible state of the work lives in the tracker.

## What to read next

- [Orchestrator and dispatcher](https://github.com/aivi-hq/aivi/blob/main/docs/orchestrator.md) for the full walk, capacity and recovery rules.
- [Linear](https://github.com/aivi-hq/aivi/blob/main/docs/linear.md) and [GitHub](https://github.com/aivi-hq/aivi/blob/main/packages/forge-github/docs/github.md) for the tracker and forge setup.
- [Projects](https://github.com/aivi-hq/aivi/blob/main/docs/projects.md) for the directory layout and knowledge conventions.
