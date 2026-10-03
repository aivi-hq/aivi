# Forge: GitHub as the repo host

Status: **plan of record, largely built** (all open questions resolved
2026-09-29; the wake flow detail awaits worked examples). It was built
**after** the orchestrator extraction in the
[v1 rc line](../roadmap.md#next-in-order-of-intent)
(reordering ruled 2026-09-29: the orchestrator is proven first on the
no-forge base flow, the forge joins on top as the configurable path it
is) — and the joining landed 2026-10-02: the registry, the `fetchBranch`
crossing, `aivi_pr`, and the sync rewrite all stand under the prose here.
What is owed is the **live gate**: the forge walkthrough and one round trip
over a real PR on the operator's host. The contract stays **provisional**
in the same way the tracker seam is: more forges will move the details. The **worker-facing git surface** — the tools a
worker calls, the feedback gate, the redirect hook, `prompts/` — is
planned in [git-workflow](git-workflow.md); this document owns the forge
contract and GitHub's answers to it.

## What a forge is

The **repo-host role**: everything about the repository that git itself
cannot see from a clone — pull requests, review feedback, and the
credential that lets aivi act as its own app. Today that is GitHub; the
choice stays reversible (no forge vocabulary in ticket or worker code).

The word distinguishes two things that keep getting conflated:

- **GitHub as forge** — branches, PRs, review facts. This page. One forge
  per project, discovered from the project's git remote.
- **GitHub as tracker** — issues as tickets. A possible future adapter at
  the `Tracker` seam ([orchestrator](../orchestrator.md)); unrelated to this.

Today GitHub is a forge implicitly: every project clone has `origin`,
`identity.github` names the commit bot, and PRs are entirely the worker's
own business. This makes the
role explicit: the contract lives in **`@aivi/plugin/forge`** (D6: the
subpath gets its first content from this build), the GitHub
implementation is the plugin **`@aivi/forge-github`** (D20 naming).

## The boundary: remote git is the forge's, local git is the orchestrator's

The line is **remote, not clone**. Any git operation that reaches `origin`
authenticates to it — so it carries credentials (passwords, tokens) and
belongs to the **forge**, the system that holds them. Anything that only
touches the local store is plain git the **orchestrator** runs itself.
No forge *API* moves bytes of the repository: the forge moves bytes with
**git using credentials it minted**; it uses its API only for what git
cannot see (pull requests, reviews).

| Thing | Local or remote | Who does it |
| --- | --- | --- |
| clone the project's checkout | remote | **the forge** — its `./setupProject` clones into `source/` |
| fetch, and fast-forwarding `source/` (the sync) | remote | **the forge** — fetch authenticates; the orchestrator asks, the forge fetches and ff-merges |
| bring a restored worktree up to date | remote | **the forge** — a fetch plus ff, no GitHub API call |
| `git push` at turn end | remote | **the forge** performs it, authenticated as its app (below); the orchestrator only decides *when* |
| worktree add / remove / prune, commits in a worktree | local | **the orchestrator** — raw git off refs already in the clone; never touches `origin`, holds no credentials |
| does a PR exist for this branch, which one, what state | — | **the forge** (API) |
| review feedback on a PR | — | **the forge** (API) |
| acting on GitHub as aivi's app (auth) | — | **the forge** (API) |

So "bring a restored worktree up to date with the forge" is the forge's
`git fetch` plus a fast-forward; the orchestrator triggers it and reads the
result. The orchestrator's own git is **local only** — it creates and
reaps worktrees and the worker commits inside them, and it never clones,
fetches, or pushes, because those need credentials it must not hold.

**Both operations left the wrong package (2026-10-02).** The sync fetch/ff
moved with the build that owns it: the **host-side forge registry** is built
(`host/src/forges.ts` — the kit declares the `Forges` contract, the host
implements it, `forge-github` registers at module start), and the
`projects-sync` task asks *"who owns this project's remote?"* before it
fetches: an owned checkout syncs through the forge's `syncSource`,
authenticated as its own installation; no forge, or a remote no forge
recognises, stays plain git naming no plugin (the configurable path). The
worktree git moved too: `tracker-linear/src/worktree.ts` is now
`host/src/orchestrator/worktree.ts` — a tracker answers tickets, worktree
git is the orchestrator's. **The question that moved with it was ruled the
same day**: *"every single external boundary is crossed by using the
forge."* The fetch therefore moved onto the `Forge` interface as
`fetchBranch` — GitHub answers it with a refspec naming the branch and the
credential in the environment (nothing in `.git/config`, as always); a
remote without that branch is an answer, not a failure, and it returns
quietly, while a failed fetch throws, because the caller cannot tell a
stale tip from an absent one. `ensureWorktree` takes that fetch **injected**
when a forge owns the remote; with none injected the worktree starts from
refs the clone already holds. The raw fetch is gone and the orchestrator's
git is local-only in fact, not only in the table.

**No shared `@aivi/git` package now** (ruled 2026-09-29): the orchestrator
keeps its raw local git, a forge carries its own remote git; whether a
shared git package earns its keep is a call made when building the first
forge, not before.

**The forge is a configurable path, not the spine** (ruled 2026-09-29).
Forge workflows are not all workflows: a ticket can be "research X, make
a PDF or a presentation, email it to so-and-so" — no forge in sight. The
orchestrator is the glue between *all* systems — tracker, forge,
channels, mail (its name may still change) — and the forge steps (push,
PR, review wakes) are a path taken only when the ticket's project has a
forge at all. No forge is not a failure: such a ticket completes without
aivi ever asking GitHub. Nothing in this contract may assume every
worker touches a repository's remote.

## The contract

**Built 2026-09-29** as the `@aivi/plugin/forge` subpath, in the shape below —
with two members the remote/local boundary above made necessary: `syncSource`
(fetch and fast-forward a project's clean checkout — a fetch authenticates, so
it was never aivi's to run) and `push` (the forge performs it on the
orchestrator's word, and opens the PR if the branch has none and a message
came with the push). `clone` is deliberately **not** on the interface: cloning
is where a person is asked which repository they mean, so it lives in the
plugin's `./setupProject` contributor, and by the time a `Forge` speaks to
aivi the checkout exists.

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
   *  by agree (commit, and the forge pushes at turn end) or
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
parses the answer text. The wrap-up ruling — never trust a session's memory
for the closing, trust a dedicated turn with a validated schema — applied
here: trusting a
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

**The wake flow — settled by the operator (2026-10-02)**, in his words:
"this is just the normal aivi, lane triggers, review agent gets the summary
from the tracker ticket and the forge PR (if one exists. Also includes all
review and regular comments)." There is no wake machinery: a lane move is the
wake, the walk claims for the review lane's agent, and the orchestrator's
first prompt composes the ticket's dossier, the pull request over the
ticket's branch (`prForBranch` — the tracker's own answer first, the forge's
search after), and everything the pull request says: review threads with
their replies, **and the pull request's plain conversation comments**. The
gap this page left for building is filled: `reviewFeedback` answers `comments`
beside threads and reviews, so "all review and regular comments" is literally
true.

