# Linear

Linear's native agents, run by aivi. One Linear *app* — the **primary** —
receives every webhook: its own **agent session events** and the workspace's
**Issues** data changes, on one route. A person delegates an issue (or
mentions the app), Linear opens an *agent session* — and the ticket is handed
to the host's **orchestrator**, which owns the run: its durable record, the
OpenCode worker session (the lane's agent, in the project checkout), the
worker tools, and which lane a finished ticket belongs in. The Linear module
never learns any of that from the inside: it **follows**. It subscribes to
the orchestrator's typed run events and catches Linear up in its own order —
the result first (Linear's response is what stops the "working" state), then
the move, then taking the delegate back. People who want aivi itself rather
than a worker talk to the **assistant**. This page owns the module's behavior
**as built**; the run contracts it follows live in
[plans/templates/orchestrator.md](plans/templates/orchestrator.md), the
work-pull flow (lanes, queue lanes, pools, leases, the dispatcher) is owned
by [orchestrator.md](orchestrator.md) with its build checklist in
[plans/orchestrator.md](plans/orchestrator.md), and what is still owed here
is in [plans/linear.md](plans/linear.md); configuration fields are in
[configuration](configuration.md#linear).

## Words

| Word | Meaning |
| --- | --- |
| app | One Linear OAuth application acting as an app user (Linear's UI says "agent"); `linear.apps.<id>`. The **primary** carries the data feed and the bare `LINEAR_*` secrets; every other app is a face |
| face | An extra app: a name and icon in Linear's UI, its own credentials (`LINEAR_<APP>_*`) and webhook route, and no meaning for routing at all. An activity is posted with the token of the app the session lives on |
| primary | The one app by default; with faces, `plugins.tracker-linear.primary` names the app that carries the workspace data feed and authorises the Linear MCP. The listener always delegates on the primary, since that is whose token it holds |
| assistant | The OpenCode agent people address directly on Linear (`linear.agent`, default the aivi name): comment mentions. It answers, clarifies or refuses; it does not do work. Delegations it never sees — one nobody can run gets a fixed answer instead |
| delegate | `Issue.delegate`: the app working the issue while the human assignee stays responsible. Its one meaning: *an app is working this issue* |
| agent session | Linear's unit of agent work on an issue; aivi treats each as one conversation, id `<app>:<agent session id>` |
| activity | What flows in a session: aivi emits `thought` (progress, ephemeral), `elicitation` (a worker's question, with its `select` signal when there are options), `response` (the answer, which **ends** the agent session) and `error` (refusals, stops); people's messages arrive as `prompt` activities, a stop request as a `prompt` with `signal: "stop"` |
| lane | One entry of the **core** ordered array `projects.<id>.lanes` — `{ name, agent?, queue?, pool?, worktree?, next?, previous? }`. A lane naming an `agent` is worked; naming none is worked by humans; `queue: true` marks the workflow's one queue lane (owner: [orchestrator.md](orchestrator.md)). Success moves a ticket to the **next** entry, failure to the **previous** one — overridden per lane by `next`/`previous`; a stop moves nothing |
| listener | `linear.listener: true` (the default): aivi delegates an issue that enters a worked lane to the primary and the lane agent works it; off, only what people do in Linear starts a worker |
| follower | What the Linear module is to the orchestrator: it records the pair (agent session ↔ OpenCode session ↔ ticket) in **its own table**, renders run events, posts people's messages into the worker's session itself, and retries **its own** delivery failures at wake and boot. The orchestrator never calls it |
| worker | The run's OpenCode session (`ses_run_…`): the lane's agent, working in the project's checkout — kept for the whole run and left there after a stop for inspection. Git worktrees wait for a forge to give them; the module's worktree helpers stay exported for that day |

## What happens

1. **A person delegates or mentions the app** in an issue. Linear posts an
   `AgentSessionEvent` `created` webhook to
   `POST /linear/webhooks/app/<app>` on the host listener. aivi verifies the
   signature and answers within the 5 seconds Linear allows, then works.
2. **Routing is deterministic code, from the issue re-read.** An archived
   (deleted) ticket gets nothing at all: a session created on it starts no
   worker and no assistant, and gets not even a refusal — there is nothing
   left to do. The HITL label (`linear.humanLabel`, default `needs-human`)
   refuses any agent with one `error` activity. A **delegation whose lane
   names an agent** hands the ticket to the orchestrator and runs that lane's
   agent — the face is the person's choice, never a routing input, and a
   delegation into a worked lane runs the lane agent whatever face was picked.
   A delegation nothing can run — the lane names no agent, the state is no
   lane of the project, or the team maps no project — has the delegation
   un-taken (aivi removes the delegate) and gets one plain fixed answer
   saying why; no agent improvises over a job the config never claimed.
   Anything people send another way — a comment mention above all — lands on
   the **assistant**. The assistant's directory is the project's `source/`
   checkout when the team maps one, the home otherwise; it never gets a
   worktree.
3. **Acknowledgement** within Linear's 10 seconds: an ephemeral `thought`,
   "Starting as `developer` in project website, working in the project
   checkout." A redelivered `created` for a ticket that already has a live
   run (or whose pair the follower already holds) is a no-op, said in the
   log as `run.deduped` and nothing else.
4. **The run.** The follower records the pair **before** asking for the work;
   the orchestrator makes the worker session (the lane's agent, the project's
   checkout as directory, the agent file's model applied) and names it in the
   `started` event, which attaches it to the pair. The worker's first prompt
   is the delegation line, the issue dossier, and the **worker contract**:
   the ticket ends only through `aivi_work_complete`, a person's decision
   only through `aivi_ask`, the checklist through `aivi_plan`, and a turn
   ending without one is treated as a failure.
5. **While it runs.** The `plan` tool's checklist is a forwarding: the whole
   array arrives whenever the worker re-sends it and Linear replaces the
   agent session's plan with it. The `ask` tool creates an OpenCode session
   form — the durable record of the wait — and the `question` event renders
   it as an `elicitation` activity, with the `select` signal when options
   came with it. A progress stream for the worker (ephemeral `thought`s fed
   by the OpenCode event stream while it works) is **not built yet**.
6. **Answers and interjections — the follower posts into the OpenCode
   session itself; the orchestrator is not in this path.** The open form is
   the discriminator, read from OpenCode, never inferred from words. A
   message while a form is `pending` *is* an answer: the text goes in as a
   queued prompt and the form is answered as the record. With nothing open
   the same message **steers** the running turn (ruled 2026-10-01); with no
   turn to steer it queues instead, said in the log, never lost. "Send stop
   request" arrives as `signal: "stop"`: the orchestrator interrupts the
   worker and ends the run cancelled — see 7.
7. **The ending, and the catch-up.** Only a tool call ends a run: the
   completion tool records the outcome and the **target lane** the project's
   lane order chose (success → the **next** entry, failure → the
   **previous**, per-lane `next`/`previous` overrides aside; a stop → none),
   and the orchestrator emits
   `ended`. The follower then pays its ceremony **in this order**: the
   **result** (a success posts the summary as the `response`, which completes
   the agent session and stops the "working" state; a failure posts an `error`
   activity), then the **closing note** — the same text as a comment on the
   **issue** itself, linked to the agent session, so the ending is readable
   without opening the session (ruled 2026-10-02; the session id on the
   ticket is the marker, so retries and boots never post it twice), then the
   **move** (only when the issue is not already there),
   then the **delegate** — un-taken on a success, left sitting on a failure
   so the session stays the readable trail and the next lane change
   re-triggers. Each step asks Linear's real state first (`resultShown`: is
   the agent session ended; is the issue already in the lane), so a
   half-landed ceremony says nothing twice. A step that fails keeps the run
   owed in memory; the next wake tries again, and every boot pass re-derives
   the list from the follower's own pairs and the run records — the outage
   that loses a response heals at the next boot.
8. **One worker per ticket.** The orchestrator's guard: a ticket with a run
   still **active** never gets a second one; whether a delegation after a
   finished run is new work is the follower's routing, not the ledger's.
   There is no per-project lock: workers share the checkout (worktrees
   isolate them once a forge is wired), and capacity arrives with the
   dispatcher. The listener does not delegate an issue that is blocked by
   unfinished issues (Linear's native blocking).
9. **Issue changes** (the **Issues** data-change category, on the primary's
   route). When an issue with a **live run** gains the HITL label, moves to a
   lane that names another agent (or no agent), or loses the app as delegate,
   the orchestrator interrupts the worker and ends the run cancelled; the
   ending's catch-up says the reason as an `error` activity — and a stop
   moves nothing, because the person who stopped it left the ticket where
   they wanted it. A lane change between two lanes naming the same agent
   changes nothing. With the listener on, an issue entering a worked lane
   with no delegate, no HITL label and no live run is delegated to the
   primary (`issueUpdate` with the primary as delegate): becoming the
   delegate makes Linear create the agent session itself, and this mutation's
   own answer names it (live, 2026-09-26). The run starts from that answer;
   a `created` webhook arriving for that session afterwards is a redelivery
   the pair answers. An answer that names no session undoes the delegation
   and logs `listener.no-session` at error — the delivery was acknowledged,
   so no retry would ever come. The issue is re-read from the API for every
   such change, so label and state names are current, and a change delivered
   twice finds the delegate already set.

One route shape: `POST /linear/webhooks/app/<id>`, verified by that app's
signing secret. The primary's route carries both families — its own agent
session events and the workspace's Issues data changes. A data change
delivered to a face's route is a misroute: acknowledged, dropped, logged per
`linear.logMisroutes` (default `true`) at warn, `false` at debug only.

## When it does not end with an answer

A **worker** ends through the orchestrator's states, and each ending is
visible: a completion or failure moves the ticket and posts its activity
(7); a premature turn end earns bounded nudges and then fails visibly; a
run still `preparing` when aivi died fails at boot saying so. A stopped
worker's OpenCode session stays for inspection.

An **assistant** conversation turn (the channel machinery,
[channels](channels.md)) keeps these rules:

| Situation | What Linear sees | State |
| --- | --- | --- |
| Stop request, host shutdown | one `error`: stopped; the OpenCode session kept | turn discarded with the reason; capacity released |
| OpenCode unreachable before the prompt | one `error`: nothing started, try again | turn discarded, capacity released |
| Turn longer than `linear.turnTimeoutMs` or an unverifiable failure | one `error`: an operator has been notified, the issue waits | `blocked`; `aivi linear resolve ID --reason … --confirm-stopped` after inspecting the OpenCode session |
| aivi restarted mid-turn | one `error`: restarted while working, operator must resolve | `blocked` (nobody knows whether the agent stopped) |

`aivi linear status` lists the assistant conversations and what each is
doing; worker lines join this view when the status command is formalized
with the extraction. Worktree pruning is not built yet.

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
what a home's `opencode.jsonc` gains when the `plugins.tracker-linear` block names `mcp`; see
the comment setup seeds). The MCP lives and dies with `serve`, like the
webhooks and the workers it serves.

## Setup

One app in Linear — the 95% case. **aivi must already be running** (a
foreground `aivi serve` or the service): the installer probes it once up
front and stops with a clear message if it is not answering `GET /health`,
because the throwaway-ticket test can only observe webhooks a live host is
recording.

1. **One app.** `aivi add linear` walks you through creating, installing
   and proving the app and writes the secrets and config itself, testing the
   webhook with a throwaway ticket first. The Linear-side part it guides: open
   `https://linear.app/settings/api/applications/new`; name the app
   `identity.name` (the persona; aivi cannot set the name — use the name from
   config here); tick Client credentials and Webhooks; register the callback
   URL it prints as the Redirect URI; set the Webhook URL to
   `<host.public>/linear/webhooks/app/<app id>`; tick Issues under Data change
   events and Agent session events under App events; press Create. Then open
   the install link once and allow it — an app receives webhooks only after
   it is installed into the workspace (live, 2026-09-26), and the installer's
   callback listener catches that round too. Then the test, before anything
   is written: a throwaway ticket, and two waits that run one after the
   other — `webhooks`, that Linear posts the ticket's creation to this URL,
   then `agent events`, that delegating the ticket creates an agent session
   whose created event arrives the same way. Each wait shows one live line
   that says what just lands and closes with clack's own marks — a hollow
   green diamond for passed, a red square for failed; the ticket
   is archived when the test ends. The install ends with one line saying
   what is true and that restarting aivi loads Linear — with the service
   installed, the CLI restarts it and reports that as it happens.
2. In `<home>/.env`: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and
   `LINEAR_WEBHOOK_SECRET` — the bare names are the one app, whose
   credentials also authorise the Linear MCP. Tokens are requested with
   `grant_type=client_credentials` and the scopes
   `read,write,app:assignable,app:mentionable`; nothing is persisted.
3. `soul.md` in the home, and the assistant's agent file shipped in
   `packages/cli/templates/agents/` as the strong default — rename both if you choose another name.
4. `aivi projects add` — it runs Linear's project-setup step (the plugin's
   `./setupProject`), which asks which teams may work the project, then
   offers the project's OpenCode agents as a pick-list for each lane (with
   `-- None --` for a lane humans work, and "does work in this lane write
   files?" — yes writes `worktree: true` — asked only of worked lanes and
   only when a forge is configured). The lanes land in the **core** ordered
   array `projects.<id>.lanes`, in board order (type group, then position);
   **closed states (Done, Canceled, Duplicate) are never written** — the
   tracker recognizes them by type, and a run ending in the last configured
   lane moves nowhere: a person closes the ticket. No lanes means nothing is
   picked up for the project and its tickets are silent; the assistant still
   answers pings. A hand delegation a lane cannot run gets the fixed answer,
   not the assistant. With no forge installed the project is repo-less
   (memory and knowledge, no checkout).
5. Later, only if a second face in Linear's UI is wanted: another app, its
   `LINEAR_<FACE>_*` secrets, `apps.<face>: {}`, and `primary` naming
   the data-carrying app (required once several apps are configured).

In `config.json`: `projects.<id>.tracker-linear.teams` — the Linear team ids
this repository works (several teams may map one checkout; a team belongs to
one project only) — and nothing else of the workflow: the lanes are core's
(`projects.<id>.lanes`, ordered; the array **is** the workflow). The HITL
label must exist in **each** mapped team — labels are per team in Linear.
`aivi projects add` writes the `teams` and the lanes itself, resolving the
team key you see in Linear's URLs to its id.

The agent files: `<home>/.opencode/agents/<agent>.md`, or the repository's
own `.opencode/agents/<agent>.md` to override it per project.

**Reachability.** Linear must reach the listener over HTTPS: store the address behind your funnel or tunnel as
[`host.public`](configuration.md) — `aivi setup` asks for it and `aivi status` shows it — and print that plus
`/linear/webhooks/app/<app id>` into Linear's dashboard. Bearer auth does not apply to the webhook
route; the signature is the authentication.

Rejected credentials or a missing variable are a `ConfigurationError` at
start (the host stops and says which); Linear being unreachable leaves the
module `degraded` and retried.

## Not yet

Progress `thought`s while a worker runs (the session observer), worker lines
in `aivi linear status`, the elicitation keep-alive timeout, worktree wiring
once a forge gives them and the worktree sweep
([linear-worktree-lifecycle](backlog/linear-worktree-lifecycle.md)),
permission prompts as `elicitation`, `externalUrls`, graceful agent-first
cleanup, multi-workspace routing: all in
[plans/linear.md](plans/linear.md). The installer and the delegate-first
listener ran against a real Linear workspace (2026-09-26); the remaining live
gates are listed there.
