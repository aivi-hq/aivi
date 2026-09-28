# @aivi/linear

Linear module: one app receiving every webhook, the assistant for people,
workers in git worktrees, and the Linear MCP proxy. Agent sessions run on
the host's channel machinery — a delegation becomes one bound conversation
and one worker turn of the lane's agent in its own worktree.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/linear` | `createLinearModule`, `openLinearStore`, `describeWorkers` |

## Model

- **One app, one persona, lanes pick agents.** The primary app carries the
  workspace's data feed and every agent-session webhook on one route.
- **A repository is a Linear team.** Routing reads the issue's team only;
  lanes, branch names, and labels live per team.
- **Stop means stop.** The turn is discarded, capacity released, worktree
  and session kept; only an unverifiable stop is `blocked`.

## Dependencies

`@aivi/host` as a peer (runs in-process with webhook routes on the same
listener).

## Docs

[linear](../../docs/linear.md) ·
[plan (what is left)](../../docs/plans/linear.md)
