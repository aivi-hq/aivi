/** The `Forge` answers, tested at both halves of the boundary they sit on: the
 *  facts read over the API against a GitHub that only says what was written
 *  here, and the transfers against a scripted git — every call the forge makes
 *  is on record with the environment it was handed, every answer belongs to the
 *  test. What these units pin is the forge's own decisions: the refspecs it
 *  names, the credential it carries in the environment and never in argv, the
 *  failures it classifies in a person's words. Whether git really moves the
 *  bytes is git's own unit and the live gate's subject (`npm run smoke`); a
 *  unit test that pays ten git spawns to learn git behaves like git pays for
 *  nothing.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RepoRef } from '@aivi/plugin/forge';
import { createGitHubForge, type GitHubForge } from '../src/forge.ts';
import type { GitRunner } from '../src/github.ts';
import { GitHubApp } from '../src/index.ts';
import type { Answer, Seen } from './github-api.ts';
import { installationToken, scripted } from './github-api.ts';

/** git as the forge sees it: every call on record — the argv and the
 *  environment it was handed — and every answer scripted by the test. A call
 *  nobody scripted is a loud failure, not silence. */
type GitReply = string | { fail: string };
const scriptedGit = (respond: (directory: string, args: string[]) => GitReply | undefined) => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const git: GitRunner = async (directory, args, options = {}) => {
    calls.push({ args, ...(options.env ? { env: options.env } : {}) });
    const reply = respond(directory, args);
    if (reply === undefined) throw new Error(`the forge ran git ${args.join(' ')}; the test scripted no answer`);
    return typeof reply === 'string' ? { ok: true, stdout: reply } : { ok: false, message: reply.fail };
  };
  return { git, calls };
};

/** The credential as it must travel: per-invocation config in the environment,
 *  the person's own helper switched off, and never a word of the token in argv
 *  where a process list would read it. */
const assertCredential = (env: Record<string, string> | undefined, args: string[]) => {
  assert.ok(env?.GIT_CONFIG_COUNT, 'the transfer carries its config in the environment');
  assert.equal(env?.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.match(String(env?.GIT_CONFIG_VALUE_0), /^Authorization: Basic /);
  assert.match(
    Buffer.from(String(env?.GIT_CONFIG_VALUE_0).replace('Authorization: Basic ', ''), 'base64').toString('utf8'),
    /^x-access-token:ghs_token/,
    'the installation token speaks, as Basic auth over HTTPS',
  );
  assert.equal(env?.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(
    env?.GIT_CONFIG_VALUE_1,
    '',
    "the person's stored credential is switched off, so no transfer attributes to them",
  );
  assert.ok(
    !args.some(arg => arg.includes('ghs_token') || arg.includes('x-access-token')),
    'the token never rides in argv',
  );
};

/** A directory that is a checkout as far as the forge's own stat can tell —
 *  `.git` exists. Everything past that line belongs to the scripted runner. */
const checkoutDir = async (): Promise<{ root: string; source: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-forge-'));
  const source = join(root, 'source');
  await mkdir(join(source, '.git'), { recursive: true });
  return { root, source };
};

/** A GitHub that answers the app's own reads, plus whatever the test writes;
 *  `git` is the transfer half the same test scripts. */
async function forgeWith(
  routes: Record<string, (call: Seen) => Answer>,
  git?: GitRunner,
): Promise<{
  forge: GitHubForge;
  calls: () => string[];
  seen: Seen[];
}> {
  const api = scripted({
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 99, account: { login: 'aivi-hq' } }] }),
    'POST /app/installations/99/access_tokens': () => installationToken(),
    ...routes,
  });
  const app = await GitHubApp.connect({ app: 7 }, { fetch: api.fetch });
  return { forge: git ? createGitHubForge(app, { git }) : createGitHubForge(app), calls: api.calls, seen: api.seen };
}

/** The pull request as GitHub's REST answer carries it. */
function pull(number = 12, ref = 'feat/retry') {
  return {
    number,
    html_url: `https://github.com/acme/widget/pull/${number}`,
    title: 'Retry the header',
    state: 'open',
    head: { ref },
  };
}

