# Linear module: what is left

Status: the module is built and [linear.md](../linear.md) owns the behaviour.
This file keeps only what no document could settle — the six verifications
and the live gates — plus the open build items and the deliberately-later
list. The build checklist, the vocabulary and the decisions are history:
the behaviour docs own what is, and git owns how it got built (this file was
shrunk 2026-09-26). Where a step below says "lock released" or "serialize",
the single-app rework (2026-09-19) replaced that: worktrees isolate, the
pool is the capacity, one worker per issue is the redelivery guard.
Requirements this serves: [requirements.md](../requirements.md) §2, §4, §5.

## Verify (facts no document could settle; each gates the work that needs it)

- [x] **verify 1** (answered 2026-09-26, live) `client_credentials` alone
      receives nothing: the app must be *installed* with one browser
      authorisation (`actor=app`, `scope=read,write,app:assignable,app:mentionable`).
      Tokens still come from client credentials. The rotation dance that
      cost hours was an artifact of that one app — webhooks added after
      the install would not start; an app created with its webhooks
      ticked installs clean and deliveries flow right away (confirmed
      2026-09-26 with a fresh app). Catching the callback is an open
      build item below.
- [x] **verify 2** (answered 2026-09-26, live) Making the app the delegate
      creates the agent session *itself*, in the `issueUpdate` mutation's
      own answer: `agentSessions.nodes[0]`, `status: pending`, with a url —
      seen for a human's delegation (the `created` webhook followed one
      second later) and for the installer's own. Built 2026-09-26: the listener
      delegates first and starts from that answer; `agentSessionCreateOnIssue`
      is gone, and a later `created` webhook dedupes as the redelivery it is.
- [ ] **verify 3** `agent.list` with
      `directory: <home>/projects/<id>/worktrees/<x>` returns agents from
      `<home>/.opencode/agents/` and prefers the worktree's
      `.opencode/agents/` file of the same name. Record the result in
      [projects.md](../projects.md).
- [ ] **verify 4** The `stop` signal's payload shape (`agentActivity.signal`),
      `Issue.branchName` in the session payload or by query, and the
      delegate-removed notification (`issueUnassignedFromYou`) as they arrive
      today; the Webhooks schema explorer is the reference.
- [ ] **verify 5** An app user can be delegated issues in every mapped team,
      including a **private** team the app user has not joined; if membership
      is required, the setup says to add each app to every mapped team.
- [x] **verify 6** (answered 2026-09-26, live) The Issues data-change payload
      carries `teamId`. Moving a ticket without any delegate posts an
      `Issue update` naming `stateId` and `triagedAt`; every payload
      carries `webhookTimestamp`, and the `linear-signature`,
      `linear-timestamp` and `linear-event` headers are what `verifyWebhook`
      already reads.

## Live gates — retired as history (2026-09-29)

The module has never run live end to end, and the operator ruled (twice:
2026-09-27 in the [templates program](templates/index.md), confirmed
2026-09-29) that it is **rebuilt to the orchestrator design, not verified
against the old one** — so the per-step gates this page listed are dropped
rather than run. What replaces them: the tracker extraction and orchestrator
extraction each carry their own live gates, written against the new shape
when they are planned. Record any partial findings in
[roadmap.md](../roadmap.md).

## Open build items

- **The lane cache (ruled 2026-10-02: later, functionality first).** The
  walk asks `tickets()` fresh every wake: one live `issuesIn` per mapped
  team per lane per pass. Linear's webhooks already carry the changes —
  an issue's lane, labels and blockers arrive on `updated` — so the board
  can be a cache this module maintains from the webhooks it already
  receives, refreshed at boot (Linear does not retry failed webhooks, so
  a boot read is the reconciliation) and on any uncertainty. The cost of
  today's freshness is one query per lane per wake; the walk is
  event-driven, so it is overhead, not a spin — but it is overhead.
- The installer's browser-install step is built (2026-09-26, live-confirmed): a
  one-shot loopback listener bound *before* the instructions print, so
  the human registers its exact callback URL in the app's Redirect URIs
  field — an unregistered one is refused — and the authorize link carries
  `redirect_uri` raw (percent-encoding it is refused). The page says
  "Linear is installed", and the installer trades the code at `oauth/token`
  itself. Rejected: catching the code through the host's diary (hacky)
  and restarting the host mid-install; the CLI refactor stays on the
  personal backlog.
