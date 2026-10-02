# The worker's git workflow

**Plan of record** for how a worker works on a ticket whose project has a
repository: commit, push, open a pull request, process review feedback,
re-push, and close out. The forge owns every crossing of the remote
boundary ([forge-github](forge-github.md) owns the credential and the
transfers); this document owns the **worker-facing surface** — the tools,
the feedback loop, and the guidance that ties them together.

Ruled by the operator 2026-10-02, in his words where quoted. The mechanics
here are decided; the build order at the bottom awaits his go per slice.
Walked end to end the same day — ten scenes: the happy path, agreeing and
disagreeing with review feedback, a conflict against a moved main, a person
pushing to the branch, a merged PR reopened, a review round, the escalation,
a research ticket with no forge, and the edges. It held — with **one fix
found** (the integrate-check under the tool table) and **one rule settled**
(an answered escalation resets the strike count).

## The boundary rule

- **Local git is the worker's, unrestricted**: status, diff, add, commit,
  branch, rebase, merge, conflict resolution, stash, hooks. The worktree
  carries the bot identity, so commits are aivi's (already built).
- **Every external boundary is crossed by using the forge.** The worker
  reaches `origin` only through aivi tools; the forge authenticates as its
  own app. Two independent enforcement halves, ruled by the operator:
  - **The wall**: the worktree mark gains `credential.helper=""` and
    `core.sshCommand=false`, so a smuggled `git push` **has no credential
    to spend and simply fails**. "Our code failing means the push fails.
    Because there are no credentials." The forge itself is immune: it names
    the HTTPS URL on the command line and passes its token through
    `GIT_CONFIG_*` env, which outranks worktree config, and `repoFor`
    already converts an ssh `origin` to the HTTPS transfer URL — so the
    tools work however the checkout was cloned.
  - **The signpost**: an attribution-style `permission.evaluate` hook in
    **aivi's own OpenCode plugin** (`packages/opencode/src/index.ts`)
    denies boundary git *in aivi run sessions only* and says what to use
    instead. The operator's own sessions in the same checkout are never
    touched. A person's manual clone (ssh or https) needs nothing new: the
    forge reads the remote and converts.

## The tool surface

All served always (per-session injection is not possible: the plugin
registers at load); all error plainly when the project has no forge, no
remote, or nothing to do. Every check runs in the **run's directory** —
the worktree when the lane has one.

| Tool | Args | Does | Plain errors |
| --- | --- | --- | --- |
| `aivi_push` | – | Move HEAD to the remote branch, as the app, **unstuck with as little chatter as possible** (ruled 2026-10-02: "Git refuses pushes if the remote has changes… If we can fast forward: fine. If we can safely merge it in: fine. If conflict: well, resolve it. These are worker agents."). One call: fetch the branch fresh through the forge; fast-forward → push; diverged with real remote commits → merge them in locally — clean → push, **conflict → the tool names the files and the worker resolves with plain git** and pushes again; diverged only by the worker's own rewrite (every remote commit patch-equivalent per `git cherry`) → `--force-with-lease` goes through, nothing lost. The lease keys on the fresh fetch and is never said out loud. | no forge · nothing ahead · `conflict resolving these files — resolve and push again` · default branch · detached HEAD |
| `aivi_pr` | `title` (required), `body` | Open the pull request for the branch: pushes first if there is anything unpushed, then opens. The body is signed `_worker: aivi · <role>_`. | no forge · no title · **PR already open**: not an error — answers with its url and pushes what was pending · merged/closed PR + new commits → **opens a fresh PR** |
| `aivi_sync` | – | Carry the remote's refs in through the forge (all branches, pruned) and report `behind`/`ahead` for the branch and the default branch. Keeps the push lease honest; a rebase starts here. | no forge |
| `aivi_review` | – | Fresh read of the pull request: open threads with replies, **plain conversation comments**, approval states, mergeable state. | no forge · no PR known |
| `aivi_respond_feedback` | `threadId?`, `body` | With a `threadId`: reply to that review thread, signed, and resolve it (agree or disagree — both end resolved). Without: a plain PR comment. | no forge · no PR · thread not open |
| `aivi_submit_review` | `body`, `state` (`COMMENT` \| `REQUEST_CHANGES`), `findings?` | The review agent's voice: a review with inline findings, which the platform shows as review threads — agent feedback the next round's worker owes answers on. APPROVE is not offered (GitHub fiat: the app authored the PR). | no forge · no PR · bad state |
| `aivi_work_complete` | unchanged | Completion, **plus the feedback gate** below. | (existing) |

