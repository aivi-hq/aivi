# Linear

Linear's native agents, run by aivi. One Linear *app* — the **primary** —
receives every webhook: its own **agent session events** and the workspace's
**Issues** data changes, on one route. The host's **orchestrator** owns a
run: its durable record, the OpenCode worker session (the lane's agent, in
the project checkout), the worker tools, and which lane a finished ticket
belongs in. The Linear module answers for what happens **on Linear** at each
stage (the interface lives in [orchestrator.md](orchestrator.md#the-trackers-stages)):
`initWork` delegates the ticket to the primary — Linear's own answer carries
the *agent session* and serves as the ticket's summary; `ready` joins the
worker's session to that pair; `question` and `plan` render as they arrive;
`endWork` says the closing words in the platform's own order — the result
first, because Linear's response is what stops the "working" state — and
only then does the orchestrator move the ticket and return the lease. People
who want aivi itself rather than a worker talk to the **assistant** — and a
hand *delegation* is neither: it gets one fixed refusal. This page owns the
module's behavior **as built**; the run contracts live in
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
| primary | The one app by default; with faces, `plugins.tracker-linear.primary` names the app that carries the workspace data feed and authorises the Linear MCP. `initWork` always delegates on the primary, since that is whose token it holds |
| assistant | The OpenCode agent people address directly on Linear (`linear.agent`, default the aivi name): comment mentions. It answers, clarifies or refuses; it does not do work. Hand delegations it never sees — every one gets the fixed refusal instead (ruled 2026-10-02) |
| delegate | `Issue.delegate`: the app working the issue while the human assignee stays responsible. Its one meaning: *an app is working this issue* |
| agent session | Linear's unit of agent work on an issue; aivi treats each as one conversation, id `<app>:<agent session id>` |
| activity | What flows in a session: aivi emits `thought` (progress, ephemeral), `elicitation` (a worker's question, with its `select` signal when there are options), `response` (the answer, which **ends** the agent session) and `error` (refusals, stops); people's messages arrive as `prompt` activities, a stop request as a `prompt` with `signal: "stop"` |
| lane | One entry of the **core** ordered array `projects.<id>.lanes` — `{ name, agent?, queue?, pool?, worktree?, next?, previous? }`. A lane naming an `agent` is worked; naming none is worked by humans; `queue: true` marks the workflow's one queue lane (owner: [orchestrator.md](orchestrator.md)). Success moves a ticket to the **next** entry, failure to the **previous** one — overridden per lane by `next`/`previous`; a stop moves nothing |
| tracker | What the Linear module is to the orchestrator: ONE `Tracker` (`@aivi/plugin`) — the board the eligibility walk reads (`projects`, `tickets`, `moveTo`, idempotent) and the stages every run walks through (`initWork`, `ready`, `question`, `plan`, `endWork`). It records the pair (agent session ↔ OpenCode session ↔ ticket) in **its own table**, posts people's messages into the worker's session itself, and retries **its own** closings at wake and boot. The orchestrator never learns what Linear is |
| worker | The run's OpenCode session (`ses_run_…`): the lane's agent, working in the project's checkout — kept for the whole run and left there after a stop for inspection. Git worktrees wait for a forge to give them; the module's worktree helpers stay exported for that day |

## What happens

1. **Work enters through the walk, the only door** (ruled 2026-10-02): the
   orchestrator's eligibility pass takes a ticket from a worked lane, and the
   module's `initWork` delegates it to the primary (`issueUpdate` with the
   primary as delegate). Becoming the delegate makes Linear create the agent
   session itself, and this mutation's own answer names it (live, 2026-09-26)
   — nothing opens a session by hand. The walk's read leaves out what Linear
   reserves for people: archived tickets, the human label, and **tickets that
   already have a delegate** (ruled 2026-10-02: a delegated ticket is not
   eligible — re-delegating to the user it already has is a mutation no-op
   and Linear makes no session for it; that silence was seven failed runs).
   When a run dies before its session exists there is no conversation to
   speak in, so `Platform.notify` leaves a **plain comment on the ticket
   itself** before the run fails — visible, never silence. The pair is recorded **before** anything
   can arrive, "preparing the workspace" is the new session's first word (an
   ephemeral `thought`), and the ticket's dossier — what it is, what it says —
   is what `initWork` returns as the **summary**. A lane move people make is a
   wake and nothing more: the walk reads the board afresh.
2. **Webhooks route deterministically, from the issue re-read.** A `created`
   for a session `initWork` itself opened — the pair recorded, or the ticket's
   run already live — is a redelivery: folded into the run, said in the log as
   `run.deduped` and nothing else. An archived (deleted) ticket gets nothing at
   all: not even a refusal — there is nothing left to do. The HITL label
   (`linear.humanLabel`, default `needs-human`) refuses any agent with one
   `error` activity. A **hand delegation** — the app named to work an issue
   when no run of ours opened that session — gets one fixed refusal whatever
   lane the ticket sits in (ruled 2026-10-02, P11): *work reaches me through
   the board, not through a delegation*; aivi removes itself as delegate, and
   no agent improvises over a job the config never claimed. Anything people
   send another way — a comment mention above all — lands on the
   **assistant**. The assistant's directory is the project's `source/`
   checkout when the team maps one, the home otherwise; it never gets a
   worktree.
3. **The acknowledgement** of a webhook answers within the 5 seconds Linear
   allows; the walk's own first word inside a new agent session is the
   `thought` "Preparing the workspace…".
4. **The run.** The orchestrator makes the worker session (the lane's agent,
   the project's checkout as directory, the agent file's model applied) and
   the `ready` stage attaches that session to the pair `initWork` opened. The
   worker's first prompt is the **orchestrator's composition** (ruled
   2026-10-02): a neutral line naming the project, the lane and the checkout,
   the ticket's summary as `initWork` returned it, and the **worker contract**:
   the ticket ends only through `aivi_work_complete`, a person's decision
   only through `aivi_ask`, the checklist through `aivi_plan`, and a turn
   ending without one is treated as a failure. `aivi_pr` belongs to no
   turn-ending: it is the worker's word that the branch is ready, and the
   forge — the project's own, if it has one — pushes as its app and opens
   the pull request (the worker's git stays local; the `git push` deny in
   the worker's agent file is the operator's own, never aivi's). `startWork` the module says
   nothing for: Linear watches its own agent sessions, and a working session
   shows itself.
5. **While it runs.** The worker's **progress stream** is live (built
   2026-10-02, ruled "thoughts and action types, ephemeral"): from `ready`
   the module follows the run's OpenCode session with the host's own progress
   reducer and mirrors it into the agent session as **ephemeral** activities —
   an `action` naming the tool being run (with its short detail), a `thought`
   for the status line (thinking, writing, the elapsed suffix, the idle
   notice). Ephemeral is Linear's word for *replaced*: the person sees the
   worker's current moment, never a trail of lines. The stream pauses while
   an elicitation awaits a person and resumes when the answer lands;
   `endWork` falls silent before the closing, so the closing is the last
   word. `linear.progress` (`silent`/`status`/`tools`, default `tools`)
   decides what it shows. The `plan` tool's checklist is a forwarding: the
   whole array arrives whenever the worker re-sends it and the `plan` stage
   has Linear replace the agent session's plan with it. The `ask` tool
   creates an OpenCode session form — the durable record of the wait — and
   the `question` stage renders it as an `elicitation` activity in the
   session `initWork` opened, with the `select` signal when options came
   with it.
6. **Answers and interjections — the tracker posts into the OpenCode
   session itself.** The open form is
   the discriminator, read from OpenCode, never inferred from words. A
   message while a form is `pending` *is* an answer: it goes to the
   orchestrator's `answer`, which owns the delivery — the slot may have been
   given back while the person thought, and a full pool **reacquires** it
   before the same session resumes — the text goes in as a queued prompt and
   the form is answered as the record. With nothing open
   the same message **steers** the running turn (ruled 2026-10-01); with no
   turn to steer it queues instead, said in the log, never lost. "Send stop
   request" arrives as `signal: "stop"`: the orchestrator interrupts the
   worker and ends the run cancelled — see 7.
7. **The ending.** Only a tool call ends a run: the completion tool records
   the outcome and the **target lane** the project's lane order chose
   (success → the **next** entry, failure → the **previous**, per-lane
   `next`/`previous` overrides aside; a stop → none). The order from there is
   the operator's (ruled 2026-10-02, P7): first the `endWork` stage — the
   tracker speaks **in this order**: the **result** (a success posts the
   summary as the `response`, which completes the agent session and stops the
   "working" state; a failure, and a cancellation, post an `error` activity),
   then the **closing note** — the same text as a comment on the **issue**
   itself, linked to the agent session, so the ending is readable without
   opening the session (the session id on the ticket is the marker, so retries
   and boots never post it twice), then the **delegate** — released by
   **every** ending (ruled 2026-10-02, composed with the eligibility rule):
   the delegate means *an app is working this issue*, and a finished run
   works it no more; leaving it sitting on a failure would blacklist the
   ticket from the walk. The agent session stays on the ticket as the
   readable trail either way. Each step asks Linear's real state first (`resultShown`: is the
   agent session ended), so a half-landed closing says nothing twice. **Then**
   the orchestrator asks the board where the ticket sits (`ticketLane`,
   ruled 2026-10-02: the missed-webhook backstop): if a person moved it out
   from under the run — anywhere but where the run worked or the target —
   **their move wins**, the owed move is spent and the log says so; the
   move only lands through the board's idempotent `moveTo` when the ticket
   is still where the run left it. **Lastly** the lease returns.
   A closing that fails does **not** hold the ticket: the person is told the
   moment it fails — the human label rides the ticket and the session says
   why — the move lands and the slot comes back anyway, and the closing stays
   owed to the next wake and the next boot (the label stands until a person
   removes it). And when the dispatcher gives up on killing a stubborn worker
   (`dispatcher.killAttempts`, `kill-unconfirmed`), the ticket carries the
   human label and says plainly that a worker may still be loose.
