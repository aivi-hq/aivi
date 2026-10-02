# @aivi/tracker-linear

Linear module: one app receiving every webhook, the assistant for people,
workers in git worktrees, and the Linear MCP proxy. Agent sessions run on
the host's channel machinery — a delegation becomes one bound conversation
and one worker turn of the lane's agent in its own worktree.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/tracker-linear` | `createLinearModule`, `openLinearStore`, `describeWorkers`, `LINEAR` |
| `./config` | the `plugin` declaration: module id, config schema, project sections |
| `./setup` | `aivi add @aivi/tracker-linear`'s setup guide |
| `./setupProject` | the `tracker`-role project contributor: writes a project's teams and lanes |
| `./cli` | the `aivi linear` command |

## Model

- **One app, one persona, lanes pick agents.** The primary app carries the
  workspace's data feed and every agent-session webhook on one route.
- **A repository is a Linear team.** Routing reads the issue's team only;
  lanes, branch names, and labels live per team.
- **Two ids, on purpose.** The module id is this package's short name —
  `tracker-linear` — and so `plugins.tracker-linear`, the `/status` id, the log
  category and the project section's key. The *platform* id stays `linear`: the
  SQLite prefix, the session and message id prefixes, the lease owner, the
  webhook URL Linear's dashboard holds and the `aivi linear` command. Those say
  who a conversation is on, not which package speaks for it, and renaming a
  prefix would orphan every conversation already bound to it.
- **Stop means stop.** The turn is discarded, capacity released, worktree
  and session kept; only an unverifiable stop is `blocked`.

## Dependencies

`@aivi/host` as a peer (runs in-process with webhook routes on the same
listener).

## Docs

[linear](../../docs/linear.md) ·
[plan (what is left)](../../docs/plans/linear.md)