`aivi_push` and `aivi_pr` are **separate tools** (ruled: "Differentiate
between PR and PUSH. Make them 2 separate tools."). A checkpoint push asks
for no title; opening a pull request always does.

**Patch equivalence is the selector** — the walkthrough's find, put to work
by the 2026-10-02 ruling. When HEAD and the remote branch have diverged,
`git cherry` asks whether the remote's commits all have patch-equivalents
in HEAD. They do → the divergence is the worker's own rewrite (a rebase):
nothing content-wise would be lost, and the `--force-with-lease` push goes
through. They don't → the remote holds a person's real work: merge it in
and let the merge verdict (clean → push; conflict → name the files and
let the worker resolve) decide. The hole the walkthrough found — a
rebased re-push dropping a person's commit because the *ref* was honest
while the *content* was wrong — is plugged by the same check, from the
other side.

## The feedback loop

**Built 2026-10-02.** The edges the build had to name: a pull request that
**closed** mid-run owes nothing (its threads died with it); a gate read that
**fails** is a plain "call it again" error and **no strike** (a GitHub
hiccup must not burn the tries); a start gather that fails is warned in the
log and the run starts clean — the gate will owe nothing, loudly visible in
the log; and after an escalation is answered, refusals count again but the
form is never made a second time.

The core mechanic, ruled by the operator: **"if there is open feedback, we
keep nudging until there is none"** with **"a max of 3 tries or something
until HITL"**, and his nuance that a run which *started* without feedback
must not be chased by feedback that appears mid-run — because a reviewing
agent would never finish its own review.

1. **Snapshot at start.** When the orchestrator composes the first prompt
   and the project has a forge and the ticket's branch has an **open** PR,
   it persists that moment's open review-thread ids on the run row. This
   is the whole bookkeeping; there is no owed-set choreography.
2. **Guidance, not enforcement, at start.** If the snapshot is non-empty,
   the first prompt carries the feedback-loop guidance: *this is returning
   work with unresolved comments — process each by agreeing (do the work,
   `aivi_push`) or disagreeing (leave a grounded comment); both end with
   `aivi_respond_feedback`.* Whether the agent is reviewing or answering a
   review is the **agent file's** word, not the orchestrator's.
3. **The gate at completion.** `aivi_work_complete` with outcome `success`
   re-reads the PR through the forge. **Owed = snapshot ids still open.**
   Non-empty → the completion fails as a tool error **listing each owed
   thread** (path, the question, its id) and teaching the loop in the
   message itself. Empty → the run ends.
   - Started clean → the snapshot is empty → a review agent posts its
     findings (new threads, not owed) and completes freely. The nuance
     holds mechanically, posture-blind.
   - Feedback arriving mid-run on a clean-start run → not owed (ruled).
   - A human resolving a thread is authoritative; no reply is owed to a
     closed question. A human **re-opening** a snapshotted thread makes it
     owed again at the next read — which is the point.
   - **Failure completions are exempt**: a worker giving up doesn't have to
     answer reviewers to hand the ticket back.
4. **Three tries, then HITL.** Each rejected success-attempt counts on the
   run row. At the third, the orchestrator creates the **ask form** itself
   — the same durable OpenCode form `aivi_ask` makes, free-text answers
   allowed — listing the owed threads and asking the person what to do.
   The run parks on the answer (existing keep-alive machinery); the answer
   resumes the session. The escalation is recorded so a second form never
   doubles it. The person's ways out are all honest ones: answer with
   instructions, resolve the threads on GitHub themselves, or say "ship
   it" and let the worker resolve the threads with that reason. **There is
   no bypass hatch**: past the gate only threads that are actually resolved.
   An **answered escalation resets the count** (ruled in the walkthrough):
   the person said "try again with these instructions", not "fail after
   three more".
5. **Plain PR comments are context, never gate items.** GitHub gives the
   PR's conversation comments no resolved state; they ride the first
   prompt and `aivi_review`, and the agent file's guidance says to answer
   them. Only review threads can be owed.

**The review agent's voice** (GitHub's fiat, not taste): every PR aivi
pushes is **authored by the app**, and GitHub refuses an author's own
approval — so the approve button stays human, forever. What the review
agent *can* do, and v1 gives it: read everything (`aivi_review`), post
inline findings as a **review** (`aivi_submit_review` — COMMENT or
REQUEST_CHANGES; those become review threads, which is what makes agent
feedback gate-owed on the next round), plain comments, and the ticket
report. Its run ends when its findings are delivered; the next round is a
person moving the ticket — no wake machinery, no watchers.

