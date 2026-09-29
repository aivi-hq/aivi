# Forge: GitHub as the repo host

Status: **plan of record** (all open questions resolved 2026-09-29; the
wake flow detail awaits worked examples). First
build of the [v1 rc line](../roadmap.md#next-in-order-of-intent) after the
CLI refactor; predecessor of the [templates program](templates/index.md)
extractions, which consume this. The contract is **provisional** in the
same way the tracker seam is: the orchestrator extraction is what proves
it, and more forges will move the details.

## What a forge is

The **repo-host role**: everything about the repository that git itself
cannot see from a clone — pull requests, review feedback, and the
credential that lets aivi act as its own app. Today that is GitHub; the
choice stays reversible (no forge vocabulary in ticket or worker code).

The word distinguishes two things that keep getting conflated:

- **GitHub as forge** — branches, PRs, review facts. This page. One forge
  per project, discovered from the project's git remote.
- **GitHub as tracker** — issues as tickets. A possible future adapter in
  the [orchestrator](templates/orchestrator.md) seam; unrelated to this.

Today GitHub is a forge implicitly: every project clone has `origin`,
`identity.github` names the commit bot, `identity.github.app` waits
unused, and PRs are entirely the worker's own business. This makes the
role explicit: the contract lives in **`@aivi/plugin/forge`** (D6: the
subpath gets its first content from this build), the GitHub
implementation is the plugin **`@aivi/forge-github`** (D20 naming).

## The boundary: git is git; the forge is what git cannot see

No forge API moves bytes of the repository. The worktree mechanics stay
plain git against `origin`, exactly as `tracker-linear/src/worktree.ts`
does them today:

| Thing | Who does it |
| --- | --- |
| fetch, worktree add, push, ff-updating a restored worktree | **git** — the remote URL is a project fact, not a forge API |
| does a PR exist for this branch, which one, what state | **the forge** (API) |
| review feedback on a PR | **the forge** (API) |
| acting on GitHub as aivi's app (auth) | **the forge** (API) |

So "the orchestrator brings a restored worktree up to date with the
forge" is `git fetch` plus a fast-forward — no GitHub API call. The forge
answers *facts about* the branch.

**The forge is a configurable path, not the spine** (ruled 2026-09-29).
Forge workflows are not all workflows: a ticket can be "research X, make
a PDF or a presentation, email it to so-and-so" — no forge in sight. The
orchestrator is the glue between *all* systems — tracker, forge,
channels, mail (its name may still change) — and the forge steps (push,
PR, review wakes) are a path taken only when the ticket's project has a
forge at all. No forge is not a failure: such a ticket completes without
aivi ever asking GitHub. Nothing in this contract may assume every
worker touches a repository's remote.

## The contract (draft)

Capabilities and commands only; delivery details are the forge's own,
exactly as ruled for trackers. Everything a forge answers is a **fact the
orchestrator cannot compute from a clone**.

```ts
interface Forge {
  /** Which repo this project's remote names, in this forge's terms —
   *  undefined when the remote is not this forge's (another forge's turn). */
  repoFor(project: ProjectFacts): RepoRef | undefined;

  /** The PR for a branch, if one exists: the fact Linear reports from its
   *  own knowledge and the forge answers by search when it cannot. */
  prForBranch(repo: RepoRef, branch: string): Promise<PrFacts | undefined>;

  /** What wake gathers: the review conversation, in neutral terms —
   *  state, approvals, the comment bodies. *Open threads only*: no
   *  `since` cursor (ruled 2026-09-29) — threads close immediately, a
   *  wake takes what is open and the worker must bring all of it to zero,
   *  by agree (commit, and the orchestrator pushes at turn end) or
   *  decline (comment + resolve).
   *  Every comment carries its author: a human, or aivi *with the worker
   *  role that posted it* (below) — without the role, a reviewer sees a
   *  GitHub app talking to itself. */
  reviewFeedback(repo: RepoRef, pr: PrFacts): Promise<ReviewFacts>;

  /** The write side (ruled 2026-09-29): post the worker's reply to its
   *  thread and resolve it. The orchestrator calls this with the message
   *  from the validated resolution report; the worker never holds forge
   *  credentials for it. `author` names the worker role, and the posted
   *  comment says so — visibly. */
  resolveThread(
    repo: RepoRef,
    pr: PrFacts,
    threadId: string,
    reply: { author: string; text: string },
  ): Promise<void>;
}
```

**Signed comments** (ruled 2026-09-29). Every aivi-posted comment names
the worker that wrote it, so a wake that hands a reviewer "all the facts"
can tell its own past comments from the dev's replies and from human
comments. The default shape — the exact look gets tested at the live
gate — is a divider and an italic label closing the comment:

```md
---

_worker: aivi · review_
```

The label is the carrier a human reads *and* the forge parses back into
the author fact; no hidden markup as the only carrier.

**The review resolution** (ruled 2026-09-29). A review wake hands the
worker the open threads; each carries the forge's own id. The worker's
answer is **structured output requested in a turn — no tools** (ruled
2026-09-29 after the operator's pushback): a tool would need plumbing to
report back to the orchestrator anyway, and a tool call is itself an
instruction, so the turn simply asks for the JSON and the orchestrator
parses the answer text. It is the wrap-up ruling applied here: trusting a
long session (possibly compacted) to remember a final-message instruction
is asking for trouble; a dedicated turn with a clear schema to validate
against (zod) is what succeeds. **The orchestrator posts the replies**:
it parses the validated JSON and posts each `message` to its thread
through the forge; the worker never speaks to the forge API. The worker
also needs no review-history tooling: the wake already gathers **all
information** — ticket summary, comments, review comments *and their
replies, each signed with its worker role* — for dev and reviewer alike,
so a reviewer sees its own past comments and whether they were denied,
and can push back, stand down, or stay silent without re-commenting
(ruled 2026-09-29: simple, with trust in the LLM).

```json
[{ "thread_id": "abc-123", "message": "…" }]
```

- `thread_id` is the forge's id — the join key, aivi invents nothing.
- `resolved` is **absent from the schema and defaults to true**: only a
  thread that truly went wrong says false, and that parks the ticket
  (HITL). A sloppy model silently resolving threads is a model problem,
  not a schema problem — aivi lifts shit models up; it performs no
  miracles (ruled 2026-09-29).
- The orchestrator validates, retries **3 times**, then errors out: HITL
  label + comment + session id. The exit contract's fallback, verbatim.

**The wake flow — proposed, not settled** (2026-09-29). The operator
wants concrete worked examples before this is fixed in detail; at first
glance the shape is:

1. Wake: `git fetch` + fast-forward the restored worktree; gather the
   ticket facts and the open review threads (signed comments) — one
   gather for dev and reviewer alike.
2. Worker turn in the recovered worktree; commits stay local.
3. Closing report validated — in a review wake that is the resolution
   turn — then the orchestrator pushes (only if the worker committed),
   posts the signed replies, and resolves the threads.

Every forge step here is a *path*, entered only when the ticket's
project has a forge — the configurable-path ruling above; a
research-a-PDF-and-email ticket never enters it.

Three reads, not a surface — plus the one write (`resolveThread`). Each
earns its place before v1 ships; the list grows the way the tracker
capabilities list does — with fallback chains owned by the orchestrator
(`prForBranch`: tracker's reported PR → forge's answer → "no PR known").

**The write side is in** (ruled 2026-09-29): the orchestrator posts the
worker's replies with `resolveThread`, from the validated JSON of a
dedicated turn. **Push and PR creation are the orchestrator's too**
(resolved 2026-09-29, see Q1): the worker's git is local-only — commits
in the worktree, `git push` denied by its agent file, the attribution
plugin's move — and the closing report carries the PR message and any
deviations for the orchestrator to act on. All forge network I/O lives
on one side: fetch, push, PR creation, review replies.

**The closing report** (ruled 2026-09-29). The schema instruction rides
at session start — *finish your turn by answering following this schema
exactly, no other text* — and when the turn ends the orchestrator
validates the closing message; a failed validation is re-asked, a few
tries, then the exit contract's fallback. The report carries what the
orchestrator needs to act: the outcome, the ticket comment, **the PR
message**, and **any deviations** the worker mentions. This is the
wrap-up ruling reconciled: the dedicated turn survives as the *retry*
for when the closing message is not the JSON — which is exactly the
case the earlier ruling feared (a long session forgetting the
instruction), now caught by validation instead of hope.

## Auth: octokit, the app user

- **`@octokit/auth-app`** (+ `@octokit/rest` or `octokit`): the app signs
  a JWT with its private key and mints **installation tokens** per
  installation — the GitHub shape of Linear's app-actor dance (mint,
  cache, re-mint on 401). octokit is the maintained standard; dependencies
  pin at build.
- **The app id is the plugin's own config** (ruled 2026-09-29):
  `plugins.forge-github.app`. `identity` is per-project commit facts; a
  plugin's default belongs under the plugin, where its schema validates
  it. `identity.github.app` ("nothing reads it yet") is orphaned and dies
  at landing. The **private key is a secret**: `GITHUB_APP_PRIVATE_KEY` in
  `<home>/.env`, the scrub list grows with it (D15's list is the precedent).
- **One installation, and only one** (ruled 2026-09-29). In GitHub's
  vocabulary an *installation* is the grant: an account (GitHub's word for
  a shared account is "org"; aivi has no orgs, only projects and their
  repositories) authorizes the app for a repo set, and the grant has an
  installation id that tokens are minted from. aivi supports exactly one:
  the setup lists installations and uses the one it finds — zero or
  several is a setup error with a clear message, not a mode. Multi-app
  support stays unbuilt **until someone asks** (the operator's words:
  setting up one is a lot of work already); aliased config profiles may
  grow the config later, and the lookup is the one place that would feel
  it.
- **Writes attribute to the app** (`aivi-agent[bot]`), never to a human —
  the same rule the Linear MCP forwarder enforces for Linear. The commit
  identity (`identity.github`, a pure git fact) is untouched by this.
- **Why an installation is needed at all** (answered 2026-09-29): creating
  an app buys it an identity and a private key — and nothing else. An app
  can see **no repository** until someone *installs* it: the grant (an
  installation id) from an account to the app for a repo set. Every forge
  call — even the reads, `prForBranch`, `reviewFeedback` — is made with a
  token minted from that installation. The `Co-authored-by:
  aivi-agent[bot] <…>` trailer works without any installation because it
  is **plain text inside a commit** a human pushes with their own
  credentials; GitHub renders the bot's avatar from the email, no API was
  ever asked. The moment aivi speaks to GitHub as itself — comment,
  review, resolve — the installation is the credential.
- **One installation can cover many repos**: installed on the account with
  access to all repositories (or a chosen set), it is one installation id
  serving every repo under it — the shape that works today: **live since
  2026-09-29, the `aivi-agent` app is installed on `aivi-hq` with read
  and write access to code and pull requests** (the operator's own
  install; `github.com/organizations/aivi-hq/settings/apps/aivi-agent/installations`).
- **Installation is the human's act, and the setup guides every step**
  (ruled 2026-09-29): create the app (name it after `identity.name`,
  paste the private key, set permissions to read+write on code and pull
  requests), open the install link, pick the repos, return — and *then*
  aivi proves it, reading one real repo's PR list through the
  installation. No throwaway ticket: a read is enough; writes are proven
  once at the live gate.

## Package shape

- `@aivi/forge-github` — a plugin like every other: main entry
  `{ moduleId, configSchema, createModule }`, `./config`, `./setup`,
  docs shipped (`files: ["dist", "docs"]`). **Module id `forge-github`**,
  same as the package name — ruled 2026-09-29 to prevent config
  fragmentation: list entry, `plugins.forge-github` block and `/status`
  all say the one word. (The same rule says Linear's module id should be
  `tracker-linear`; renaming it is free **before v1** — no installed
  config exists to break, and D22 nukes the dev home. Recorded for the
  tracker extraction to land, not done today.)
- Listed in `aivi-plugins` (D9). Config minimal to the point of empty:
  the app id is `plugins.forge-github.app`, the repos come from project
  remotes — **no per-project forge config**; a project whose remote parses
  to no installed forge simply has no PR facts, and the orchestrator
  falls back.
- **Registration mirrors the established pattern**: at module start a
  forge registers with the host's forge registry, the way tools claim on
  the `ToolRegistry` and trackers will register with the orchestrator.
  The orchestrator asks the registry *who owns this project's remote*;
  each registered forge answers from its own parse (`github.com/owner/repo`
  → GitHub's; anything else → silent).
- **Inert until wired, honestly:** this build lands before the
  orchestrator exists. Its proof at landing is its own `./setup` (app
  configured, installation found, PR facts read from a real repo) and
  contract tests against a scripted forge; the orchestrator extraction
  wires it and grows the contract where it falls short.

## What moves, what stays

| Today | After |
| --- | --- |
| `identity.github` (commit pair) | stays — a git fact, no auth involved |
| `identity.github.app` ("nothing reads it yet") | orphaned: the forge's app id lives in its own block; delete the field at landing |
| Linear's "I know a PR exists" (a tracker capability) | stays a **tracker** answer; the forge is the fallback for trackers that cannot say |
| PRs as invisible worker magic | the worker's git is **local-only** — `git push` denied by its agent file; push, PR creation, and review replies are all the orchestrator's (Q1, Q2 resolved). The worker never holds forge credentials |

## Open questions — the discussion

1. **Which credential does the worker's `git push` use?** **Resolved
   2026-09-29: the worker does not push.** Yes, it is plain git and a
   worktree pushes like any checkout — the question was only ever
   authenticity: the machine's git has the human's keychain locally (the
   push goes out as the human), and nothing on a headless server (the
   push fails). The operator's ruling: the worker's git is **local-only
   — `git push` denied by its agent file**, the attribution plugin's
   move — and the **orchestrator pushes at turn end**, injecting a
   freshly minted installation token for that one command
   (`git -c http.extraheader=…`; nothing is written into the worktree's
   `.git/config`). PR creation rides along: a first push of a branch with
   no PR gets one, built from the PR message in the worker's closing
   report. Why this over the alternatives: embedding a token in the
   remote URL (option a) made a ~1 h token an expiry problem for long
   sessions — with an orchestrator-side push nothing sits around to
   expire, the forge client mints fresh per use and caches; `gh` as a
   helper (option b) is one more thing installed for no gain; the
   hosted-MCP forwarder (option c) belongs to **interactive** tooling,
   never to push. Attribution of the push itself does not matter ("nobody
   sees who pushed. They only see the author"), and this is deterministic
   code, not tokens burned — the operator's stated tiebreaker. The
   prefill research stays relevant only for (c)-style tools: changing
   **tool visibility or permissions mid-session** invalidates the prefill
   cache; push is git, not a tool.
2. **Who posts the reply the reviewer reads?** **Resolved 2026-09-29: the
   orchestrator does** — it parses the validated structured JSON requested
   from the worker in a dedicated turn (zod), and posts each `message` to
   its thread with `resolveThread`, which joins the contract. The worker
   never holds forge credentials for review traffic and stays
   platform-blind; the wake hands it all facts, so it needs no forge
   tools to know its own history.
3. **Per-project config for plugins.** (ruled 2026-09-29: after the forge,
   before v1 rc) Today `projectSchema` in `@aivi/core` **hardcodes
   `linear.lanes`** — core names a plugin, a leftover from before the
   registry; "plugins cannot configure projects" is only true because core
   hardcodes them. The fix: the compose step (manifest → compose → parse)
   lets a plugin contribute a *project-section* schema, and `linear`
   leaves core. The per-project app override and the aliased-profiles
   discussion wait for it; the forge ships v1 needing **zero**
   per-project config, so it is unblocked either way.
4. **One app, one installation.** Resolved 2026-09-29 — see Auth.
5. **PR conversations in the knowledge index.** Resolved 2026-09-29: not
   v1; it is traceable already — open the PR and read the threads.
6. **Setup entry.** Resolved 2026-09-29: `aivi add forge-github`. Its
   proof reads a real repo's PRs, so it wants a project already added;
   fine for v1's order (setup → projects add → forge).

## Checklist

Shape agreed 2026-09-29; all open questions resolved that day. The wake
flow detail stays proposed until worked examples are walked.

- [ ] `@aivi/plugin/forge` subpath: `RepoRef`, `PrFacts`, `ReviewFacts`,
      the `Forge` interface (`repoFor`, `prForBranch`, `reviewFeedback`,
      `resolveThread`), and the host-side forge registry (claim at module
      start, the `ToolRegistry` pattern; "who owns this project's
      remote?").
- [ ] `@aivi/forge-github` package: module id `forge-github`, empty
      config block by default, `plugins.forge-github.app` for the app id,
      `GITHUB_APP_PRIVATE_KEY` in `.env` + scrub list (D15 precedent).
- [ ] octokit auth-app client: mint, cache, re-mint on 401; exactly-one
      installation lookup (zero or several is a setup error with a clear
      message).
- [ ] `./setup`: guides every step (create app → permissions read+write
      on code and PRs → private key → install link → pick repos), then
      proves the read against a real repo's PRs; `aivi add forge-github`.
- [ ] Delete `identity.github.app` and its configuration.md line; the
      `identity.github` pair untouched.
- [ ] Q1 built: the client exposes the minted installation token for
      git-command injection (`http.extraheader`); the worker's
      `git push` deny and the orchestrator-side push + PR creation are
      wired when the orchestrator extraction exists — recorded here so
      the shape is settled, not built today.
- [ ] Signed comments end to end: `resolveThread` stamps `aivi · <role>`
      visibly, `reviewFeedback` parses it back into the author fact.
- [ ] Contract tests against a scripted forge; live gate: one real PR
      read, one real thread resolved as `aivi-agent[bot]`.
- [ ] Docs: configuration.md (the block, the secret), operations.md (the
      forge in the worker story), CONTEXT.md vocabulary (forge,
      installation), the plugin's own shipped docs.