const REPO: RepoRef = { id: 'acme/widget', remote: 'https://github.com/acme/widget.git' };

/** One syncSource answer as the two words a person hears: state and reason. */
async function held(forge: GitHubForge, repo: RepoRef, directory: string): Promise<(string | undefined)[]> {
  const answer = await forge.syncSource(repo, directory);
  return [answer.state, answer.reason];
}

test('a project is the repository its origin names, and the URL aivi reaches it by is HTTPS', async () => {
  const origins = new Map([
    ['/ssh-checkout', 'git@github.com:acme/widget.git'],
    ['/https-checkout', 'https://github.com/acme/widget.git'],
  ]);
  const { git } = scriptedGit((directory, args) =>
    args[0] === 'remote' ? (origins.get(directory) ?? { fail: 'error: No such remote' }) : undefined,
  );
  const forge = (await forgeWith({}, git)).forge;
  assert.deepEqual(
    await forge.repoFor({ id: 'widget', directory: '/ssh-checkout' }),
    { id: 'acme/widget', remote: 'https://github.com/acme/widget.git' },
    'an ssh origin is said in HTTPS: the person chose that transport for themselves, aivi transfers go over HTTPS regardless',
  );
  assert.deepEqual(await forge.repoFor({ id: 'widget', directory: '/https-checkout' }), {
    id: 'acme/widget',
    remote: 'https://github.com/acme/widget.git',
  });
});

test('a checkout that names no GitHub repository is not this forge’s, and is not an error', async () => {
  const origins = new Map([
    // a local path: a checkout with nothing remote about it
    ['/local-path', '/people/own/origin.git'],
    // another host: another forge's turn
    ['/gitlab', 'https://gitlab.com/acme/widget.git'],
  ]);
  const { git } = scriptedGit((directory, args) =>
    args[0] === 'remote' ? (origins.get(directory) ?? { fail: 'error: No such remote' }) : undefined,
  );
  const forge = (await forgeWith({}, git)).forge;
  assert.equal(await forge.repoFor({ id: 'local', directory: '/local-path' }), undefined);
  assert.equal(await forge.repoFor({ id: 'gitlab', directory: '/gitlab' }), undefined);
  // a repository with no remote at all, and a directory that is not a checkout
  assert.equal(await forge.repoFor({ id: 'none', directory: '/no-remote' }), undefined);
  assert.equal(await forge.repoFor({ id: 'plain', directory: '/plain' }), undefined);
});

test('the pull request over a branch is asked for across every state, newest first', async () => {
  const forge = (await forgeWith({ 'GET /repos/acme/widget/pulls': () => ({ status: 200, body: [pull()] }) })).forge;
  assert.deepEqual(
    await forge.prForBranch(REPO, 'feat/retry'),
    {
      id: '12',
      url: 'https://github.com/acme/widget/pull/12',
      title: 'Retry the header',
      state: 'open',
      branch: 'feat/retry',
      mergeable: 'unknown',
    },
    'a list read says what it knows: GitHub has not been asked whether the merge is clean here',
  );
});

test('a branch with no pull request over it is answered as having none', async () => {
  const api = await forgeWith({ 'GET /repos/acme/widget/pulls': () => ({ status: 200, body: [] }) });
  assert.equal(await api.forge.prForBranch(REPO, 'feat/never'), undefined);
  const asked = new URL(`http://x${api.seen.find(call => call.path === '/repos/acme/widget/pulls')?.search ?? ''}`);
  assert.equal(asked.searchParams.get('state'), 'all', 'a merged pull request is still the one over the branch');
  assert.equal(asked.searchParams.get('head'), 'acme:feat/never');
  assert.equal(asked.searchParams.get('direction'), 'desc', 'the newest is the live one');
});

