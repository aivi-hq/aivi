/** The `Forge` answers, tested at both halves of the boundary they sit on: the
 *  facts read over the API against a GitHub that only says what was written
 *  here, and the transfers against a real git repository on disk whose `origin`
 *  is a local path — so the bytes really move, nothing reaches a network, and
 *  what the transfers leave behind in the checkout is observable.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { RepoRef } from '@aivi/plugin/forge';
import { createGitHubForge, type GitHubForge } from '../src/forge.ts';
import { GitHubApp } from '../src/index.ts';
import type { Answer, Seen } from './github-api.ts';
import { installationToken, scripted } from './github-api.ts';

const run = promisify(execFile);

/** git as a person would run it, in a directory of the test's own. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** An identity for the commits a test makes, so git never reaches for one. */
const AS = ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev'];

/** A repository as a person leaves it: a bare `origin.git` holding `main` with
 *  one commit, and a clean `source/` checkout of it. */
async function checkout(): Promise<{ root: string; origin: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aivi-forge-'));
  const origin = join(root, 'origin.git');
  await run('git', ['init', '--bare', '--initial-branch=main', origin]);
  const seed = join(root, 'seed');
  await run('git', ['init', '--initial-branch=main', seed]);
  await writeFile(join(seed, 'README.md'), '# widget\n');
  await git(seed, 'add', '.');
  await git(seed, ...AS, 'commit', '--quiet', '-m', 'first');
  await git(seed, 'push', '--quiet', origin, 'HEAD:refs/heads/main');
  await run('git', ['clone', '--quiet', origin, join(root, 'source')]);
  return { root, origin, source: join(root, 'source') };
}

/** One commit added to the far side, as a person pushing from elsewhere. */
async function commitUpstream(origin: string, root: string, message: string): Promise<string> {
  const seed = join(root, 'seed');
  await writeFile(join(seed, 'README.md'), `# widget\n\n${message}\n`);
  await git(seed, 'add', '.');
  await git(seed, ...AS, 'commit', '--quiet', '-m', message);
  await git(seed, 'push', '--quiet', origin, 'HEAD:refs/heads/main');
  return git(origin, 'rev-parse', 'refs/heads/main');
}

/** What the checkout's own config says — the place aivi's credential must
 *  never appear. */
async function gitConfig(directory: string): Promise<string> {
  return readFile(join(directory, '.git', 'config'), 'utf8');
}

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