1. Wake: bring the restored worktree up to date (the forge's fetch plus a
   fast-forward); gather the ticket facts and everything the pull request
   says — one gather for dev and reviewer alike.
2. Worker turn in the recovered worktree; commits stay local.
3. The worker calls `aivi_pr` when it wants the branch moved (ruled
   2026-10-02, below); the orchestrator has the forge push, and in a
   review wake posts the signed replies from the validated resolution
   turn and resolves the threads.

Every forge step here is a *path*, entered only when the ticket's
project has a forge — the configurable-path ruling above; a
research-a-PDF-and-email ticket never enters it.

Three reads, not a surface — plus the one write (`resolveThread`). Each
earns its place before v1 ships; the list grows the way the tracker
capabilities list does — with fallback chains owned by the orchestrator
(`prForBranch`: tracker's reported PR → forge's answer → "no PR known").

**The write side is in** (ruled 2026-09-29): the orchestrator posts the
worker's replies with `resolveThread`, from the validated JSON of a
dedicated turn. **Push and PR creation go through the forge too**
(resolved 2026-09-29, see Q1): the worker's git is local-only — commits
in the worktree, `git push` denied by its agent file, the attribution
plugin's move — and the closing report carries the PR message and any
deviations for the orchestrator to act on. All forge network I/O lives
on one side: fetch, push, PR creation, review replies.