const REVIEW_ANSWER = {
  repository: {
    pullRequest: {
      number: 12,
      url: 'https://github.com/acme/widget/pull/12',
      title: 'Retry the header',
      state: 'open',
      headRefName: 'feat/retry',
      mergeable: 'CONFLICTING',
      reviews: {
        nodes: [
          { state: 'CHANGES_REQUESTED', author: { login: 'octocat', __typename: 'User' } },
          { state: 'COMMENTED', author: { login: 'aivi-agent[bot]', __typename: 'Bot' } },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            id: 'PRRT_1',
            isResolved: true,
            isOutdated: false,
            path: 'src/closed.ts',
            comments: { nodes: [{ body: 'Already settled.', author: { login: 'octocat', __typename: 'User' } }] },
          },
          {
            id: 'PRRT_2',
            isResolved: false,
            isOutdated: true,
            path: 'src/moved.ts',
            comments: { nodes: [{ body: 'This line moved.', author: { login: 'octocat', __typename: 'User' } }] },
          },
          {
            id: 'PRRT_3',
            isResolved: false,
            isOutdated: false,
            path: 'src/header.ts',
            comments: {
              nodes: [
                { body: 'Why is this nil?', author: { login: 'octocat', __typename: 'User' } },
                {
                  body: 'It is nil until the retry lands.\n\n---\n\n_worker: aivi · review_',
                  author: { login: 'aivi-agent[bot]', __typename: 'Bot' },
                },
                { body: 'Please say so in the code.', author: { login: 'octocat', __typename: 'User' } },
              ],
            },
          },
        ],
      },
      comments: {
        nodes: [
          {
            body: 'Overall this reads well, is the retry bounded?',
            createdAt: '2026-10-01T09:00:00Z',
            author: { login: 'octocat', __typename: 'User' },
          },
          {
            body: 'Bounded at three attempts.\n\n---\n\n_worker: aivi · implement_',
            createdAt: '2026-10-01T10:00:00Z',
            author: { login: 'aivi-agent[bot]', __typename: 'Bot' },
          },
        ],
      },
    },
  },
};

test('a review wake gets what is open: the approvals, and only the threads still owed', async () => {
  const api = await forgeWith({ 'POST /graphql': () => ({ status: 200, body: { data: REVIEW_ANSWER } }) });
  const facts = await api.forge.reviewFeedback(REPO, {
    id: '12',
    url: 'https://github.com/acme/widget/pull/12',
    title: 'Retry the header',
    state: 'open',
    branch: 'feat/retry',
  });

  assert.deepEqual(
    facts.pr,
    {
      id: '12',
      url: 'https://github.com/acme/widget/pull/12',
      title: 'Retry the header',
      state: 'open',
      branch: 'feat/retry',
      mergeable: 'dirty',
    },
    'GitHub said CONFLICTING, aivi says dirty: the worker hears “main moved, you conflict” at its start',
  );
  assert.deepEqual(facts.reviews, [
    { author: { login: 'octocat', bot: false }, state: 'CHANGES_REQUESTED' },
    { author: { login: 'aivi-agent[bot]', bot: true }, state: 'COMMENTED' },
  ]);
  assert.deepEqual(
    facts.comments.map(c => [c.author.login, c.author.worker, c.body.split('\n')[0], c.createdAt]),
    [
      ['octocat', undefined, 'Overall this reads well, is the retry bounded?', '2026-10-01T09:00:00Z'],
      ['aivi-agent[bot]', 'implement', 'Bounded at three attempts.', '2026-10-01T10:00:00Z'],
    ],
    'plain conversation comments ride the read, oldest first, aivi’s own read back from its signature',
  );
  assert.deepEqual(
    facts.threads.map(thread => [thread.id, thread.state]),
    [
      ['PRRT_2', 'outdated'],
      ['PRRT_3', 'open'],
    ],
    'a resolved thread is nothing a worker owes',
  );
  const open = facts.threads[1];
  assert.equal(open?.path, 'src/header.ts');
  assert.equal(open?.question, 'Why is this nil?', 'the thread opens with the person’s question');
  assert.deepEqual(
    open?.replies.map(reply => [reply.author.login, reply.author.worker, reply.author.bot]),
    [
      ['aivi-agent[bot]', 'review', true],
      ['octocat', undefined, false],
    ],
    'aivi’s own comment is read back as its worker; the person’s reply is not',
  );
  assert.deepEqual(
    api.calls().filter(path => path.endsWith('/graphql')),
    ['POST /graphql'],
    'the whole review in one read',
  );
});