## What the forge interface gains

On `@aivi/plugin/forge`, answered by `forge-github`. **All built
2026-10-02.** The push/sync split made `push` pure transfer — plain when
the remote fast-forwards, `--force-with-lease` keyed on the sha the smart
push just fetched when the divergence is the worker's own rewrite — and
opening the pull request became its own member, `openPr(repo, branch, {
author, title, body }): Promise<PrFacts>`, base the repository's default
branch, body signed `_worker: aivi · <role>_`.

- `fetchRefs(repo, directory): Promise<void>` — fetch **all** branches
  with prune, refs only, nothing checked out (`aivi_sync`). `fetchBranch`
  stays as the single-branch fetch the worktree start and the push's fresh
  view use.
- `commentPr(repo, pr, { author, text }): Promise<void>` — a signed plain
  conversation comment.
- `submitReview(repo, pr, { author, body, state: 'COMMENT' | 'REQUEST_CHANGES', comments?: { path, line?, body }[] })`
  — the review agent's teeth. APPROVE is not offered: the author cannot
  approve (GitHub), and offering a member that always throws is noise.
  Inline findings are signed too.
- `ReviewFacts` grew `comments: { author; body; createdAt }[]` — the PR's
  plain conversation comments, oldest first, capped (~100, like the thread
  reads). The gather grew until "all review and regular comments" is
  literally true.
- `PrFacts` grew `mergeable?: 'clean' | 'dirty' | 'unknown'` — so "main
  moved, you conflict" is in the first prompt, not a surprise at push
  time. Where the answer isn't computed (REST list reads), `unknown`.

## The worktree gets its caller

**Built 2026-10-02.** The orchestrator's prepare does it, local git only:

- The **branch name comes from the tracker**: `initWork` answers with a
  **`WorkEntry`** — `{ summary, branch? }` (Linear's `Issue.branchName`; the
  board read already carried it). A `worktree: true` lane whose tracker
  named no branch fails the run visibly, plainly; no invented name.
- Path: `worktreePathFor(source, runId)`; creation: `ensureWorktree`
  with `fetchBranch` **injected** when a forge owns the remote (the
  registry answers), local refs otherwise. An existing worktree holding
  the branch is reused, uncommitted work intact — a later run on the same
  ticket finds it by the branch, not by the path. The session is created
  **in the worktree**, and the ledger's `worktree` column records it.
- `markWorktree` writes the wall: five settings now — identity, autonomy,
  and `credential.helper=""` + `core.sshCommand=false`, so boundary git
  that slips past the tools has no credential to spend.
- Identity: `gitIdentity(loaded.config.identity, globalGitConfig)` —
  core's order, resolved per worktree (the first caller `globalGitConfig`
  ever had).

## The redirect hook

**Built 2026-10-02.** `packages/opencode/src/index.ts` added a
`permission.evaluate` hook, the attribution plugin's shape: pure logic in
`redirect.ts` (normalise the shell resource, match `git
push|fetch|pull|clone|ls-remote|remote` — any flags/`-c` prefixes), deny
with a redirect message — `git push is disabled in aivi runs — use
aivi_push (and aivi_sync first if the remote moved)`. Scoped by the one
fact the plugin has: `sessionID`. The plugin asks the host once per
session — `GET /run?session=`, answered from the run ledger — and caches
the answer; persons' sessions never get the deny, and a host that cannot
answer fails **open**, retried at the next boundary command: the wall is
the safety, the hook is courtesy.
Honest edges, said rather than hidden: a **checkout lane** (`worktree:
false`) has no worktree mark, so there the hook is guardrail without the
wall; and a boundary git that slips past both has no credential to spend
anyway — the wall is the safety, the hook is courtesy.

## `prompts/` — the guidance the operator can edit

