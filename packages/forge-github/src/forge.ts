/** The `Forge` contract, answered to GitHub. Reads and writes over the API —
 *  the facts git cannot see from a clone: which pull request stands for a
 *  branch, what its review threads and conversation say, whether the base
 *  would take the merge — and the posts aivi makes back: a thread answer, a
 *  plain comment, a review with inline findings — plus the transfers the
 *  remote boundary belongs to: fetching branches and checkouts, and moving
 *  aivi's own commits out.
 *
 *  Every call here is made **as the app** through one installation token, and
 *  every transfer carries that token in the command's own environment: a push
 *  never runs with the human's keychain, and no credential is written into a
 *  repository. What aivi does *locally* — creating a worktree, committing in
 *  one — is not on this class and never was a forge's business.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger, type Logger } from '@aivi/core';
import type {
  Forge,
  ForgeProject,
  ForgeSync,
  PrFacts,
  RepoRef,
  ReviewAuthor,
  ReviewFacts,
  ReviewThread,
} from '@aivi/plugin/forge';
import { type GitHubApp, gitCredential, runGit } from './github.ts';
import { httpsRemote, isGitHub, parseRemote } from './remote.ts';
import { parseWorker, signComment } from './signature.ts';

/** Who and what, out of the opaque `RepoRef` aivi hands back: the two parts of
 *  the forge's own name for a repository, which is all an API call needs. The
 *  remote URL is a separate matter — only a transfer reads it, and it reads it
 *  as the forge left it. */
function address(repo: RepoRef): { owner: string; repo: string } {
  const [owner, name] = repo.id.split('/');
  if (!owner || !name) throw new Error(`forge-github: ${repo.id} is not a repository this forge named`);
  return { owner, repo: name };
}

/** A pull request, in aivi's words. `id` is the pull number as GitHub's own
 *  string: what aivi carries and hands back, never interprets. The REST list
 *  read does not compute whether the merge is clean, and this forge does not
 *  guess what GitHub has not said: `unknown`. */
function prFacts(pull: {
  number: number;
  html_url: string;
  title: string;
  state: string;
  head: { ref: string };
}): PrFacts {
  return {
    id: String(pull.number),
    url: pull.html_url,
    title: pull.title,
    state: pull.state,
    branch: pull.head.ref,
    mergeable: 'unknown',
  };
}

interface GraphAuthor {
  login: string;
  __typename: string;
}
interface GraphComment {
  body: string;
  author: GraphAuthor | null;
  createdAt: string;
}
interface GraphThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  comments: { nodes: GraphComment[] };
}
interface GraphReview {
  state: string;
  author: GraphAuthor | null;
}
interface GraphPull {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName: string;
  mergeable: string | null;
  reviews: { nodes: GraphReview[] };
  reviewThreads: { nodes: GraphThread[] };
  comments: { nodes: GraphComment[] };
}

/** The review conversation in one read. GitHub keeps thread *resolution* in
 *  GraphQL alone — the REST review-comment endpoints show the comments but not
 *  the thread that holds them — so this is the shape of the answer, not a
 *  preference for one API over another. */
const REVIEW_FACTS_QUERY = /* GraphQL */ `
  query ReviewFacts($owner: String!, $repo: String!, $number: Int!, $threads: Int!, $comments: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        url
        title
        state
        headRefName
        mergeable
        reviews(last: 50) {
          nodes {
            state
            author { login __typename }
          }
        }
        reviewThreads(first: $threads) {
          nodes {
            id
            isResolved
            isOutdated
            path
            comments(first: $comments) {
              nodes {
                body
                author { login __typename }
              }
            }
          }
        }
        comments(first: $comments) {
          nodes {
            body
            createdAt
            author { login __typename }
          }
        }
      }
    }
  }
`;

/** Post a reply into an open thread. */
const REPLY_MUTATION = /* GraphQL */ `
  mutation ThreadReply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment {
        id
      }
    }
  }
`;

/** Close the thread the reply answered. GitHub offers no single mutation that
 *  does both, so an answer is two round trips: the words, then the resolution. */