test('a pull request aivi cannot see is said, not answered empty: an empty review sends a worker away believing it is done', async () => {
  const api = await forgeWith({ 'POST /graphql': () => ({ status: 200, body: { data: { repository: null } } }) });
  const pr = { id: '12', url: 'x', title: 't', state: 'open', branch: 'feat/retry' };
  await assert.rejects(api.forge.reviewFeedback(REPO, pr), /pull request #12 of acme\/widget is not visible/);
});

test('answering a thread posts the worker’s signed words, then resolves it', async () => {
  const asked: string[] = [];
  const api = await forgeWith({
    'POST /graphql': call => {
      const body = JSON.parse(call.body ?? '{}') as { query: string; variables: Record<string, unknown> };
      asked.push(body.query.includes('addPullRequestReviewThreadReply') ? 'reply' : 'resolve');
      return { status: 200, body: { data: {} } };
    },
  });
  await api.forge.resolveThread(
    REPO,
    { id: '12', url: 'x', title: 't', state: 'open', branch: 'feat/retry' },
    'PRRT_3',
    {
      author: 'review',
      text: 'It is nil until the retry lands; a comment now says why.',
    },
  );

  assert.deepEqual(asked, ['reply', 'resolve'], 'the words first, then the resolution');
  const reply = api.seen.filter(call => call.path === '/graphql').map(call => JSON.parse(call.body ?? '{}'));
  const posted = reply.find(call => String(call.variables?.threadId) === 'PRRT_3' && call.variables?.body) as {
    variables: { body: string };
  };
  assert.equal(
    posted.variables.body,
    'It is nil until the retry lands; a comment now says why.\n\n---\n\n_worker: aivi · review_',
    'the posted comment names the worker that wrote it, in the text a person reads',
  );
});

test('a plain comment lands on the pull request’s conversation, signed like every aivi post', async () => {
  const api = await forgeWith({ 'POST /repos/acme/widget/issues/12/comments': () => ({ status: 201, body: {} }) });
  await api.forge.commentPr(
    REPO,
    { id: '12', url: 'x', title: 't', state: 'open', branch: 'feat/retry' },
    { author: 'implement', text: 'Rebased over main; the retry bound is three attempts.' },
  );
  const posted = JSON.parse(
    api.seen.find(call => call.method === 'POST' && call.path.endsWith('/comments'))?.body ?? '{}',
  );
  assert.equal(
    posted.body,
    'Rebased over main; the retry bound is three attempts.\n\n---\n\n_worker: aivi · implement_',
    'the conversation knows which worker spoke',
  );
});

test('a review lands on the lines themselves, and APPROVE is not a thing aivi can post', async () => {
  const posted: Record<string, unknown>[] = [];
  const api = await forgeWith({
    'POST /repos/acme/widget/pulls/12/reviews': call => {
      posted.push(JSON.parse(call.body ?? '{}'));
      return { status: 201, body: pull() };
    },
  });
  await api.forge.submitReview(
    REPO,
    { id: '12', url: 'x', title: 't', state: 'open', branch: 'feat/retry' },
    {
      author: 'review',
      state: 'REQUEST_CHANGES',
      body: 'Two problems, on the lines.',
      comments: [
        { path: 'src/header.ts', line: 42, body: 'This retry is unbounded.' },
        { path: 'src/nil.ts', body: 'Nil here speaks to nothing.' },
      ],
    },
  );
  assert.equal(posted[0]?.event, 'REQUEST_CHANGES');
  assert.equal(
    posted[0]?.body,
    'Two problems, on the lines.\n\n---\n\n_worker: aivi · review_',
    'the review says which worker wrote it',
  );
  assert.deepEqual(
    posted[0]?.comments,
    [
      { path: 'src/header.ts', line: 42, body: 'This retry is unbounded.\n\n---\n\n_worker: aivi · review_' },
      { path: 'src/nil.ts', body: 'Nil here speaks to nothing.\n\n---\n\n_worker: aivi · review_' },
    ],
    'inline findings are signed too: they become review threads the next worker owes',
  );
  // And a verdict without findings is still a review: the words alone say
  // something. (APPROVE is not even expressible here — the kit's type stops
  // it before this file, because the app author can never approve anyway.)
  await api.forge.submitReview(
    REPO,
    { id: '12', url: 'x', title: 't', state: 'open', branch: 'feat/retry' },
    { author: 'review', body: 'readable overall', state: 'COMMENT' },
  );
  assert.equal(posted[1]?.event, 'COMMENT');
  assert.ok(!('comments' in (posted[1] ?? {})), 'no findings, no comments field');
});

test('a clean checkout is brought up to date by a fast-forward and nothing else', async () => {
  const { source } = await checkoutDir();
  let head = 'aaa111';
  const { git, calls } = scriptedGit((_directory, args) => {
    switch (args[0]) {
      case 'symbolic-ref':
        return 'main';
      case 'status':
        return ''; // clean: the checkout is aivi's to move
      case 'fetch':
        return '';
      case 'rev-parse':
        return args[1] === 'HEAD' ? head : 'bbb222';
      case 'merge-base':
        return ''; // HEAD is an ancestor of the fetched tip: a fast-forward stands
      case 'merge':
        head = 'bbb222';
        return '';
    }
  });
  const forge = (await forgeWith({}, git)).forge;

  const updated = await forge.syncSource(REPO, source);
  assert.deepEqual(updated, { state: 'updated', from: 'aaa111', to: 'bbb222' });
  const fetch = calls.find(call => call.args[0] === 'fetch');
  assert.deepEqual(
    fetch?.args,
    ['fetch', '--quiet', REPO.remote, '+main:refs/remotes/origin/main'],
    'the fetch names its refspec instead of trusting origin’s, over the HTTPS url aivi authenticates',
  );
  assertCredential(fetch?.env, fetch?.args ?? []);
  assert.ok(
    calls.some(call => call.args.join(' ') === 'merge --ff-only --quiet refs/remotes/origin/main'),
    'a fast-forward is the only merge aivi performs',
  );

  // The same sync again: the tip has arrived, so the answer is “current” and
  // no merge is asked of git a second time.
  const again = await forge.syncSource(REPO, source);
  assert.deepEqual(again, { state: 'current', from: 'bbb222', to: 'bbb222' });
  assert.equal(calls.filter(call => call.args[0] === 'merge').length, 1, 'current says current: nothing runs');
});

test('what aivi’s transfers carry: the credential in the environment, never in argv, never as a config write', async () => {
  const { source } = await checkoutDir();
  const { git, calls } = scriptedGit((_directory, args) => (args[0] === 'push' ? '' : undefined));
  const forge = (await forgeWith({}, git)).forge;
  await forge.push(REPO, source, 'feat/retry');
  assert.equal(calls.length, 1);
  assertCredential(calls[0]?.env, calls[0]?.args ?? []);
  assert.ok(
    !calls.some(call => call.args[0] === 'config' || call.args.includes('-c')),
    'no git config is ever written: the checkout keeps the shape its owner left it',
  );
});

test('anything that would need a decision is reported, never forced', async () => {
  const { source } = await checkoutDir();
  const heldBy = async (respond: (directory: string, args: string[]) => GitReply | undefined) =>
    held((await forgeWith({}, scriptedGit(respond).git)).forge, REPO, source);

  // a person's uncommitted edit: nothing is stashed, nothing is discarded
  assert.deepEqual(
    await heldBy((_directory, args) =>
      args[0] === 'symbolic-ref' ? 'main' : args[0] === 'status' ? '?? notes.md\n' : undefined,
    ),
    ['held', 'local changes in source/'],
  );

  // history that has diverged: a local commit and an upstream one. The
  // fast-forward test fails, and aivi stops there — no merge, no rebase.
  assert.deepEqual(
    await heldBy((_directory, args) => {
      if (args[0] === 'symbolic-ref') return 'main';
      if (args[0] === 'status') return '';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'aaa111' : 'bbb222';
      if (args[0] === 'merge-base') return { fail: 'not a git commit -- bbb222' };
      return undefined;
    }),
    ['held', 'main and refs/remotes/origin/main have diverged; a person must decide'],
  );

  // a detached HEAD, which has no branch to fast-forward
  assert.deepEqual(await heldBy((_directory, args) => (args[0] === 'symbolic-ref' ? { fail: '' } : undefined)), [
    'held',
    'detached HEAD',
  ]);
});

test('a directory that is not a checkout is held with that reason, not a git complaint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-forge-'));
  const plain = join(root, 'source');
  await mkdir(plain, { recursive: true });
  const forge = (await forgeWith({})).forge;
  assert.deepEqual(await held(forge, { id: 'acme/widget', remote: join(root, 'nowhere.git') }, plain), [
    'held',
    'not a git checkout',
  ]);
});