**The closing report** (ruled 2026-09-29, **superseded 2026-10-02**). The
schema instruction rides at session start — *finish your turn by answering
following this schema exactly, no other text* — and when the turn ends the
orchestrator validates the closing message; a failed validation is re-asked,
a few tries, then the exit contract's fallback. The report carries what the
orchestrator needs to act: the outcome, the ticket comment, **the PR
message**, and **any deviations** the worker mentions. This is that
wrap-up ruling reconciled: the dedicated turn survives as the *retry*
for when the closing message is not the JSON — which is exactly the
case the earlier ruling feared (a long session forgetting the
instruction), now caught by validation instead of hope. **Superseded by the
tools that exist**: completion is the `aivi_work_complete` tool and the
answer is its input, not text to parse; and the PR message rides its own
`aivi_pr` tool — "that's a separate tool signaling something else. I would
not add it to the work complete tool" (ruled 2026-10-02). Per-session tool
injection is not possible (the plugin registers at load; calls are already
per-session), so `aivi_pr` is served always and errors plainly when the
project has no forge, no remote, or nothing to push.

## Auth: octokit, the app user

- **`@octokit/auth-app`** (+ `@octokit/rest` or `octokit`): the app signs
  a JWT with its private key and mints **installation tokens** per
  installation — the GitHub shape of Linear's app-actor dance (mint,
  cache, re-mint on 401). octokit is the maintained standard; dependencies
  pin at build.
- **The app id is the plugin's own config** (ruled 2026-09-29):
  `plugins.forge-github.app`. `identity` is per-project commit facts; a
  plugin's default belongs under the plugin, where its schema validates
  it. `identity.github.app` was orphaned — **deleted 2026-09-30**, with its
  `configuration.md` row and the `app` field of `AIVI_AGENT_BOT`: core keeps the
  commit pair and no GitHub fact, because the id belongs to whoever mints a
  token as the app. The **private key is a secret**: `GITHUB_APP_PRIVATE_KEY` in
  `<home>/.env`. **The host's named scrub list does not grow** (corrected
  as built, 2026-09-29): every key of `<home>/.env` is already withheld from
  a task script's environment (`protectedEnv`, from `loadEnvFile` in
  `host/src/cli/context.ts`), and adding a plugin's secret name to
  `SECRET_ENV` in the host would be core naming a specific plugin — the thing
  the systems-not-plugins rule forbids. The Discord and Slack names already
  in that list predate the rule; they are not a precedent to follow.
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

- `@aivi/forge-github` — a plugin like every other (built 2026-09-29): the
  `./config` subpath holds the registry's `AiviPlugin` declaration
  (`{ id, configSchema, createModule }`), and the package exports `.`,
  `./config`, `./setup` and `./setupProject`, shipping `dist` as the others
  do. **Module id `forge-github`**,
  same as the package name — ruled 2026-09-29 to prevent config
  fragmentation: list entry, `plugins.forge-github` block and `/status`
  all say the one word. **The rule holds for every plugin** (ruled again
  2026-09-30, and applied): a person writes the word they already typed into
  `aivi add`, not one they have to find in a source file. Linear's module id
  became `tracker-linear` that day — its config block, its `/status` id, its log
  category and its project section. What did **not** move is everything naming
  the platform rather than the package: the SQLite prefix and session-id prefix
  (`linear_turns`, `ses_linear_…`), the webhook URL Linear's dashboard holds,
  and the `aivi linear` command. Renaming a table prefix would leave every
  conversation already bound in a database pointing at a table nobody opens.
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
- **Wired as it lands** (reordering ruled 2026-09-29): the orchestrator
  exists before this build. Its proof at landing is its own `./setup`
  (app configured, installation found, PR facts read from a real repo),
  contract tests against a scripted forge, **and** the forge path
  driving a real worker wake — the worked examples the reorder was made
  to write while building, not inventing.

## What moves, what stays

| Today | After |
| --- | --- |
| `identity.github` (commit pair) | stays — a git fact, no auth involved |
| `identity.github.app` ("nothing reads it yet") | **gone (2026-09-30)**: the forge's app id lives in its own block; the `identity.github` commit pair untouched |
| Linear's "I know a PR exists" (a tracker capability) | stays a **tracker** answer; the forge is the fallback for trackers that cannot say |
| PRs as invisible worker magic | the worker's git is **local-only** — `git push` denied by its agent file; push, PR creation, and review replies all go through the forge on the orchestrator's word (Q1, Q2 resolved). The worker never holds forge credentials |

## Open questions — the discussion

