# Linear

Linear's native agents, run by aivi. One Linear *app* — the **primary** —
receives every webhook: its own **agent session events** and the workspace's
**Issues** data changes, on one route. A person delegates an issue (or
mentions the app), Linear opens an *agent session*, and aivi runs a worker —
the lane's OpenCode agent in a git worktree of the project — streaming what it
does into the session and posting the final answer as its response. People who
want aivi itself rather than a worker talk to the **assistant**. This page
owns the module's behaviour and setup; the plan and what is still to come are
in [plans/linear.md](plans/linear.md); configuration fields are in
[configuration](configuration.md#linear).

## Words

| Word | Meaning |
| --- | --- |
| app | One Linear OAuth application acting as an app user (Linear's UI says "agent"); `linear.apps.<id>`. The **primary** carries the data feed and the bare `LINEAR_*` secrets; every other app is a face |
| face | An extra app: a name and icon in Linear's UI, its own credentials (`LINEAR_<APP>_*`) and webhook route, and no meaning for routing at all. An activity is posted with the token of the app the session lives on |
| primary | The one app by default; with faces, `linear.primary` names the app that carries the workspace data feed and authorises the Linear MCP. The listener always delegates on the primary, since that is whose token it holds |
| assistant | The OpenCode agent people address directly on Linear (`linear.agent`, default the aivi name): comment mentions, and delegations that no lane claims. It answers, clarifies or refuses; it does not do work |
| delegate | `Issue.delegate`: the app working the issue while the human assignee stays responsible. Its one meaning: *an app is working this issue* |
| agent session | Linear's unit of agent work on an issue; aivi treats each as one conversation, id `<app>:<agent session id>` |
| activity | What flows in a session: aivi emits `thought` (progress, ephemeral), `response` (the answer) and `error` (refusals, stops); people's messages arrive as `prompt` activities, a stop request as a `prompt` with `signal: "stop"` |
| lane | A team workflow state by name; `projects.<id>.linear.lanes` maps lane → **agent**, `null` leaves it to humans. `{ agent, worktree: false }` runs the agent in the project's checkout instead of a worktree |
| listener | `linear.listener: true`: aivi delegates an issue that enters a mapped lane to the primary and starts the lane agent's session; off, only what people do in Linear starts a worker |
| worker | The OpenCode session that does work: the lane agent, in `<home>/projects/<id>/worktrees/<agent session>` (or the project checkout for a `worktree: false` lane), kept for the whole run |

## What happens

1. **A person delegates or mentions the app** in an issue. Linear posts an
   `AgentSessionEvent` `created` webhook to
   `POST /v1/linear/webhooks/app/<app>` on the host listener. aivi verifies the
   signature and answers within the 5 seconds Linear allows, then works.
2. **Routing is deterministic code, from the issue re-read.** The HITL label
   (`linear.humanLabel`, default `needs-human`) refuses any agent with one
   `error` activity. A **delegation whose lane maps an agent** runs that lane's
   agent — the face is the person's choice, never a routing input, and a
   delegation into a mapped lane runs the lane agent whatever face was picked.
   Everything else people send — a comment mention, a delegation into an
   unmapped lane, an issue whose team maps no project — lands on the
   **assistant**. The assistant's directory is the project's `source/`
   checkout when the team maps one, the home otherwise; it never gets a
   worktree. A delegation nothing claims is un-taken (aivi removes the
   delegate) and the assistant's response is the comment trail. The issue must
   not carry the HITL label; otherwise the session gets one `error` activity
   saying why and nothing else happens.
3. **Acknowledgement** within Linear's 10 seconds: an ephemeral `thought`,
   "Starting as `developer` in project website on branch `…`", or "Queued:
   another worker is busy on this issue; I start when it finishes."
4. **Worktree.** `git fetch`, then `git worktree add` under
   `<home>/projects/<id>/worktrees/<agent session>` on Linear's branch for
   the issue (`Issue.branchName`): from `origin/<branch>` when it exists
   upstream, from the local branch when only that exists, else a new branch
   from the remote default. A worktree elsewhere that already holds the
   branch (kept from an earlier session on the issue) is continued instead,
   since git checks a branch out once. `source/` is never worked in — except
   by a lane that says `worktree: false`, which runs its agent in the
   checkout on main, with the agent file's own `edit` deny as the only guard.
   The worktree then says who launched it: the checkout enables git's
   `worktreeConfig` extension (git refuses per-worktree settings without it),
   and the worktree itself sets `user.name` and `user.email` to
   `identity.github` plus `agent.autonomous = true`. A worker's commit is the
   bot's alone — author *and* committer, whatever the shell says — and the
   commit plugin adds no co-author trailer. The checkout stays unmarked, so a
   `worktree: false` lane keeps the attended behavior where the person is the
   author and the agent a co-author. Marking happens whenever a worktree is
   used, so one kept from an earlier session is marked as well, and a worktree
   that cannot be marked refuses the worker instead of committing as whoever
   owns the machine.
5. **The turn.** One conversation turn of the channel machinery
   ([channels](channels.md)): the lane's agent, the worktree (or checkout) as
   directory, the prompt = a line saying which issue, project, lane, worktree
   and branch, then Linear's `promptContext` (issue, comments, guidance).
   Progress from the OpenCode event stream is posted as ephemeral `thought`s
   (mode `linear.progress`), each replacing the last. The verified final answer is
   one `response`. Permission prompts are rejected; the agent file decides
   what the agent may do.
6. **Follow-ups.** A `prompted` webhook (a person wrote in the session) is a
   new turn in the same OpenCode session, queued behind a running one.
   "Send stop request" in Linear arrives as `signal: "stop"`: the running
   turn is aborted, OpenCode's session interrupted, and one `error` activity
   says the worktree and session are left as they are. Nothing running: a
   short response says so.
7. **One worker per issue.** A second `created` for an issue that already has
   a pending worker is a redelivery, not a second worker. There is no
   per-project lock: worktrees isolate concurrent workers, and capacity comes
   from the pool `linear.resource` like every other turn. The listener does
   not delegate an issue that is blocked by unfinished issues (Linear's native
   blocking).
8. **Issue changes** (the **Issues** data-change category, on the primary's
   route). When an
   issue with a pending worker gains the HITL label, moves to a lane that
   maps another agent (or no agent), or loses the app as delegate, the worker
   is stopped as in step 6 with a `thought` saying why. A lane change between
   two lanes of the same agent changes nothing. With the listener on, an issue
   entering a mapped lane with no delegate, no HITL label and no pending
   worker is delegated to the primary (`agentSessionCreateOnIssue`, then
   `issueUpdate` with the primary as delegate) and its worker starts at once
   from the mutation; a `created` webhook arriving for that session afterwards
   is a redelivery. The issue is re-read from the API for every such change,
   so label and state names are current, and a change delivered twice finds
   the delegate already set.

One route shape: `POST /v1/linear/webhooks/app/<id>`, verified by that app's
signing secret. The primary's route carries both families — its own agent
session events and the workspace's Issues data changes. A data change
delivered to a face's route is a misroute: acknowledged, dropped, logged per
`linear.logMisroutes` (default `true`) at warn, `false` at debug only.

## When it does not end with an answer

| Situation | What Linear sees | State |
| --- | --- | --- |
| Stop request, host shutdown | one `error`: stopped; worktree and session kept | turn discarded with the reason; capacity released |
| OpenCode unreachable before the prompt | one `error`: nothing started, try again | turn discarded, capacity released |
| Turn longer than `linear.turnTimeoutMs` or an unverifiable failure | one `error`: an operator has been notified, the issue waits | `blocked`; `aivi linear resolve ID --reason … --confirm-stopped` after inspecting the OpenCode session |
| aivi restarted mid-turn | one `error`: restarted while working, operator must resolve | `blocked` (nobody knows whether the agent stopped) |

`aivi linear status` lists pending conversations (workers and assistant
sessions) and leases. Worktrees stay for inspection; pruning them is not
built yet.

## The Linear MCP

Agents act in Linear through Linear's hosted MCP, reached through a forwarder
the module hosts itself: on by default (`linear.mcp: false` disables it),
`serve` binds
`http://127.0.0.1:<port>` (default 4101, loopback only) and pipes every request
verbatim to `https://mcp.linear.app/mcp`, rewriting only the authorization
header to the app-actor token from the module's own client — minted with
`client_credentials`, re-minted once on a 401 (the app token lives 30 days
with no refresh token; Linear's documented pattern). Writes attribute to the
app, never a human; personal API keys would never expire but attribute to a
human: disqualified. OpenCode connects as a remote MCP
(`type: "remote"`, `url: http://127.0.0.1:4101/mcp` —
`example/opencode.jsonc`). The MCP lives and dies with `serve`, like the
webhooks and the workers it serves.

## Setup

One app in Linear — the 95% case:

1. **One app.** In Linear, **Settings → API → Applications → New**. Name it
   `identity.name` (the persona; aivi cannot set the name — use the name from
   config here). Enable **Client credentials**. Under **Webhooks**, set the
   URL to `<public base>/v1/linear/webhooks/app/<app id>` and enable both the
   **Issues** data-change category and **Agent session events**. Copy the
   client id, client secret and webhook signing secret.
2. In `<home>/.env`: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and
   `LINEAR_WEBHOOK_SECRET` — the bare names are the one app, whose
   credentials also authorise the Linear MCP. Tokens are requested with
   `grant_type=client_credentials` and the scopes
   `read,write,app:assignable,app:mentionable`; nothing is persisted.
3. `soul.md` in the home, and the assistant's agent file shipped in
   `example/` as the strong default — rename both if you choose another name.
4. `aivi projects add <git-url> --linear PEC`. Empty lanes means the listener
   delegates nothing; the assistant still answers pings and delegations.
5. Later, only if a second face in Linear's UI is wanted: another app, its
   `LINEAR_<FACE>_*` secrets, `apps.<face>: {}`, and `linear.primary` naming
   the data-carrying app (required once several apps are configured).

In `aivi.json`: `projects.<id>.linear.teams` (the Linear team ids this
repository works) with `lanes` (empty by default: the listener delegates
nothing until you map a lane; hand delegation always works; `null` marks a
lane humans work). `projectDefaults.linear.lanes` is the company-wide
convention the entries merge over, one lane at a time. A repository may map
several teams to one checkout; a team belongs to one project only.
`aivi projects add <git-url> --linear PEC --lane "Dev:dev" --unlane Triage`
writes the `teams` and lanes itself, resolving the team key you see in
Linear's URLs to its id — or run `aivi projects create`, which shows the
convention and asks only for the lanes it leaves open. The HITL label must
exist in **each** mapped team — labels are per team in Linear.

The agent files: `<home>/.opencode/agents/<agent>.md`, or the repository's
own `.opencode/agents/<agent>.md` to override it per project.

**Reachability.** Linear must reach the listener over HTTPS. `aivi serve`
binds `host.bind:host.port`; put a tunnel or proxy in front (Tailscale
Funnel, cloudflared, a reverse proxy, or run aivi where it is reachable) and
give Linear that public base. Bearer auth does not apply to the webhook
route; the signature is the authentication.

Rejected credentials or a missing variable are a `ConfigurationError` at
start (the host stops and says which); Linear being unreachable leaves the
module `degraded` and retried.

## Not yet

Worktree pruning, permission prompts as `elicitation`, agent plans,
`externalUrls`, graceful agent-first cleanup, the worktree sweep and staged
removals ([linear-worktree-lifecycle](backlog/linear-worktree-lifecycle.md)),
multi-workspace routing: all in
[plans/linear.md](plans/linear.md). Nothing here has run against a real
Linear workspace yet; the live gate is listed there too.