test('fetchBranch carries one branch’s remote tip into the checkout’s refs and moves nothing else', async () => {
  const { git, calls } = scriptedGit((_directory, args) => (args[0] === 'fetch' ? '' : undefined));
  const forge = (await forgeWith({}, git)).forge;
  // A person pushed a ticket branch from elsewhere; one fetch names it.
  await forge.fetchBranch(REPO, '/checkout', 'me/eng-7-fix');
  assert.equal(calls.length, 1, 'one fetch is the whole crossing: no file moves, nothing is checked out');
  assert.deepEqual(
    calls[0]?.args,
    ['fetch', '--quiet', REPO.remote, '+refs/heads/me/eng-7-fix:refs/remotes/origin/me/eng-7-fix'],
    'the refspec names the branch and nothing else arrives; the checkout stays on its own branch',
  );
  assertCredential(calls[0]?.env, calls[0]?.args ?? []);
});

test('a remote without that branch is an answer, not a failure — and a failed fetch is said', async () => {
  // “couldn't find remote ref” is the ordinary news of a ticket branch never
  // pushed: said quietly in the log, no ref left behind — and there is no
  // second git call that could leave one, which is what the record shows.
  const absent = scriptedGit(() => ({ fail: "fatal: couldn't find remote ref me/eng-8-never" }));
  const forge = (await forgeWith({}, absent.git)).forge;
  await forge.fetchBranch(REPO, '/checkout', 'me/eng-8-never');
  assert.equal(absent.calls.length, 1, 'the answer is quiet: nothing else ran to clean up after it');

  // Anything else is a failed transfer. The caller cannot tell a stale tip
  // from an absent one, so this failure is not swallowed.
  const failing = scriptedGit(() => ({ fail: 'fatal: unable to access the remote' }));
  const other = (await forgeWith({}, failing.git)).forge;
  await assert.rejects(
    () => other.fetchBranch(REPO, '/checkout', 'me/eng-7'),
    /fetching me\/eng-7 from acme\/widget failed: fatal: unable to access/,
  );
});