- The installer starts only when the live host answers `GET /health`: the
  test can observe nothing else. Rejected (2026-09-26): binding the host's
  own port and catching the webhooks directly — correct in theory, but it
  means reading the host's bind and port, matching them, and keeping two
  arrival paths, all to save a prompt to run `aivi serve`.
- The installer's test is one throwaway ticket proven in two waits that run
  one after the other (2026-09-26, sequenced 2026-09-27), named for the
  systems they prove: `webhooks` first — creating the ticket proves Linear
  delivers to this URL — then `agent events` — delegating proves the
  session is created and posted about. Each wait owns one live line: what
  lands rewrites it, and its verdict closes the line with clack's own
  marks — a hollow green diamond for passed, a red square for failed, the
  failure naming the likeliest cause. It starts without a
  confirmation: what it will do is explained before the team is asked for.
  A wait that passes is not made to sit out its window — the window only
  bounds a failing one, where silence is the proof; the agent-events wait
  is skipped only when the webhooks wait proved nothing arrives at all.
  A mistyped secret used to hang the installer: the install listener now
  closes on every exit path, because a bound server keeps the process
  alive after the last line is said (live bug, 2026-09-27). The diary is
  re-read every 2 s by a `setTimeout` calling itself: macOS file events
  never report SQLite's WAL writes (measured), and `setInterval` is
  banned (AGENTS.md).
- The installer draws its own lines (2026-09-27): the context carries the
  runner's `@clack/prompts` module as `ctx.prompts`, and the setup flow
  uses it for its log lines and per-check spinners. Two clacks animating
  one screen mangle each other (measured by probe: one animation at a
  time, nothing printed beside it), so whoever is called owns the screen;
  a flow settles its spinner before returning or throwing. Rejected:
  proxying spinner verbs through the contract (a field per glyph), and
  handing the CLI's restart sentence to the child through the environment
  to print in the outro (prose in an env var). The flow ends with its own
  single line — `Linear is configured: both checks passed. Restart aivi to
  load Linear.` — and the CLI only reports a restart it performs itself
  (an installed service), superseding the 2026-09-26 ruling that the
  restart sentence was the CLI's line.
- The `note`/`log`/`ask` proxy verbs are gone (2026-09-27): the contract
  keeps `prompts`, `print`, `fetch` and the two writers, and every
  installer draws with `ctx.prompts` itself — slack, discord, browser and
  linear alike. Each carries one local `settled`, because clack's direct
  answers need guarding: Ctrl+C answers with a cancel symbol and an empty
  Enter with nothing (measured in 1.8.1: a text prompt's empty submit
  resolves `''` through its finalize, a select with no options with
  `undefined`); neither is an answer, so `settled` throws
  `PluginSetupCancelled` and the runner keeps saying the one cancel line.
  The prompt-answering test harnesses stub clack's verbs on `prompts`
  instead of the proxies; the cancel tests script `CANCEL_SYMBOL`, which
  clack re-exports for exactly that.
- Worker session title `<identifier> <title>` and richer session metadata.
- Worktree pruning by age, never while its turn is pending — lands with the
  sweep ([linear-worktree-lifecycle](../backlog/linear-worktree-lifecycle.md)).

## Later, deliberately

- Graceful agent-first cleanup with deadlines
  ([requirements §4](../requirements.md#changes-while-work-is-active),
  [shutdown-hooks](../backlog/shutdown-hooks.md)) for effects a worktree
  does not contain (a test database migration); needs a way for the agent to
  report "cleanup complete" (a plugin tool) and a per-project definition of
  clean.
- More than one worker per project as a configured limit (worktrees already
  isolate them; the pool is the capacity).
- Per-project `worktree: { copy: [".env"], setup: ["npm ci"] }` for what a
  fresh worktree cannot regenerate.
- Permission prompts as `elicitation` (with `select`), answered through
  `prompted`.
- Agent plans (`agentSession.plan`) from the progress model's tool list;
  `externalUrls` once there is something to link to.
- Reading Linear's Inbox notification category for unassignment if verify 4
  shows it is the only signal.
