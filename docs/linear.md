# Linear

Linear's native agents, run by aivi: a Linear *app* is delegated an issue (or
mentioned), Linear opens an *agent session*, and aivi runs the app's OpenCode
agent in a git worktree of the project, streaming what it does into the session
and posting the final answer as its response. This page owns the module's
behaviour and setup; the plan and what is still to come are in
[plans/linear.md](plans/linear.md); configuration fields are in
[configuration](configuration.md#linear).

## Words

| Word | Meaning |
| --- | --- |
| app | One Linear OAuth application acting as an app user (Linear's UI says "agent"); `linear.apps.<id>`, mapped to exactly one OpenCode agent |
| delegate | `Issue.delegate`: the app working the issue while the human assignee stays responsible |
| agent session | Linear's unit of agent work on an issue; aivi treats each as one conversation, id `<app>:<agent session id>` |
| activity | What flows in a session: aivi emits `thought` (progress, ephemeral), `response` (the answer) and `error` (refusals, stops); people's messages arrive as `prompt` activities, a stop request as a `prompt` with `signal: "stop"` |
| lane | A team workflow state by name; `projects.<id>.linear.lanes` maps lane → app for the listener (not built yet) |
| worker | The OpenCode session for one agent session: the app's agent, in `<home>/projects/<id>/worktrees/<agent session>`, kept for the whole run |

## What happens

1. **A person delegates or mentions the app** in an issue. Linear posts an
   `AgentSessionEvent` `created` webhook to
   `POST /v1/linear/webhooks/<app>` on the host listener. aivi verifies the
   signature and answers within the 5 seconds Linear allows, then works.
2. **Routing.** The issue's Linear project must match a checked-out project's
   `projects.<id>.linear.projectId` (and `workspaceId` when configured); the
   issue must not carry the HITL label (`linear.humanLabel`, default
   `needs-human`). Otherwise the session gets one `error` activity saying why
   and nothing else happens. The lane the issue is in is passed to the agent
   as context; a hand delegation runs the delegated app whatever the lane.
3. **Acknowledgement** within Linear's 10 seconds: an ephemeral `thought`,
   "Starting as `developer` in project website on branch `…`", or "Queued:
   another worker is busy in project …" when the project lock is taken.
4. **Worktree.** `git fetch`, then `git worktree add` under
   `<home>/projects/<id>/worktrees/<agent session>` on Linear's branch for
   the issue (`Issue.branchName`): from `origin/<branch>` when it exists
   upstream, from the local branch when only that exists, else a new branch
   from the remote default. A worktree elsewhere that already holds the
   branch (kept from an earlier session on the issue) is continued instead,
   since git checks a branch out once. `source/` is never worked in.
5. **The turn.** One conversation turn of the channel machinery
   ([channels](channels.md)): the app's agent, the worktree as directory, the
   prompt = a line saying which issue, project, lane, worktree and branch,
   then Linear's `promptContext` (issue, comments, guidance). Progress from
   the OpenCode event stream is posted as ephemeral `thought`s (mode
   `linear.progress`), each replacing the last. The verified final answer is
   one `response`. Permission prompts are rejected; the agent file decides
   what the agent may do.
6. **Follow-ups.** A `prompted` webhook (a person wrote in the session) is a
   new turn in the same OpenCode session, queued behind a running one.
   "Send stop request" in Linear arrives as `signal: "stop"`: the running
   turn is aborted, OpenCode's session interrupted, and one `error` activity
   says the worktree and session are left as they are. Nothing running: a
   short response says so.
7. **Locks.** One running worker per project and one per issue at a time,
   enforced when a turn is claimed; queued ones wait and said so at step 3.
   Capacity comes from the pool `linear.resource` like every other turn.

## When it does not end with an answer

| Situation | What Linear sees | State |
| --- | --- | --- |
| Stop request, host shutdown | one `error`: stopped; worktree and session kept | turn discarded with the reason, lock released |
| OpenCode unreachable before the prompt | one `error`: nothing started, try again | turn discarded, lock released |
| Turn longer than `linear.turnTimeoutMs` or an unverifiable failure | one `error`: an operator has been notified, the project stays locked | `blocked`; `aivi linear resolve ID --reason … --confirm-stopped` after inspecting the OpenCode session |
| aivi restarted mid-turn | one `error`: restarted while working, operator must resolve | `blocked` (nobody knows whether the agent stopped) |

`aivi linear status` lists pending worker turns and leases. Worktrees stay
for inspection; pruning them is not built yet.

## Setup

For each app (a developer app and a reviewer app are two apps):

1. In Linear, **Settings → API → Applications → New**. Name and icon are how
   the agent appears. Enable **Client credentials**. Under **Webhooks**,
   set the URL to `<public base>/v1/linear/webhooks/<app id>` and enable the
   **Agent session events** category (later also **Issues** for the
   listener, on one app only). Copy the client id, client secret and webhook
   signing secret.
2. In `<home>/.env`: `LINEAR_<APP>_CLIENT_ID`, `LINEAR_<APP>_CLIENT_SECRET`,
   `LINEAR_<APP>_WEBHOOK_SECRET` (`<APP>` = the id upper-cased, `-` → `_`).
   Tokens are requested with `grant_type=client_credentials` and the scopes
   `read,write,app:assignable,app:mentionable`; nothing is persisted.
3. In `aivi.json`: `linear.apps.<id>.agent` naming the OpenCode agent, and
   `projects.<id>.linear.projectId` (Linear's project id) with `lanes`.
4. The agent file: `<home>/.opencode/agents/<agent>.md`, or the repository's
   own `.opencode/agents/<agent>.md` to override it per project.
5. **Reachability.** Linear must reach the listener over HTTPS. `aivi serve`
   binds `host.bind:host.port`; put a tunnel or proxy in front (Tailscale
   Funnel, cloudflared, a reverse proxy, or run aivi where it is reachable)
   and give Linear that public base. Bearer auth does not apply to the
   webhook route; the signature is the authentication.

Rejected credentials or a missing variable are a `ConfigurationError` at
start (the host stops and says which); Linear being unreachable leaves the
module `degraded` and retried.

## Not yet

The listener (aivi delegating on lane changes), the HITL label added
mid-run, one app carrying issue events, worktree pruning, permission prompts
as `elicitation`, agent plans, `externalUrls`: all in
[plans/linear.md](plans/linear.md).
