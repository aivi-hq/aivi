# The ticket orchestrator

Status: **built** (2026-10-01, the follower design ruled with the operator;
crystallized 2026-09-29, revised 2026-09-30, both with the operator). Part of
the [templates program](index.md). The 2026-09-30 revision reworks completion
and questions after studying a worked agent-workflow example and the Linear
and OpenCode 2 documentation first-hand; the 2026-10-01 revision moves
**delivery out of the core entirely** — the orchestrator emits typed run
events and cannot know a tracker exists; trackers follow. **Superseded
2026-10-02 (the stage rulings, with the operator):** the events are dead —
a tracker answers **stages** (`initWork`, `ready`, `startWork`, `question`,
`plan`, `endWork`) on one `Tracker` interface, the orchestrator composes the
worker's first prompt, and the ending order is closing words → move → lease.
The built contract is [orchestrator.md](../orchestrator.md#the-trackers-stages);
"run events" and "subscribes" below are the superseded wording, marked where
they carried weight. Superseded rulings are marked where they stood. Sequence: forge-github first, then tracker
extraction, then this extraction; the extraction landed on the base flow and
the forge steps stay ahead.
Parent: [index.md](index.md).

## What it is

Everything the Linear module does today except speaking Linear: lane matching,
the delegate guards, worktree lifecycle, capacity and dispatch, the worker
completion contract, and the needs-human fact. Extracted into host-shipped
machinery that is inert until a tracker follows its events. Linear becomes the
first follower; GitHub Issues and Jira are future adapters spelling the same
vocabulary differently.

**Glue, not a ticket-machine** (ruled 2026-09-29; the name is still up
for grabs). The orchestrator orchestrates *everything*: the seam between
tracker, forge, channels, and mail. A ticket need not touch a repository
at all — "research X, make a PDF, email it" — so the forge steps are a
**configurable path**, entered only when the ticket's project has a
forge, never a hardcoded route every worker walks
([forge-github.md](../forge-github.md)). The extraction is **seeded on
the base flow** (ruled 2026-09-29): tracker → conversational agent →
tracker update, which `worktree: false` lanes already are — forge steps
come on top, later. Most assistant work in tickets is skills, tools and
MCPs on an agent (email included, ruled not a new capability); the
forge is the exception that earns core ceremony because of the worktree
apparatus it carries.

## The adapter seam

An adapter is a translator in both directions and nothing else. The
direction that matters (ruled 2026-09-30): **the tracker sends the
orchestrator commands and receives normalized run events** — it never
starts a worker, and the orchestrator never reads a raw webhook.

- `laneStates(team)` — lane name → the platform's real workflow states, so a
  proposed mapping can be validated against what exists.
- `createStates(missing)` — optional; opt-in with an explicit yes per team,
  never silent.
- `candidates(lane)` — ready issues in a lane, in the platform's own order,
  each with the facts needed to build a worker's first message.
- `transition(ticket, lane)` / labels / comments — the orchestrator's neutral
  words for the ticket mutations; the adapter spells them in the platform's
  dialect: Linear `Cancelled`, GitHub `Closed`, Jira Done-with-reason.
- `events` — normalized signals: issue entered lane, label changed, delegate
  changed. Everything downstream keys off these, never off raw webhooks.
- stage calls out (ruled 2026-10-02, superseding run events), tracker-side
  realization in: each tracker renders the run's story in its own vocabulary
  (Linear's agent-session activities; a result comment elsewhere). The
  renders are fire-and-forget; the lifecycle stages are awaited — see
  The completion contract.

**Built 2026-09-29** as the `@aivi/plugin/tracker` subpath, seeded from what
the running Linear module actually asks: `issue`, `laneStates`, `assign`,
`unassign`, `startSession`, `comment` in four neutral kinds, `idFor`/`parts`,
and `events` carrying `started`/`prompted`/`updated`. **Revised 2026-09-30:**
`started`/`prompted` are Linear's agent-session shapes, not the neutral
vocabulary. **Built 2026-10-01 as the follower design:** *(superseded
2026-10-02: no events, no subscribing — the machinery calls the
`Tracker`'s stages and awaits the lifecycle ones)*; a person's message into a
worker's session is posted by the tracker straight into the OpenCode session
(an answer through the open form, a steer otherwise), never routed through
the orchestrator. `createStates`, `candidates` and the pull-shaped questions are
implemented with the dispatcher, when the machinery starts asking them.

Deliberately **not** on the adapter: weights, ordering, capacity, worktrees,
the completion contract. GitHub-as-ticket-system is its own adapter plugin;
GitHub-as-repo-host (branches, PRs, review feedback) is separate plumbing —
the forge, `@aivi/plugin/forge` — and it lands **before** this extraction,
because review facts are gathered from the forge at wake (below).

**Capabilities: what the orchestrator asks; delivery: what the tracker
decides** (ruled 2026-09-29). The seam must not turn everything a tracker
does into a capability. Capabilities are the **facts the orchestrator needs
and cannot compute**, each with a fallback chain for trackers that lack it.
Worked example, the branch name: `project.branchNameStrategy` (config) → the
tracker's reported branch name (Linear: `Issue.branchName`) → `feat/<ticket>`
with a counter on conflict. Candidate list, provisional and deliberately
small: branch name; whether a PR exists and where (Linear can say; others
need the forge to answer by branch). Everything else earns its way onto the
list when a second tracker needs it.

The seam's home: the contracts plugins code against are the content of the
`@aivi/plugin/tracker` and `@aivi/plugin/forge` subpaths (D6: subpath
before package; the kinds get their first content from these extractions).
The machinery itself ships **in the host** — confirmed 2026-09-29: the host
is the core, and no install has the host without it — in one clean
directory; a name is open. The tracker plugin is enabled the registry
way — listed in `aivi-plugins` (D9) — and at module start it **registers its
`Tracker`** with the orchestrator; the orchestrator itself has no list entry:
there is nothing to disable until a tracker is installed, because an
unwired orchestrator does nothing.

## Lanes, priority and capacity — owned elsewhere

[../../orchestrator.md](../orchestrator.md) owns lanes, priority, queue
lanes, pools, leases and the dispatcher (ruled 2026-10-02). What this
document keeps is the **follower-side contract**: the adapter seam, the
completion contract, the question contract, recovery and the worker
lifecycle below. Two rulings here were superseded by it and are marked as
such wherever they appear: the lane overrides are **`next` and `previous`**
(the old `complete`/`return` names die with the dispatcher build), and
capacity becomes **dispatcher pools** (the old single pool size was the
follower-era stand-in; the built ledger deliberately holds no capacity
state).

## Worker lifecycle

- **Always a fresh session**: "here's a summary, go do work." Never a restored
  agent session. A **restored worktree** is a different thing: worktrees are
  **keyed by branch** (ruled 2026-09-29, superseding today's
  `<agent session>` directory naming), and before a worker starts on a
  restored worktree the orchestrator brings it up to date with the forge —
  recovery is an update, not a new checkout. **Built 2026-10-01: no worktrees
  are wired yet** — every worker works in the project checkout (the lane's
  `worktree` flag waits for a forge to give them).
- The orchestrator calls the worker with the ticket summary, the branch, and
  the worktree ready (or restored).
- Guards before spawning, all of them today's listener rules: lane mapped, no
  active delegate, no needs-human marker, not natively blocked.
- **The worker never chats with a human live** (ruled 2026-09-29; the
  mechanism revised 2026-09-30, see The question contract). The 2026-09-29
  ruling rejected resuming the asking session on an answer webhook because
  the orchestrator cannot know a trigger is an answer. **Resolved
  2026-09-30:** the open form is the discriminator — a human message while a
  form is pending *is* an answer, deterministically. Guessing is gone because
  the record makes it a lookup. (Capacity language — the parked run
  reacquiring a slot — waits for the dispatcher.)
- Reviews go through **the forge, not the ticket platform**: comments are
  left and answered on the PR, so a ticket's history in Linear stays
  decisions-and-why.

## The completion contract (ruled 2026-09-30)

The 2026-09-29 exit contract — schema-at-start instruction, validated
closing message, re-ask, `{outcome, comment}` report — is **superseded**.
Parsing a closing message asks an LLM's prose to be a fact; that was the
whole "is it done or did Linear just interject?" problem, and the assessor
idea (a second LLM judging the first) was its symptom, not its fix. The
assessor is deleted.

**Completion is a tool call.** Every worker, with a forge or without
one, gets exactly three tools, registered once by the host:

- `work_complete { outcome: "success" | "failure", summary }` — the worker
  saying *I truly am done*. The outcome changes the ticket's fate: success
  moves the ticket to the **next** lane, failure to the **previous** one —
  neighbours by default, overridden per lane by `next` and `previous`
  (vocabulary owned by [../../orchestrator.md](../orchestrator.md)).
- `ask { question, options? }` — see The question contract.
- `plan { steps: [{ content, status }] }` — the worker's checklist, posted
  before it starts and re-sent whole whenever a step changes. A
  **forwarding**, not a ceremony: the orchestrator hands it to the tracker
  and moves on; Linear replaces the agent session's plan (its API takes the
  full array every time), a tracker without a plan surface drops it.
  Nothing about a run waits on its delivery, and no run state turns on it.

A turn ending is never completion. Text is never completion. Runtime
idleness is never completion. Only the call is, and the call is recorded
durable before anything else happens — a model cannot narrate its way to
`done`, and nobody has to guess whether a reply was mid-work steering or a
final answer.

- **Turn ended, no tool called, no form open**: the orchestrator sends a
  bounded number of synthetic nudges — *use the ask tool with your question,
  or call work_complete when done* — queued into the session. Whether a
  question is open is **read from OpenCode** (`form.list` answers with the
  pending ones only, verified live 2026-10-01), never mirrored in the ledger.
  Budget spent: the run fails visibly — failure treatment below. Never
  silence.
- **Completion calls the tracker, once, and awaits.** *(Revised 2026-10-02:
  one `endWork` stage, awaited, replaces the emitted `ended` and its
  listeners — still no listener list, still no knowing who answers.)* The
  ceremony inside `endWork` is the tracker's, in its own order — Linear's is
  the **result**, then the **closing note** on the ticket (the result is
  what the human waits for — Linear's
  response completes the agent session and stops the "working" state; a moved
  ticket without an answer explains nothing). **The move is not in the
  ceremony** (ruled 2026-10-02, P7): after `endWork` returns the orchestrator
  performs the move through the board's idempotent `moveTo`, and the lease
  returns last; a failed closing marks the ticket for a human and never
  holds the ticket or the slot. The tracker renders the result
  in its own vocabulary: Linear emits the `response` activity, which
  completes the agent session automatically (verified in Linear's docs), and
  clears the delegate explicitly, which Linear does not do for us; GitHub
  Issues would post a result comment. Core never sees a ceremony, and a
  tracker that has no session to complete is not asked to fake one.
- **Failure treatment**: the needs-human marker + a comment naming what
  failed, in whatever vocabulary the tracker owns; Linear's is an `error`
  activity in the session (the marker itself is not put there by the
  follower: a person or a triage agent applies it). The session stays
  readable for the operator, and
  **the delegate stays**. *(The old "the next lane change re-triggers" motive
  died with the listener, 2026-10-02: lane changes are wakes now.)* A **stop**
  is not a failure: it moves nothing and says so.
- Declaration and realization can diverge (the tool call lands, the Linear
  API is down): the declaration is durable first — the **run row**, which
  holds the outcome and the target lane; the ceremony is the **follower's**
  own owed list, retried on the next wake and re-derived at boot from its own
  pairs. Each step asks the platform's real state before acting (`resultShown`,
  the issue's current state), so a half-landed ceremony says nothing twice.
  An outage delays the bow, never the fact. **Superseded 2026-10-01:** "the
  row is its own outbox" — delivery is not a column in the orchestrator's
  record; it is the follower's business.

## The question contract (ruled 2026-09-30)

`ask` creates an **OpenCode session form** — the host verified `form.create/
get/list/reply/cancel` and `form.created`/`form.replied` exist in the pinned
client, with durable state `pending / answered / cancelled` and typed fields.
That record is the answer to "we need to persist, somewhere, that it is
awaiting input": we do not invent it, it is a server-side row.

- `ask` **records and returns** — it does not block for the answer. The
  worker ends its turn; the run's state **does not change** (built 2026-10-01:
  `awaiting_input` is no ledger column — the form is the truth of the wait,
  read from OpenCode when a turn ends). A blocking tool would hold the turn
  and the slot open for hours or days and die on restart; the form row
  outlives all of it. OpenCode's `session.background` is not needed for this
  and stays unused until something proves it earns a place. The
  `awaiting_input` state returns with the later refactor that puts a
  keep-alive timeout on an open elicitation; capacity language arrives with
  the dispatcher.
- **The orchestrator sees the question and does nothing.** The question
  handler is a **required tracker method — every tracker implements it**;
  that is part of what makes a tracker a tracker, and it is why this shape
  works. There is no orchestrator-side default (no comment, no label of
  its own choosing) and therefore no state where a question waits
  unhandled. Linear presents in the agent session (an `elicitation`
  activity, its `select`/`auth` signals for structured answers); Jira
  flags; GitHub Issues comments. The orchestrator's entire part: create the
  form, call the `question` stage, and read the open form back from OpenCode
  at turn end. Wait.
- **The tracker is the place that decides what needs-human looks like on
  its platform** (a Linear label, a Jira flag) **and how incoming human
  requests route** — answer-to-open-form versus interjection. The
  orchestrator is not in the message path at all (ruled 2026-10-01): the
  follower posts into the OpenCode session itself.
- **Two kinds of human input, one discriminator.** *Interjection*: anyone
  may push input into a live session at any time; it **steers** (ruled
  2026-10-01, superseding the queue default): the message lands between
  turns and steers what comes next (OpenCode's inbox carries it; delivery
  `steer`), with no turn to steer the same message queues instead — said in
  the log, never lost. *Answer*: with a form `pending`, the same incoming
  message routes to `form.reply` instead — and the text travels into the
  session as a queued prompt too, at-least-once, because a lost answer is
  worse than a repeated one. The discriminator is the open form — a lookup,
  never an inference.
- **The mapping is stored — by the follower**: the platform's session ↔
  OpenCode session ↔ ticket pair is a durable record in the **tracker's own
  namespaced table**, written by `initWork` before the work is requested and
  attached by the `ready` stage when the worker's session exists. The orchestrator's row knows ticket
  ↔ OpenCode session and never a tracker's conversation: a conversation is
  not an orchestrator fact. Every routing decision after a restart reads the
  pair, not memory.

## Recovery (ruled 2026-09-30; follower pass ruled 2026-10-01)

- **OpenCode 2 resumes live turns across a restart** — observed by the
  operator every time. The orchestrator's boot pass expects running runs and
  re-attaches its watching, not treats them as dead or restarts them; a run
  still `preparing` has no session to resume and **fails visibly**.
- **Linear does not retry failed webhooks** (verified live). So the boot
  pass **rebuilds by fetching state** — the follower's own pass over its own
  pairs: for every pair whose run record says terminal, catch the platform
  up. Each step asks the platform's real state first (is the agent session
  ended? is the issue where the move puts it?), so a catch-up that already
  happened says nothing twice. A webhook is only a note saying *look again*;
  the fetch is the truth, so a lost or duplicated note can neither block nor
  double-run anything.
- Both restart orders recover: the question arrived then we restarted — the
  form is still `pending`, and an answer routes through the same
  form-discriminator when it comes. The human answered while we were down —
  the webhook is lost and the form stays `pending`; rebuilding a missed
  answer from the platform's activity list is **not built** (the boot pass
  catches ended runs up, and a person can simply say it again).