test('a project is the repository its origin names, and the URL aivi reaches it by is HTTPS', async () => {
  const { root } = await checkout();
  const ssh = join(root, 'ssh-checkout');
  await run('git', ['init', '--initial-branch=main', ssh]);
  await git(ssh, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
  const https = join(root, 'https-checkout');
  await run('git', ['init', '--initial-branch=main', https]);
  await git(https, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git');

  const forge = (await forgeWith({})).forge;
  assert.deepEqual(await forge.repoFor({ id: 'widget', directory: ssh }), {
    id: 'acme/widget',
    remote: 'https://github.com/acme/widget.git',
  });
  assert.deepEqual(await forge.repoFor({ id: 'widget', directory: https }), {
    id: 'acme/widget',
    remote: 'https://github.com/acme/widget.git',
  });
});

test('a checkout that names no GitHub repository is not this forge’s, and is not an error', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;

  // a local path: a checkout with nothing remote about it
  assert.equal(await forge.repoFor({ id: 'local', directory: source }), undefined);
  // another host: another forge's turn
  const gitlab = join(root, 'gitlab');
  await run('git', ['init', gitlab]);
  await git(gitlab, 'remote', 'add', 'origin', 'https://gitlab.com/acme/widget.git');
  assert.equal(await forge.repoFor({ id: 'gitlab', directory: gitlab }), undefined);
  // a repository with no remote at all, and a directory that is not a checkout
  const bare = join(root, 'no-remote');
  await run('git', ['init', bare]);
  assert.equal(await forge.repoFor({ id: 'none', directory: bare }), undefined);
  const plain = join(root, 'plain');
  await mkdir(plain, { recursive: true });
  assert.equal(await forge.repoFor({ id: 'plain', directory: plain }), undefined);
  assert.equal(await git(origin, 'rev-parse', '--is-bare-repository'), 'true');
});

test('the pull request over a branch is asked for across every state, newest first', async () => {
  const forge = (await forgeWith({ 'GET /repos/acme/widget/pulls': () => ({ status: 200, body: [pull()] }) })).forge;
  assert.deepEqual(await forge.prForBranch(REPO, 'feat/retry'), {
    id: '12',
    url: 'https://github.com/acme/widget/pull/12',
    title: 'Retry the header',
    state: 'open',
    branch: 'feat/retry',
  });
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

  assert.deepEqual(facts.pr, {
    id: '12',
    url: 'https://github.com/acme/widget/pull/12',
    title: 'Retry the header',
    state: 'open',
    branch: 'feat/retry',
  });
  assert.deepEqual(facts.reviews, [
    { author: { login: 'octocat', bot: false }, state: 'CHANGES_REQUESTED' },
    { author: { login: 'aivi-agent[bot]', bot: true }, state: 'COMMENTED' },
  ]);
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

test('a clean checkout is brought up to date, and the files move with it', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  const repo: RepoRef = { id: 'acme/widget', remote: origin };

  const moved = await commitUpstream(origin, root, 'The header now retries.');
  const first = await forge.syncSource(repo, source);
  assert.equal(first.state, 'updated');
  assert.equal(first.to, moved);
  assert.match(await readFile(join(source, 'README.md'), 'utf8'), /The header now retries\./);

  const again = await forge.syncSource(repo, source);
  assert.deepEqual(again, { state: 'current', from: moved, to: moved });
});

test('what aivi’s transfer leaves in the checkout’s config: nothing', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  await commitUpstream(origin, root, 'A second commit upstream.');
  const synced = await forge.syncSource({ id: 'acme/widget', remote: origin }, source);
  assert.equal(synced.state, 'updated');
  const written = await gitConfig(source);
  assert.ok(!written.includes('x-access-token'), written);
  assert.ok(!written.includes('ghs_token'), written);
  assert.ok(!written.includes('extraHeader'), written);
  assert.ok(!written.includes('insteadOf'), written);
});

test('anything that would need a decision is reported, never forced', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  const repo: RepoRef = { id: 'acme/widget', remote: origin };

  // a person's uncommitted edit
  await writeFile(join(source, 'notes.md'), 'mine\n');
  assert.deepEqual(await held(forge, repo, source), ['held', 'local changes in source/']);
  await run('git', ['-C', source, 'clean', '-fd']);

  // history that has diverged: a local commit and an upstream one
  await writeFile(join(source, 'local.md'), 'mine\n');
  await git(source, 'add', '.');
  await git(source, ...AS, 'commit', '--quiet', '-m', 'a local commit');
  await commitUpstream(origin, root, 'An upstream commit.');
  const diverged = await forge.syncSource(repo, source);
  assert.equal(diverged.state, 'held');
  assert.match(diverged.reason ?? '', /have diverged/);

  // a detached HEAD, which has no branch to fast-forward
  await git(source, 'checkout', '--quiet', '--detach', 'HEAD');
  assert.deepEqual(await held(forge, repo, source), ['held', 'detached HEAD']);
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

test('fetchBranch carries one branch’s remote tip into the checkout’s refs and moves nothing else', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  // A person pushes a ticket branch from elsewhere.
  const seed = join(root, 'seed');
  await writeFile(join(seed, 'ticket.md'), 'the work\n');
  await git(seed, 'add', '.');
  await git(seed, ...AS, 'commit', '--quiet', '-m', 'ticket work');
  await git(seed, 'push', '--quiet', origin, 'HEAD:refs/heads/me/eng-7-fix');
  const tip = await git(origin, 'rev-parse', 'refs/heads/me/eng-7-fix');

  await forge.fetchBranch({ id: 'acme/widget', remote: origin }, source, 'me/eng-7-fix');
  assert.equal(await git(source, 'rev-parse', '--verify', 'refs/remotes/origin/me/eng-7-fix'), tip);
  assert.equal(await git(source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the checkout stays on its branch');
  await assert.rejects(
    () => readFile(join(source, 'ticket.md'), 'utf8'),
    'no files move: the ref is the only thing that arrives',
  );
  const written = await gitConfig(source);
  assert.ok(!written.includes('ghs_token'), written);
});

test('a remote without that branch is an answer, not a failure — and a failed fetch is said', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  await forge.fetchBranch({ id: 'acme/widget', remote: origin }, source, 'me/eng-8-never');
  assert.equal(
    (
      await run('git', ['-C', source, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/me/eng-8-never'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).catch(() => null)
    )?.stdout.trim() ?? '',
    '',
    'no ref left behind for a branch that never was',
  );
  await assert.rejects(
    () => forge.fetchBranch({ id: 'acme/widget', remote: join(root, 'gone.git') }, source, 'me/eng-7'),
    /fetching me\/eng-7 from acme\/widget failed/,
    'the caller cannot tell a stale tip from an absent one, so this failure is not swallowed',
  );
});

test('a push moves aivi’s commits to the remote, and the platform’s API is not so much as glanced at', async () => {
  const { origin, source } = await checkout();
  const api = await forgeWith({});
  await writeFile(join(source, 'work.md'), 'aivi’s work\n');
  await git(source, 'add', '.');
  await git(source, ...AS, 'commit', '--quiet', '-m', 'worker: the work');

  await api.forge.push({ id: 'acme/widget', remote: origin }, source, 'main');
  assert.equal(await git(source, 'rev-parse', 'HEAD'), await git(origin, 'rev-parse', 'refs/heads/main'));
  assert.deepEqual(
    api.seen.filter(call => call.method === 'POST').map(call => `${call.method} ${call.path}`),
    ['POST /app/installations/99/access_tokens'],
    'nothing was posted to GitHub beyond the token',
  );
  assert.ok(!(await gitConfig(source)).includes('ghs_token'), 'the credential is left nowhere');
});

test('openPr opens the pull request on the repository’s own default branch, signed by the worker who wrote it', async () => {
  const { origin, source } = await checkout();
  let created: Record<string, unknown> | undefined;
  const api = await forgeWith({
    'GET /repos/acme/widget': () => ({ status: 200, body: { default_branch: 'trunk', name: 'widget' } }),
    'POST /repos/acme/widget/pulls': call => {
      created = JSON.parse(call.body ?? '{}');
      return { status: 201, body: pull(31, 'feat/retry') };
    },
  });
  await git(source, ...AS, 'commit', '--quiet', '--allow-empty', '-m', 'worker: the work');

  const facts = await api.forge.openPr({ id: 'acme/widget', remote: origin }, 'feat/retry', {
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
  const { origin, source } = await checkout();
  const api = await forgeWith({
    'GET /repos/acme/widget': () => ({ status: 200, body: { default_branch: 'main', name: 'widget' } }),
    'POST /repos/acme/widget/pulls': () => ({
      status: 422,
      body: { message: 'a pull request is already open for this branch' },
    }),
  });
  await assert.rejects(
    api.forge.openPr({ id: 'acme/widget', remote: origin }, 'feat/retry', {
      author: 'implement',
      title: 'Retry the header',
      body: 'again',
    }),
    /already open/,
  );
});

test('a rebased branch forces through on its lease, and a stale lease is refused, not swallowed', async () => {
  const { origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  const repo: RepoRef = { id: 'acme/widget', remote: origin };
  // A ticket branch, then the worker rewrites it: a plain push is refused,
  // a push on the fetched tip goes through.
  await git(source, ...AS, 'checkout', '-q', '-b', 'feat/retry');
  await git(source, ...AS, 'commit', '--quiet', '--allow-empty', '-m', 'one');
  await forge.push(repo, source, 'feat/retry');
  const tip = await git(origin, 'rev-parse', 'refs/heads/feat/retry');
  await git(source, ...AS, 'commit', '--quiet', '--amend', '--allow-empty', '-m', 'one, rewritten');
  await assert.rejects(() => forge.push(repo, source, 'feat/retry'), /pushing feat\/retry to acme\/widget failed/);
  await forge.push(repo, source, 'feat/retry', { lease: tip });
  assert.notEqual(await git(origin, 'rev-parse', 'refs/heads/feat/retry'), tip, 'the rewrite stands on the remote');

  // A lease that no longer matches — the remote moved under the caller, as
  // the worker's own rewrite makes the push non-fast-forward again — is
  // said with its meaning.
  await git(source, ...AS, 'commit', '--quiet', '--allow-empty', '-m', 'two');
  await forge.push(repo, source, 'feat/retry');
  await git(source, ...AS, 'commit', '--quiet', '--amend', '--allow-empty', '-m', 'two, rewritten');
  await assert.rejects(() => forge.push(repo, source, 'feat/retry', { lease: tip }), /lease no longer matches/);
  const fresh = await git(origin, 'rev-parse', 'refs/heads/feat/retry');
  await forge.push(repo, source, 'feat/retry', { lease: fresh });
  assert.equal(
    await git(origin, 'log', '-1', '--format=%s', 'refs/heads/feat/retry'),
    'two, rewritten',
    'the second rewrite rides a fresh photo',
  );
  assert.ok(!(await gitConfig(source)).includes('ghs_token'), 'and the credential is still left nowhere');
});

test('fetchRefs brings every branch in, prunes the deleted, and moves no files', async () => {
  const { root, origin, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  const seed = join(root, 'seed');
  await git(seed, ...AS, 'checkout', '-q', '-b', 'feat/elsewhere');
  await writeFile(join(seed, 'elsewhere.md'), 'there\n');
  await git(seed, 'add', '.');
  await git(seed, ...AS, 'commit', '--quiet', '-m', 'over there');
  await git(seed, 'push', '--quiet', origin, 'HEAD:refs/heads/feat/elsewhere');

  await forge.fetchRefs({ id: 'acme/widget', remote: origin }, source);
  assert.ok(
    await git(source, 'rev-parse', '--verify', 'refs/remotes/origin/feat/elsewhere').then(
      () => true,
      () => false,
    ),
    'a branch the checkout had never seen arrives as a ref',
  );
  assert.equal(await git(source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'nothing was checked out');
  await assert.rejects(() => readFile(join(source, 'elsewhere.md'), 'utf8'), 'no files moved');

  // The branch dies upstream; the next sync prunes it away.
  await git(origin, 'update-ref', '-d', 'refs/heads/feat/elsewhere');
  await forge.fetchRefs({ id: 'acme/widget', remote: origin }, source);
  assert.equal(
    (
      await run('git', ['-C', source, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feat/elsewhere'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).catch(() => null)
    )?.stdout.trim() ?? '',
    '',
    'a deleted branch leaves the checkout’s refs too',
  );
});

test('a push that the remote refuses is said with git’s words, not swallowed', async () => {
  const { root, source } = await checkout();
  const forge = (await forgeWith({})).forge;
  await git(source, ...AS, 'commit', '--quiet', '--allow-empty', '-m', 'worker: the work');
  await assert.rejects(
    forge.push({ id: 'acme/widget', remote: join(root, 'nothing.git') }, source, 'main'),
    /pushing main to acme\/widget failed/,
  );
});