const RESOLVE_MUTATION = /* GraphQL */ `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

/** Who wrote it, in aivi's words. A GitHub bot's login ends in `[bot]` and its
 *  author node is a `Bot`; a deleted account answers `null` and leaves nothing
 *  to attribute. */
function authorOf(node: GraphAuthor | null): ReviewAuthor {
  const login = node?.login ?? 'deleted';
  return { login, bot: node?.__typename === 'Bot' || login.endsWith('[bot]') };
}

/** The same, with the worker role read back out of what the comment itself
 *  says — the signature is the only carrier, and it is one a human reads. */
function authorOfComment(comment: GraphComment): ReviewAuthor {
  const author = authorOf(comment.author);
  const worker = parseWorker(comment.body);
  return worker ? { ...author, worker } : author;
}

/** One open thread, or nothing when it is settled: a wake takes what is open
 *  and owes nothing for what a person already resolved. */
function openThread(node: GraphThread): ReviewThread | undefined {
  if (node.isResolved) return undefined;
  const [first, ...rest] = node.comments.nodes;
  return {
    id: node.id,
    ...(node.path ? { path: node.path } : {}),
    state: node.isOutdated ? 'outdated' : 'open',
    question: first?.body ?? '',
    replies: rest.map(comment => ({ author: authorOfComment(comment), body: comment.body })),
  };
}

export class GitHubForge implements Forge {
  readonly app: GitHubApp;
  private readonly log: Logger;

  constructor(app: GitHubApp, log: Logger = getLogger(['aivi', 'forge-github'])) {
    this.app = app;
    this.log = log;
  }

  /** The checkout's own `origin`, read locally: a project aivi has never
   *  cloned is not less a project for it. Anything that is not a GitHub
   *  repository — another host, a local path, no remote at all — is answered
   *  with silence, because the answer belongs to another forge or to nobody. */
  async repoFor(project: ForgeProject): Promise<RepoRef | undefined> {
    const origin = await runGit(project.directory, ['remote', 'get-url', 'origin']);
    if (!origin.ok) return undefined;
    const remote = parseRemote(origin.stdout);
    if (!remote || !isGitHub(remote)) return undefined;
    // An ssh origin is said, not fixed: the person chose that transport for
    // their own reasons, and aivi's transfers go over HTTPS regardless.
    if (remote.ssh)
      this.log.debug('origin.ssh', { project: project.id, origin: origin.stdout, used: httpsRemote(remote) });
    return { id: `${remote.owner}/${remote.repo}`, remote: httpsRemote(remote) };
  }

  /** The newest pull request over the branch: a branch whose first attempt was
   *  closed and reopened has a live one and a dead one, and aivi means the
   *  live one. */
  async prForBranch(repo: RepoRef, branch: string): Promise<PrFacts | undefined> {
    const { owner, repo: name } = address(repo);
    const { data: found } = await this.app.octokit.rest.pulls.list({
      owner,
      repo: name,
      state: 'all',
      head: `${owner}:${branch}`,
      per_page: 5,
      direction: 'desc',
    });
    const newest = found[0];
    return newest ? prFacts(newest) : undefined;
  }

  /** Everything a review wake needs, in one read: the state of the approvals,
   *  the threads still open, and the plain conversation comments — context
   *  the worker reads but is never gated on. A pull request aivi cannot see
   *  is said, not answered empty — an empty review sends a worker away
   *  believing it is done. */
  async reviewFeedback(repo: RepoRef, pr: PrFacts): Promise<ReviewFacts> {
    const { owner, repo: name } = address(repo);
    const answer = await this.app.octokit.graphql<{ repository: { pullRequest: GraphPull | null } | null }>(
      REVIEW_FACTS_QUERY,
      { owner, repo: name, number: Number(pr.id), threads: 100, comments: 100 },
    );
    const pull = answer.repository?.pullRequest;
    if (!pull)
      throw new Error(
        `forge-github: pull request #${pr.id} of ${repo.id} is not visible to installation #${this.app.installationId}`,
      );
    return {
      pr: {
        id: String(pull.number),
        url: pull.url,
        title: pull.title,
        state: pull.state,
        branch: pull.headRefName,
        // GitHub's own word, in aivi's three: MERGEABLE is clean,
        // CONFLICTING is dirty, and a mergeability GitHub has not computed
        // yet (it computes on demand) is said as unknown, not guessed.
        mergeable: pull.mergeable === 'MERGEABLE' ? 'clean' : pull.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
      },
      reviews: pull.reviews.nodes.map(review => ({ author: authorOf(review.author), state: review.state })),
      threads: pull.reviewThreads.nodes.flatMap(node => {
        const thread = openThread(node);
        return thread ? [thread] : [];
      }),
      comments: pull.comments.nodes.map(comment => ({
        author: authorOfComment(comment),
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    };
  }

  /** Answer the thread as aivi, then resolve it: the worker's words, signed
   *  with the role that wrote them, closing the person's question. */
  async resolveThread(
    repo: RepoRef,
    _pr: PrFacts,
    threadId: string,
    reply: { author: string; text: string },
  ): Promise<void> {
    await this.app.octokit.graphql(REPLY_MUTATION, { threadId, body: signComment(reply.text, reply.author) });
    await this.app.octokit.graphql(RESOLVE_MUTATION, { threadId });
    this.log.info('review.answered', { repo: repo.id, thread: threadId, worker: reply.author });
  }

  /** A plain conversation comment, signed like every aivi post: what the
   *  worker says when there is no thread to answer. */
  async commentPr(repo: RepoRef, pr: PrFacts, comment: { author: string; text: string }): Promise<void> {
    const { owner, repo: name } = address(repo);
    await this.app.octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: Number(pr.id),
      body: signComment(comment.text, comment.author),
    });
    this.log.info('pull.commented', { repo: repo.id, pull: pr.id, worker: comment.author });
  }

  /** The review agent's teeth: findings on the lines themselves, which the
   *  platform shows as review threads — agent feedback that the next round's
   *  worker owes answers on. Every inline body carries the signature like
   *  every aivi post, so a wake can tell its own findings from a human's. */
  async submitReview(
    repo: RepoRef,
    pr: PrFacts,
    review: {
      author: string;
      body: string;
      state: 'COMMENT' | 'REQUEST_CHANGES';
      comments?: { path: string; line?: number; body: string }[];
    },
  ): Promise<void> {
    const { owner, repo: name } = address(repo);
    await this.app.octokit.rest.pulls.createReview({
      owner,
      repo: name,
      pull_number: Number(pr.id),
      event: review.state,
      body: signComment(review.body, review.author),
      ...(review.comments
        ? {
            comments: review.comments.map(finding => ({
              path: finding.path,
              ...(finding.line === undefined ? {} : { line: finding.line }),
              body: signComment(finding.body, review.author),
            })),
          }
        : {}),
    });
    this.log.info('review.submitted', {
      repo: repo.id,
      pull: pr.id,
      state: review.state,
      worker: review.author,
      findings: review.comments?.length ?? 0,
    });
  }

  /** The URL and credential for one transfer. The URL is the one this forge
   *  named when it claimed the project — HTTPS, whatever the checkout's own
   *  `origin` says, because an installation token authenticates HTTPS and
   *  nothing else — and it is used as given: re-reading it here would let a
   *  checkout's config decide where aivi's credential is sent. */
  private async transfer(repo: RepoRef): Promise<{ url: string; env: Record<string, string> }> {
    if (!repo.remote) throw new Error(`forge-github: ${repo.id} came with no remote to reach`);
    return { url: repo.remote, env: gitCredential(await this.app.gitToken()) };
  }

  /**
   * Fetch, then fast-forward — and stop at that. Every case that would need a
   * decision is reported with its reason: `source/` is the clean checkout
   * aivi indexes, not a working directory, so aivi never merges a conflict,
   * never discards a person's edit, and never rewrites history.
   *
   * The fetch names its refspec instead of trusting `origin`'s: the URL aivi
   * authenticates is HTTPS, which for an ssh checkout is not the URL
   * configured, and a fetch by URL updates only what its refspec names.
   */
  async syncSource(repo: RepoRef, directory: string): Promise<ForgeSync> {
    if (!(await stat(join(directory, '.git')).catch(() => null)))
      return { state: 'held', reason: 'not a git checkout' };
    const branch = await runGit(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch.ok || !branch.stdout) return { state: 'held', reason: 'detached HEAD' };
    const dirty = await runGit(directory, ['status', '--porcelain']);
    if (!dirty.ok) return { state: 'held', reason: dirty.message };
    if (dirty.stdout) return { state: 'held', reason: 'local changes in source/' };
    const name = `refs/remotes/origin/${branch.stdout}`;
    const transport = await this.transfer(repo);
    const fetched = await runGit(directory, ['fetch', '--quiet', transport.url, `+${branch.stdout}:${name}`], {
      env: transport.env,
    });
    if (!fetched.ok) return { state: 'held', reason: `fetch failed: ${fetched.message}` };
    const from = await runGit(directory, ['rev-parse', 'HEAD']);
    if (!from.ok) return { state: 'held', reason: from.message };
    const to = await runGit(directory, ['rev-parse', name]);
    if (!to.ok) return { state: 'held', reason: `branch ${branch.stdout} has no upstream` };
    if (from.stdout === to.stdout) return { state: 'current', from: from.stdout, to: to.stdout };
    const ahead = await runGit(directory, ['merge-base', '--is-ancestor', 'HEAD', name]);
    if (!ahead.ok) return { state: 'held', reason: `${branch.stdout} and ${name} have diverged; a person must decide` };
    const merged = await runGit(directory, ['merge', '--ff-only', '--quiet', name]);
    if (!merged.ok) return { state: 'held', reason: merged.message };
    this.log.info('source.synced', { repo: repo.id, from: from.stdout, to: to.stdout });
    return { state: 'updated', from: from.stdout, to: to.stdout };
  }

  /**
   * The one fetch the worktree machinery needs, and it is the forge's: the
   * refspec names the branch, the URL is the one this forge named when it
   * claimed the project, and the credential rides the environment — the
   * checkout's config stays untouched, as with every other transfer. A
   * remote without that branch answers "couldn't find remote ref", which is
   * the ordinary news of a ticket branch never pushed: said quietly, no
   * ref left behind. Anything else is a failed transfer, and it throws.
   */
  async fetchBranch(repo: RepoRef, directory: string, branch: string): Promise<void> {
    const transport = await this.transfer(repo);
    const fetched = await runGit(
      directory,
      ['fetch', '--quiet', transport.url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { env: transport.env },
    );
    if (fetched.ok) return;
    if (/couldn't find remote ref/i.test(fetched.message)) {
      this.log.debug('branch.absent', { repo: repo.id, branch });
      return;
    }
    throw new Error(`forge-github: fetching ${branch} from ${repo.id} failed: ${fetched.message}`);
  }

  /**
   * Move aivi's commits to the remote, as the app and never as the person at
   * the keyboard. Plain when the remote fast-forwards; with a
   * `--force-with-lease` keyed on the commit the orchestrator just fetched
   * when the divergence is the worker's own rewrite — the force replaces
   * exactly that commit and nothing a person added since.
   */
  async push(repo: RepoRef, worktree: string, branch: string, options: { lease?: string } = {}): Promise<void> {
    const transport = await this.transfer(repo);
    const pushed = await runGit(
      worktree,
      [
        'push',
        '--quiet',
        ...(options.lease ? [`--force-with-lease=refs/heads/${branch}:${options.lease}`] : []),
        transport.url,
        `HEAD:refs/heads/${branch}`,
      ],
      { env: transport.env },
    );
    if (!pushed.ok)
      throw new Error(
        `forge-github: pushing ${branch} to ${repo.id} failed${
          options.lease ? ' (the lease no longer matches: the remote moved since the last fetch)' : ''
        }: ${pushed.message}`,
      );
    this.log.info('branch.pushed', { repo: repo.id, branch, ...(options.lease ? { forced: true } : {}) });
  }

  /**
   * Open the pull request that stands for the branch. The base is the
   * repository's own default branch: that is where a pull request belongs
   * unless a person said otherwise, and aivi has no place to have been
   * told.
   */
  async openPr(repo: RepoRef, branch: string, pr: { author: string; title: string; body: string }): Promise<PrFacts> {
    const { owner, repo: name } = address(repo);
    const target = await this.app.repository(owner, name);
    if (!target)
      throw new Error(
        `forge-github: ${repo.id} is not readable through installation #${this.app.installationId}, so a pull request has no base`,
      );
    const { data: created } = await this.app.octokit.rest.pulls.create({
      owner,
      repo: name,
      head: branch,
      base: target.defaultBranch,
      title: pr.title,
      body: signComment(pr.body, pr.author),
    });
    this.log.info('pull.opened', { repo: repo.id, pull: created.number, worker: pr.author });
    return prFacts(created);
  }

  /** Every branch, pruned, refs only: the fresh view `aivi_sync` gives the
   *  worker and the push's lease starts from. Same transfer as every
   *  other — the URL this forge named, the credential in the environment,
   *  nothing left in the checkout's config. */
  async fetchRefs(repo: RepoRef, directory: string): Promise<void> {
    const transport = await this.transfer(repo);
    const fetched = await runGit(
      directory,
      ['fetch', '--prune', '--quiet', transport.url, '+refs/heads/*:refs/remotes/origin/*'],
      { env: transport.env },
    );
    if (!fetched.ok) throw new Error(`forge-github: fetching ${repo.id} failed: ${fetched.message}`);
  }
}

/** The forge for one installed app. */
export function createGitHubForge(app: GitHubApp, log?: Logger): GitHubForge {
  return new GitHubForge(app, log);
}