1. **Which credential does the worker's `git push` use?** **Resolved
   2026-09-29: the worker does not push.** Yes, it is plain git and a
   worktree pushes like any checkout — the question was only ever
   authenticity: the machine's git has the human's keychain locally (the
   push goes out as the human), and nothing on a headless server (the
   push fails). The operator's ruling: the worker's git is **local-only
   — `git push` denied by its agent file**, the attribution plugin's
   move — and the **forge pushes on the orchestrator's word (turn end)**,
   authenticating the push as its own installation. As built (2026-09-29):
   the forge names the repository's HTTPS URL **on the command line** — never
   a remote's name, so a checkout's own config cannot decide where aivi's
   credential is sent — and passes the token as per-invocation git config
   through `GIT_CONFIG_*` **environment** variables, because `-c` would put
   the header in a process listing for anyone who lists processes;
   `credential.helper=` is switched off in the same breath, so the human's
   keychain is never offered and a push never quietly attributes to them.
   Nothing is written into the worktree's `.git/config`, and the tests read
   that file after a real transfer to prove it. An ssh `origin` is left
   exactly as its owner left it: aivi's transfers go over HTTPS regardless,
   since an installation token authenticates HTTPS and nothing else. How it
   holds that token — mint once, cache to its TTL, re-mint on 401 — is the
   forge's own choice, not this contract, and octokit owns it as built:
   `auth({ type: 'installation' })` hands back the cached token, mints a fresh
   one when the cached one is due, and retries a 401 that arrives within five
   seconds of the token's creation — GitHub's replication delay — warning as it
   does. A 401 after that is thrown, not retried: it means the grant is gone,
   which is a thing to fix on GitHub. PR
   creation rides along: a first push of a branch with
   no PR gets one, built from the PR message in the worker's closing
   report. Why this over the alternatives: embedding a token in the
   remote URL (option a) made a ~1 h token an expiry problem for long
   sessions — with a forge-side push the client that owns the
token also owns its renewal, so nothing sits around to expire; `gh` as a
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
3. **Per-project config for plugins.** (ruled 2026-09-29: **first in the
   line**, before the extractions — **mechanism BUILT 2026-09-29**.)
   `projectSchema` in `@aivi/core` **used to hardcode `linear.lanes`** —
   core naming a plugin, a leftover from before the registry. That is
   gone: the compose step (manifest → compose → parse) now lets a plugin
   contribute a *project-section* schema (`AiviPlugin.projectSchema` /
   `projectDefaultsSchema`, composed by `composeConfigSchema`), and
   `linear` left core entirely — its lane merge, team-collision check and
   section write live in `@aivi/tracker-linear`, and the plugin adds a
   `./setupProject` contributor (`{ role, setup(ctx) }`) that `aivi
   projects add` runs per configured role. Core spells only the roles
   (`projectRoles = ['forge', 'tracker']`) and writes the bytes a
   contributor hands back, reading none. The flow vocabulary it makes room
   for — `tracker: { id, lanes }`, `forge`, `queueLane`, `lanes` with
   `worktree`, in `projectDefaults` and per project, replace-not-merge —
   is ruled and owned by
   [orchestrator.md](../orchestrator.md);
   that compose fix built the **mechanism**, and the lanes array with its
   `worktree` flag landed with the extraction that acted on it (2026-10-01).
4. **One app, one installation.** Resolved 2026-09-29 — see Auth.
5. **PR conversations in the knowledge index.** Resolved 2026-09-29: not
   v1; it is traceable already — open the PR and read the threads.
6. **Setup entry.** Resolved 2026-09-29: `aivi add forge-github`. Its
   proof reads a real repo's PRs, so it wants a project already added;
   fine for v1's order (setup → projects add → forge).

## Checklist

Shape agreed 2026-09-29; all open questions resolved that day. The wake
flow detail stays proposed until worked examples are walked.