8. **One worker per ticket.** The orchestrator's guard: a ticket with a run
   still **active** never gets a second one. An ending **releases**: a ticket
   still sitting in a worked lane after its run is fresh work again — the
   walk starts it anew, and only a person's move or the human label says
   otherwise (a stop remembers nothing, ruled 2026-10-02). There is no
   per-project lock: workers share the checkout (worktrees isolate them once
   a forge is wired), and capacity arrives with the dispatcher. The walk does
   not pick up an issue blocked by unfinished issues (Linear's native
   blocking).
9. **Issue changes** (the **Issues** data-change category, on the primary's
   route). When an issue with a **live run** gains the HITL label, moves to a
   lane that names another agent (or no agent), loses the app as delegate,
   **or is deleted** (Linear's archive arrives as an `archive` change; ruled
   2026-10-02: the webhook is the trigger to end the job gracefully),
   the orchestrator interrupts the worker and ends the run cancelled; the
   `endWork` stage says the reason as an `error` activity — and a stop moves
   nothing, because the person who stopped it left the ticket where they
   wanted it. A lane change between two lanes naming the same agent changes
   nothing. Every other lane or label change is a **wake and nothing more**
   (ruled 2026-10-02, P6): it cancels a waiting request for that ticket,
   wakes the walk, and the walk reads the board afresh — a person's move on
   a queued ticket is cancel-on-move, the mechanism that replaced the
   fulfilment re-check. The issue is re-read from the API for every such
   change, so label and state names are current.

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
   lane moves nowhere: a person closes the ticket. After **all** lanes are
   configured comes the queue: **one** question (ruled 2026-10-02, never a
   per-lane ask) — which lane waits with work while the working lanes are
   full, `-- None --` included. Its options are only the lanes that could
   legally hold the queue — a lane whose next works nobody is no option, and
   the last lane feeds nothing — and **a lane that names an agent is never an
   option** (ruled 2026-10-02, P4): the queue is where people wait for a
   worker, never a working lane itself. No lanes means nothing is picked up
   for the project and its tickets are silent; the assistant still answers
   pings. A hand delegation always gets the fixed refusal, never the
   assistant. With no forge installed the project is repo-less
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