**Built 2026-10-02.** Automated prompts don't fit in an agent file without
making a mess, and "this is entirely up to the operator. They want to break
their server, they can. … 'fixing it' is just removing their messed up
version."

- **Defaults live in core code** (`@aivi/core` `prompts.ts`), tested, one
  source. The set: `worker-contract`, `nudge`, `feedback-loop`,
  `review-posture`, `pr-body`, `escalation` (the HITL form text),
  `job-result` (the re-entry line). Grows only by ruling.
- **Setup installs a copy** into `<home>/prompts/<name>.md` — `server
  create` does it as the home is born — never overwriting an existing file,
  and each installed file opens with a warning header: edit freely; delete
  this file to get the built-in back. `aivi prompts install` re-copies what
  is missing.
- **Read at use**, so an edit lands on the next run and a delete is instant
  restoration. Missing, unreadable or emptied file → the built-in default.
  `aivi prompts` lists the set with each source; `aivi prompts show <name>`
  prints the words aivi speaks today.
- **Composition stays code.** Templates fill the *guidance slots* of the
  orchestrator's first prompt; ticket data, tool mechanics and the state
  machine are not template material. A custom `worker-contract.md` that
  drops the completion sentence breaks the run — allowed, warned, and one
  `rm` from fixed. The slots: `{directory}` in `worker-contract`; `{pull}`
  in `feedback-loop` (the owed threads and plain comments still ride under
  it as code composes them); `{pull}` and `{list}` in `escalation`;
  `{text}` in `job-result`. `review-posture` and `pr-body` ride every first
  prompt as one short paragraph — nothing in the state machine reads them,
  so the completion gate stays posture-blind.
- The **agent file** carries the per-lane posture line (the operator's:
  "if this is returning work, with unresolved comments, process feedback by
  either agreeing (do the work) or disagreeing (leave a grounded comment);
  both use aivi_respond_feedback"), copyable from `docs/plans/templates`.

## Ledger

**Built 2026-10-02.** One migration (version 4) added the loop's state to
`orchestrator_runs`: a `feedback` JSON — `{ openThreadIds: string[],
attempts: number, escalated: boolean, formId? }` — written at start,
counted at each rejected completion; `formId` is the escalation form whose
answer resets the count. Survives restarts because everything else does.

## Build order

Each slice lands with tests at the boundary it moves, docs in the same
commit, and the operator's word to start.

1. **Worktree gets its caller** — **built 2026-10-02** — `WorkRequest.branch`,
   orchestrator prepare creates/reuses the worktree with `fetchBranch`
   injected, the no-credential mark. Nothing below is live until this.
2. **Push/sync split** — **built 2026-10-02** — `aivi_push` (force-with-lease
   **plus the integrate-check**), `aivi_sync` +
   `fetchRefs`, `aivi_pr` reduced to *open the PR* (push-if-needed,
   already-open answers, fresh PR after merge), the lease-refusal message
   naming `aivi_sync`.
3. **The feedback loop** — **built 2026-10-02** — `ReviewFacts.comments`,
   `PrFacts.mergeable`, `commentPr`, `submitReview`, the start snapshot
   (migration included), first-prompt composition, `aivi_review`,
   `aivi_respond_feedback`, `aivi_submit_review`, the completion gate with
   the 3-strike escalation form (an answer to *that form* resets the
   strikes).
4. **The hook + `prompts/`** — **built 2026-10-02** — session-scoped deny in
   aivi's plugin (`e2307ae`), the host membership endpoint (`GET /run`),
   core defaults + setup-installed copies + read-at-use loader, the
   `aivi prompts` command, copyable posture lines for agent files in
   [templates/scaffolding.md](templates/scaffolding.md).
5. **Live gate** — one real round trip on a real repository: push → PR →
   human review comment → ticket back → agree → push → disagree → respond
   → complete → review round → gate nudge → escalation answered → done.

## Open questions

None — all three settled with the operator 2026-10-02:

1. **`aivi_pr`'s push-if-needed** reuses `aivi_push`'s machinery whole
   (the smart push above); a conflict is said in the same words and the
   PR opens on the next call after the worker resolves.
2. **Review posture**: `submitReview` carries the state; the guidance
   default (ruled in the operator's words): *"Request changes for
   problems. Comments for nits."*
3. **`prompts/`**: the setup guide installs copies **and** an `aivi
   prompts` command exists, with help text.