test('a push moves aivi’s commits to the remote, and the platform’s API is not so much as glanced at', async () => {
  const { git, calls } = scriptedGit((_directory, args) => (args[0] === 'push' ? '' : undefined));
  const api = await forgeWith({}, git);
  await api.forge.push(REPO, '/checkout', 'main');
  assert.deepEqual(
    calls[0]?.args,
    ['push', '--quiet', REPO.remote, 'HEAD:refs/heads/main'],
    'plain when the remote fast-forwards: the refspec names the branch, the url is the one this forge named',
  );
  assertCredential(calls[0]?.env, calls[0]?.args ?? []);
  assert.deepEqual(
    api.seen.filter(call => call.method === 'POST').map(call => `${call.method} ${call.path}`),
    ['POST /app/installations/99/access_tokens'],
    'nothing was posted to GitHub beyond the token',
  );
});

test('openPr opens the pull request on the repository’s own default branch, signed by the worker who wrote it', async () => {
  let created: Record<string, unknown> | undefined;
  const api = await forgeWith({
    'GET /repos/acme/widget': () => ({ status: 200, body: { default_branch: 'trunk', name: 'widget' } }),
    'POST /repos/acme/widget/pulls': call => {
      created = JSON.parse(call.body ?? '{}');
      return { status: 201, body: pull(31, 'feat/retry') };
    },
  });

  const facts = await api.forge.openPr(REPO, 'feat/retry', {
    author: 'implement',
    title: 'Retry the header',
    body: 'The header now retries.',
  });
  assert.deepEqual(facts, {
    id: '31',
    url: 'https://github.com/acme/widget/pull/31',
    title: 'Retry the header',
    state: 'open',
    branch: 'feat/retry',
    mergeable: 'unknown',
  });
  assert.equal(created?.base, 'trunk', 'the base is the repository’s default branch, not a guess');
  assert.equal(created?.head, 'feat/retry');
  assert.equal(
    created?.body,
    'The header now retries.\n\n---\n\n_worker: aivi · implement_',
    'a pull request aivi opened says which worker opened it',
  );
});

