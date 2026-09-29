/**
 * The **forge** contract: the seam between aivi and a repository host. A
 * forge owns the *remote*: the repository a project's checkout came from, the
 * pull requests over its branches, the review conversation on them, and the
 * credential that lets aivi move bytes as its own app.
 *
 * The line between a forge and aivi is **remote, not git** (ruled
 * 2026-09-29): any git operation that reaches `origin` authenticates to it,
 * so it belongs to the forge — clone, fetch, the sync of a clean checkout,
 * push. What only touches the local store is aivi's own machinery (the
 * orchestrator creates and reaps worktrees, the worker commits in one) and
 * never appears here. A forge uses its API for what git cannot see: pull
 * requests and reviews.
 *
 * Types only — the machinery consuming them ships in the host. The exact
 * member set is **provisional by design**
 * ([forge-github.md](../../docs/plans/forge-github.md)): the orchestrator's
 * wiring is what proves it, and more forges will move the details.
 *
 * A project **having no forge is not a failure** (ruled 2026-09-29): a ticket
 * can be "research X, write it up" and complete without aivi ever asking a
 * repository host anything. Nothing here may assume a worker touches a remote.
 *
 * Cloning is a forge's operation too, but it is not on this interface: it
 * happens once, at project setup, through the plugin's `./setupProject`
 * contributor ([setup-project.ts](setup-project.ts)), which is where a person
 * is asked which repository they mean. By the time a `Forge` is speaking to
 * aivi the checkout already exists.
 */

/** What a forge needs to know about a project to recognise it: the directory
 *  aivi discovered the checkout in. Reading `origin` from it is a local git
 *  read — reaching `origin` is the forge's own business, below. */
export interface ForgeProject {
  id: string;
  directory: string;
}

/** One repository of this forge, in the forge's own terms. Opaque to aivi:
 *  it is handed back to every other call and never inspected. */
export interface RepoRef {
  /** The forge's name for it (`owner/repo`); what logs and errors say. */
  id: string;
  /** The remote URL aivi would use to reach it — the forge's own to
   *  authenticate; nothing outside the forge puts a credential in it. */
  remote: string;
}

/** A pull request over a branch: the fact a tracker may also report from its
 *  own knowledge, and the forge answers when it cannot. */
export interface PrFacts {
  /** The forge's id for the pull request; what `resolveThread` and friends
   *  are called with. */
  id: string;
  url: string;
  title: string;
  /** The platform's own state word (`open`, `merged`, `closed`). */
  state: string;
  /** The branch it stands for — the one thing aivi correlates on. */
  branch: string;
}

/** Who wrote a review comment. Aivi's own posts are *signed* — visibly, in
 *  text a human reads — and the forge parses that signature back into
 *  `worker`, so a wake can tell its own past comments from a human's. */
export interface ReviewAuthor {
  /** The platform's login (`octocat`, `aivi-agent[bot]`). */
  login: string;
  /** The worker role aivi posted as, read back out of the comment's own
   *  signature; absent for a human and for anything aivi did not write. */
  worker?: string;
  /** True when the platform says the author is an app or bot. */
  bot: boolean;
}

/** One review thread. Only **open threads** are ever handed to a worker
 *  (ruled 2026-09-29): there is no `since` cursor, a wake takes what is open
 *  and the worker must bring all of it to zero — by agree (commit, then the
 *  forge pushes on the orchestrator's word) or by decline (comment and
 *  resolve). */
export interface ReviewThread {
  /** The forge's id for the thread; what `resolveThread` is called with. */
  id: string;
  /** The file the thread speaks to, when it is anchored to one. */
  path?: string;
  /** The platform's own state word (`open`, `resolved`, `outdated`). */
  state: string;
  /** The thread's opening body — what the worker is being asked. */
  question: string;
  /** Everything said since, oldest first, each with its author. */
  replies: { author: ReviewAuthor; body: string }[];
}

/** What a worker wake gathers about a pull request: the state of the review
 *  in neutral terms, and the open threads it must answer. */
export interface ReviewFacts {
  pr: PrFacts;
  /** Approvals in the platform's own words (`APPROVED`, `CHANGES_REQUESTED`). */
  reviews: { author: ReviewAuthor; state: string }[];
  /** The threads a worker still owes an answer on. Empty means a clean
   *  review: nothing to resolve, nothing to reply to. */
  threads: ReviewThread[];
}

/** What a forge answers and does. Everything here is either a **fact aivi
 *  cannot compute from a clone** or a **remote operation only the forge may
 *  authenticate for**. */
export interface Forge {
  /** The forge's name for the repository a project's `origin` names, or
   *  undefined when the remote is not this forge's — another forge's turn,
   *  or no forge at all. */
  repoFor(project: ForgeProject): Promise<RepoRef | undefined>;

  /** The pull request over a branch, if one exists. A tracker may answer
   *  this from its own knowledge; the forge is the fallback that can say. */
  prForBranch(repo: RepoRef, branch: string): Promise<PrFacts | undefined>;

  /** The review conversation: the open threads and the state of the
   *  approvals, gathered for a worker about to wake. */
  reviewFeedback(repo: RepoRef, pr: PrFacts): Promise<ReviewFacts>;

  /** Answer one open thread as aivi and resolve it. The orchestrator calls
   *  this with the message from a validated resolution report; the worker
   *  never holds forge credentials to write review traffic, and the comment
   *  says which worker role it came from — visibly. */
  resolveThread(repo: RepoRef, pr: PrFacts, threadId: string, reply: { author: string; text: string }): Promise<void>;

  /** Bring a project's clean checkout up to date with `origin`: fetch, then
   *  fast-forward the checked-out branch. Anything needing a decision (local
   *  changes, a detached head, diverged history) is reported, never forced —
   *  the checkout aivi indexes is not a working directory. */
  syncSource(repo: RepoRef, directory: string): Promise<ForgeSync>;

  /** Move aivi's own commits to `origin`, and open the pull request if this
   *  branch has none yet and a message came with the push. The orchestrator
   *  decides *when* (turn end); how the forge authenticates — mint once,
   *  cache to its TTL, re-mint on a 401 — is the forge's own choice and never
   *  written into the worktree's `.git/config`. */
  push(repo: RepoRef, worktree: string, branch: string, pr?: { title: string; body: string }): Promise<PrFacts>;
}

/** The outcome of bringing a checkout up to date, in the forge's own words:
 *  `updated` when it moved, `current` when it already matched, `held` with
 *  the reason when only a human can decide. */
export interface ForgeSync {
  state: 'updated' | 'current' | 'held';
  from?: string;
  to?: string;
  reason?: string;
}