- [x] `@aivi/plugin/forge` subpath (built 2026-09-29): `RepoRef`, `PrFacts`,
      `ReviewFacts` and the `Forge` interface (`repoFor`, `prForBranch`,
      `reviewFeedback`, `resolveThread`), plus `syncSource` and `push` from
      the remote/local boundary. The host-side forge registry is **built
      2026-10-02** (`host/src/forges.ts`, the kit's `Forges` contract):
      forges register at module start, the `projects-sync` task asks first,
      and an owned checkout syncs through the forge; the push and the review
      wake will ask the same question when they come.
- [x] `@aivi/forge-github` package (built 2026-09-29, **prepared, not wired**:
      nothing lists it in `aivi-plugins` yet). Module id `forge-github` — the
      package name, so the list entry, the `plugins.forge-github` block and
      `/status` say the one word — and the block is one number, `app`. No
      project section is contributed: which repository a project works is a
      fact about its checkout, not about its configuration. The secret is
      `GITHUB_APP_PRIVATE_KEY` in `<home>/.env`, written as one quoted line and
      read back by Node's own loader — tested as a round trip through core's
      `upsertEnvFile` — and the host's named scrub list stays as it is, for the
      reason given under Auth.
- [x] octokit auth-app client: the app proves itself with its own JWT, and the
      exactly-one installation lookup turns zero into a message carrying the
      install link and several into a message naming the grants and saying to
      revoke what aivi does not need. The token's whole life is octokit's — the
      cached token until it is due, a fresh one after, and a retry for a 401
      inside the replication delay — and the tests assert one mint for two
      uses.
- [x] The two transfers, as `Forge` members: `syncSource` (fetch with a refspec
      that names its own branch, then `merge --ff-only`, and every case that
      would need a decision reported rather than forced — local changes, a
      detached head, diverged history, not a checkout at all) and `push` (the
      branch moves, a pull request opens on the repository's own default branch
      when a message came with the push, and a branch that already has one is
      never doubled). Proven against a real git remote on disk: the bytes
      actually move, and the checkout's `.git/config` is read afterwards to show
      aivi left nothing in it.
- [x] `./setupProject`, the `forge`-role contributor `aivi projects add` runs:
      asks which repository, proves the app can see it through the
      installation, settles the project name, and clones as the app. A checkout
      already there for the same repository is taken as it stands; one for a
      different repository stops the flow rather than writing a stranger's
      remote into a person's working copy. **This part works today**, with no
      orchestrator, because it is the CLI's own flow.
- [x] Signed comments: `resolveThread` closes its post with `_worker: aivi ·
      <role>_` under a divider and `reviewFeedback` reads that label back into
      the author fact — as the comment's **last line** only, so a person
      quoting the label does not become aivi. That one carrier serves both
      readers is what is built; the exact look is what the live gate judges.
- [x] Contract tests against a GitHub that only says what was written: 46 in
      the package — the credential, the installation lookup, each of the six
      `Forge` members, the `.env` round trip, and the declaration composed into
      `config.json`. None reaches a network, and an unscripted call fails the
      test.
- [ ] `./setup` (`aivi add forge-github`): the proof chain is built — the key
      belongs to the id, exactly one installation, a real repository's pull
      requests read through it, then the block written — but the guide is a
      note plus errors that name the fix, not a walkthrough of the app-creation
      screen. Whether that is enough is what a live run judges.
- [ ] Live gate: one real pull request read, and one real thread resolved as
      `aivi-agent[bot]`, the signed comment's look judged by eye.
- [x] Deleted `identity.github.app`, its `configuration.md` row and the `app`
      field of `AIVI_AGENT_BOT` (2026-09-30, the operator's call: there is no
      installed config to break, no backwards compatibility to hold). Core keeps
      the commit pair — name and email — and no GitHub fact at all.
- [x] Built Q1's other half (2026-10-02): the `aivi_pr` tool. The worker
      calls it with the pull-request title and description; the orchestrator
      checks the run, asks the registry who owns the remote, reads *locally*
      what there is to push (a detached head, the project's default branch
      and a branch the remote already has in full are each said, not
      pushed), and hands the transfer over: the forge pushes as its own app
      and opens the pull request only when the branch has none. Served
      always and erroring plainly (per-session tool injection is not
      possible: the plugin registers at load, and calls are already
      per-session). What enforces the rest is not the agent file (the seeded
      dev file deliberately does not deny `shell`): the redirect hook —
      built 2026-10-02 — denies boundary-crossing git inside aivi's runs
      only, so the worker's direct push is enforced where it should be,
      without aivi ever writing a deny into an agent file (AGENTS.md).
- [x] Took the misplaced remote git out of its current package (2026-10-02):
      `projects.sync` asks the forge registry before fetching — an owned
      remote syncs through the forge's `syncSource` (the rewrite), an
      unowned one and a host with no forge stay plain generic git naming no
      plugin — and the worktree git moved from `tracker-linear/src/worktree.ts`
      to `host/src/orchestrator/worktree.ts`. The open question that moved
      with it was ruled the same day — the fetch is `Forge.fetchBranch` now,
      injected where a forge owns the remote; see the boundary section.
- [ ] Docs: configuration.md (the block, the secret) and CONTEXT.md's package
      list and vocabulary travelled with this build; operations.md waits until
      the forge has a part in the worker story, which it gets with the
      orchestrator.
