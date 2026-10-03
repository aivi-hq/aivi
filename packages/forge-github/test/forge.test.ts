/** The `Forge` answers over the API, read against a GitHub that only says what
 *  was written here. The git transfers are not tested in this file: they are
 *  real git doing real byte-moving, which is git's own unit — and the live
 *  gate's subject (`npm run smoke` drives the real bin against real remotes),
 *  not a unit test's. What would need a source seam to fake, this file does
 *  not carry.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RepoRef } from '@aivi/plugin/forge';
import { createGitHubForge, type GitHubForge } from '../src/forge.ts';
import { GitHubApp } from '../src/index.ts';
import type { Answer, Seen } from './github-api.ts';
import { installationToken, scripted } from './github-api.ts';

/** A GitHub that answers the app's own reads, plus whatever the test writes. */
async function forgeWith(routes: Record<string, (call: Seen) => Answer>): Promise<{
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
  return { forge: createGitHubForge(app), calls: api.calls, seen: api.seen };
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

async function held(forge: GitHubForge, repo: RepoRef, directory: string): Promise<(string | undefined)[]> {
  const answer = await forge.syncSource(repo, directory);
  return [answer.state, answer.reason];
}

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