test('a second pull request over a branch is the platform’s refusal to say, not aivi’s to smooth over', async () => {
  const api = await forgeWith({
    'GET /repos/acme/widget': () => ({ status: 200, body: { default_branch: 'main', name: 'widget' } }),
    'POST /repos/acme/widget/pulls': () => ({
      status: 422,
      body: { message: 'a pull request is already open for this branch' },
    }),
  });
  await assert.rejects(
    api.forge.openPr(REPO, 'feat/retry', {
      author: 'implement',
      title: 'Retry the header',
      body: 'again',
    }),
    /already open/,
  );
});

test('a rebased branch forces through on its lease, and a stale lease is refused, not swallowed', async () => {
  // A ticket branch the worker rewrote: a plain push is refused where the
  // remote will not fast-forward, a push keyed on the fetched tip goes
  // through — the force replaces exactly that commit and nothing a person
  // added since.
  const { git, calls } = scriptedGit((_directory, args) =>
    args[0] !== 'push'
      ? undefined
      : args.some(arg => arg.startsWith('--force-with-lease'))
        ? ''
        : { fail: 'rejected (non-fast-forward)' },
  );
  const forge = (await forgeWith({}, git)).forge;
  await assert.rejects(() => forge.push(REPO, '/checkout', 'feat/retry'), /pushing feat\/retry to acme\/widget failed/);
  await forge.push(REPO, '/checkout', 'feat/retry', { lease: 'the-fetched-tip' });
  assert.deepEqual(
    calls[1]?.args,
    [
      'push',
      '--quiet',
      '--force-with-lease=refs/heads/feat/retry:the-fetched-tip',
      REPO.remote,
      'HEAD:refs/heads/feat/retry',
    ],
    'the rewrite stands on the remote through a lease keyed on the commit the caller just fetched',
  );

  // A lease that no longer matches — the remote moved under the caller, as a
  // person's own push makes the push non-fast-forward again — is said with
  // its meaning, and a fresh lease from the next fetch gets the worker moving.
  const stale = scriptedGit(() => ({ fail: 'stale info' }));
  const other = (await forgeWith({}, stale.git)).forge;
  await assert.rejects(
    () => other.push(REPO, '/checkout', 'feat/retry', { lease: 'the-old-tip' }),
    /lease no longer matches: the remote moved since the last fetch/,
  );
});

test('fetchRefs brings every branch in, prunes the deleted, and moves no files', async () => {
  const { git, calls } = scriptedGit((_directory, args) => (args[0] === 'fetch' ? '' : undefined));
  const forge = (await forgeWith({}, git)).forge;
  await forge.fetchRefs(REPO, '/checkout');
  assert.equal(calls.length, 1, 'one fetch is the whole crossing: nothing was checked out, no file moved');
  assert.deepEqual(
    calls[0]?.args,
    ['fetch', '--prune', '--quiet', REPO.remote, '+refs/heads/*:refs/remotes/origin/*'],
    'every branch in, the deleted pruned away — a branch that dies upstream leaves the checkout’s refs too',
  );
  assertCredential(calls[0]?.env, calls[0]?.args ?? []);
});

test('a push that the remote refuses is said with git’s words, not swallowed', async () => {
  const { git } = scriptedGit(() => ({ fail: 'remote: Permission to acme/widget.git denied to aivi-agent[bot]' }));
  const forge = (await forgeWith({}, git)).forge;
  await assert.rejects(
    () => forge.push(REPO, '/checkout', 'main'),
    /pushing main to acme\/widget failed: remote: Permission/,
  );
});