## The workflow it drives

The operator's walkthrough, as understood:

- **Triage**: any ticket entering Triage (by a human, or by a worker's
  escape hatch — out-of-scope work spotted mid-flight) triggers the Product
  agent. It uses knowledge tools to make sense of the ticket and one of three
  exits: won't-fix with a good reason; refined and certain (it rewrites the
  ticket body, exits, the orchestrator moves it to Backlog); or unclear (the
  `ask` tool; the marker and a comment name the questions that must be
  answered to retry). 99% of early triage will be the interactive form while
  ADRs accumulate.
- **Backlog is a human lane on purpose.** Nothing happens when a refined
  ticket lands there, until a human moves it to Todo. A configurable
  `autonomous`-style label may skip straight to Todo for obvious work
  (dependency bumps).
- **Todo is the queue lane**; the top ready ticket gets delegated to the Dev
  lane on freed capacity.
- **Dev** exits with a PR on GitHub and a move to Review, or back to Todo
  with the marker and a comment (error, missing info, needs secrets).
- **Review** wakes a fresh review agent (a separate agent by default, though
  it is configurable to the dev agent) in the restored worktree. It owns the
  PR conversation. Back to Todo with review comments, or on to Release.
- **Release** is a human lane.

## Interactive mode

A human opens OpenCode on their own machine, picks the `product` agent, and
says "let's pick up ABC-123". The agent fetches and discusses the ticket
through a **ticket subagent** (a real OpenCode subagent, not bare MCP tools:
the Linear MCP is massive, and a subagent keeps that context out of the
conversation and answers immediately from prefill caches). No worktrees, no
aivi machinery — a normal session. Consequence for templates: **the same agent
file must work aivi-driven (worktree, branch, ticket handed in) and
human-driven (own checkout, no context handed in)**.

