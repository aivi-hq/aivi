# Dispatcher build — the shrinking checklist

The design and every ruling that shaped it live in
[../orchestrator.md](../orchestrator.md); this page is only the build
checklist, shrinking as steps land. `[x]` carries one line of truth.

Built already (2026-10-02): the dispatcher, the walk, and — after the
operator's **stage rulings** (P1–P12, owned by
[../orchestrator.md](../orchestrator.md#the-trackers-stages)) — the
`Tracker` interface itself: the orchestrator walks every run through the
tracker's stages (initWork → ready → … → endWork → move → lease), composes
the worker's first prompt, remembers no stops, re-checks nothing at
fulfilment, and gives up on an unkillable session at a capped strike count
saying so in code. Linear answers all of it; hand delegations get one fixed
refusal. The earlier live test (question round, answer, close) predates the
stages; the round below is the one that counts.

- [x] 0 Docs restructure: [../orchestrator.md](../orchestrator.md) owns the
      work-pull flow with the conversation's rulings folded in; this page is
      the checklist; the template doc kept the follower-side contracts and
      points here for lanes and capacity. (2026-10-02)
- [x] 1 Live test of the follower design, zero-config unlimited case: passed,
      operator-driven, real Linear. Gap it exposed became 1b. (2026-10-01)
- [x] 1b Closing note: the Tracker seam gained an optional `closingNote`;
      Linear posts the ending as an issue comment linked to the agent
      session, inside the catch-up, marked by the session id so retries and
      boots never post it twice. (2026-10-02)
- [x] 1c Lane board order: Linear scopes `position` **within** a type group,
      so the client now sorts by (group, position); the wizard never writes
      closed states — `openStates()` drops them and a test pins it. Success
      in the last configured lane moves nowhere; a person closes. (2026-10-02)
- [x] 1d "Model used: not available" — investigated, **not fixable by us**:
      `codingHarnessModelLabel` and friends are `[Internal]` for Linear-hosted
      coding sessions and appear in no input type. Permanent for external
      agents unless Linear opens a field. (2026-10-02)
- [ ] 2 Formalize: Conventional Commits, changesets for the `packages/`
      changes, graft build.
- [x] 3 Lane vocabulary: `complete`→`next`, `return`→`previous` in schema,
      orchestrator, wizard types and docs; `queue?`/`pool?` fields land inert
      until 5+, load-validated (one queue per workflow, never with an agent,
      its next lane — by order or override — must be a worker lane). (2026-10-02)
- [x] 4 Delivery flip: interjection defaults to **steer** on both channels
      (the follower already steered — verified); `/steer` died and `/queue`
      took its place (the explicit way behind); `finalAnswer`'s steer-marker
      trust rule unchanged in substance, restated for the new default.
      Slack's live manifest needs the `/queue` entry re-applied. (2026-10-02)
- [x] 5 Dispatcher config at the root: `dispatcher.pools` (absent =
      **unlimited**, the intended default), `dispatcher.timeouts` `{ idle
      '180m', prepare '5m' }`, `orchestrator.elicitationKeepAlive` `5m`.
      Fallback chains load-checked (exist, acyclic); `parseDuration` sums
      space-separated parts (`1h 30m` = 90 minutes). Inert until 6+.
      (2026-10-02)
- [x] 6 Lease store + dispatcher state machine (`host/src/dispatcher/`):
      durable leases (grant / attach / touch / release / expire), boot
      reconcile (a silent OpenCode defers the whole pass, never a purge);
      unlimited mode always grants. The pool's model wins at session create;
      the agent file's model wins only in a pool that names no model. A
      session keeps its pool for life: fallback never applies to a resume.
      (2026-10-02)
- [x] 7 Orchestrator onto leases: the eligibility walk (lanes right→left,
      tickets top→bottom), a queue lane is the bottom of its worker lane's
      list, move-then-start with the self-webhook folded into the claim, a
      refusal stops that pool for the pass, claims mirror leases. (The
      stop-memory and the sessionless ceremonies built with it were
      superseded the same day by the stage rulings: a stop releases the
      ticket, `initWork` gives every run its agent session.) (2026-10-02)
- [x] 8 In-memory dispatcher queue + per-service callback namespaces +
      cancellation (one pending request per service+pool; ephemeral by
      design; only bites once pools are configured). Built with it: the
      queued entry carrying its own plan — a walk entry its lane, a push
      entry its summary and directory. (The fulfilment re-check built with
      it died the same day: cancel-on-move is the mechanism now.)
      (2026-10-02)
- [x] 9 Timeout monitor: idle kills, confirms, then frees (an unconfirmed
      kill keeps the slot unavailable); prepare revokes session-less leases.
      One known-instant `setTimeout` per lease, re-armed by activity —
      `setInterval` stays banned. Built with it: the retry at a known
      instant for unconfirmed kills, the clocks watching leases in every
      mode (pools count, they do not gate the watch), and survivors
      re-armed from stored activity after a boot pass. (2026-10-02)
- [x] 10 Elicitation: in-session human input **holds** its slot; after
      `elicitationKeepAlive` the lease releases (the session stays); the
      answer reacquires and **resumes the same session** — fallback never
      applies to resumes. `awaiting_input` returns as the state to time
      against. Built with it: the keep-alive ends as a release, never a
      kill; a full pool queues the reacquisition and a refusal is said;
      a stop reaches a parked run; a wait that survived a restart re-arms
      its clock from the boot. (2026-10-02)
- [x] 11 Wizard: after **all** lanes are configured, one question — a select
      of the configured lanes (or `-- None --`) picking the queue lane. Not
      per lane. Options are limited to lanes that could legally hold the
      queue (a lane whose next works nobody is no option, and — amended by
      P4 the same day — a lane that names an agent is never an option), and
      choosing a lane that just chose an agent gives the agent up — said
      out loud. (2026-10-02)
- [ ] 12 Live round with real pools (capacity 1–2): ordering, refusal, queue
      pickup, elicitation timeout + resume, restart reconcile. Then commits,
      changesets, and the single v1 rc tag.

Tracked deliberately later (not this build): folding `scheduler.resources`
(jobs, turns, dreamer) into the dispatcher's pools — the one-pool
unification; worktree/forge prep; GitHub Issues and Jira adapters.