The escape hatch works the same way: workers create out-of-scope tickets into
Triage through the ticket subagent, so they need no platform tools — the
operator decides per agent file who gets which subagent. Ticket subagents may
ship as optional "adapter agent" files inside the platform plugins.

## Later, deliberately

- GitHub Issues and Jira adapters (the seam must prove they fit; GitHub
  Projects for lanes).
- A second repo host, if ever (nothing here should foreclose it).
- Carving the orchestrator into an installable unit, if shipping it always
  turns out to cost real weight.

## Open questions

- **Resolved 2026-09-29 — what wakes review when PR comments arrive:**
  nothing does, and nothing needs to. The tracker leads and holds the
  working state: the reviewer finishes by moving the ticket (back to Dev),
  and the lane webhook wakes the next worker. Review feedback is not a
  wake signal — it is a fact gathered **from the forge** as part of
  collecting everything before a worker wakes (Linear helps: telling us a
  PR exists is one of its reported capabilities).
- **Resolved 2026-09-30 — does Linear retry failed webhooks:** no (verified
  live); the boot pass fetches state instead. **Does a `response` activity
  complete the agent session:** yes (Linear's docs). **Does completing clear
  the ticket's delegate:** probably no — the orchestrator clears it
  explicitly; verify live.
- The name of the machinery itself (host directory, vocabulary).
- The capabilities list, by design, grows with each tracker added — every
  entry needs its fallback chain spelled out before a second tracker
  ships.
- The `autonomous` label's real name, and whether the skip is lane-config or
  label-config.
- The exact name of the optional question-handler method, and the nudge
  budget's size.
