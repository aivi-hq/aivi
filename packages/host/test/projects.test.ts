/** The project sync as a unit: the decision — fast-forward, current, or skip
 *  with the reason — is what these tests pin, answered by a scripted git that
 *  keeps every call on record. Whether git really moves files is git's own
 *  unit and the live gate's subject (`npm run smoke`). The forge-owned route
 *  is the registry's decision, tested against a forge that only says what the
 *  test wrote. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Forges } from '../src/forges.ts';
import { type ProjectGit, syncProjects } from '../src/projects.ts';

/** git as the plain path sees it: every call on record, every answer scripted.
 *  A call nobody scripted is recorded and answered with the empty string —
 *  and `assertAllScripted` says so at the end, because syncProject's honest
 *  catch would otherwise swallow the surprise into a `skipped`. */
type Reply = string | { fail: string };
const scriptedGit = (answer: (directory: string, args: string[]) => Reply | undefined) => {
  const calls: { directory: string; args: string[] }[] = [];
  const unscripted: string[] = [];
  const git: ProjectGit = async (directory, args) => {
    calls.push({ directory, args });
    const reply = answer(directory, args);
    if (reply === undefined) {
      unscripted.push(`${args[0]} ${args.slice(1).join(' ')}`);
      return '';
    }
    if (typeof reply !== 'string') throw new Error(reply.fail);
    return reply;
  };
  return {
    git,
    calls,
    assertAllScripted: () => assert.deepEqual(unscripted, [], 'no git call went unscripted'),
  };
};

/** The board: a `site` checkout, a `dirty` one, a `plain` directory that holds
 *  no repository. The sync never looks at the disk — what it visits comes from
 *  the config (`sync: false`, `removed`) — and everything past that is the
 *  scripted runner answering its calls. */
const board = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = new Map<string, string>();
  for (const id of ['site', 'dirty', 'plain']) {
    const directory = join(root, `projects/${id}/source`);
    await mkdir(directory, { recursive: true });
    directories.set(id, directory);
  }
  return { root, directories };
};

/** The answers of a checkout sitting exactly where its upstream left it. */
const settled =
  (head: string, upstreamTip: string) =>
  (_directory: string, args: string[]): Reply | undefined => {
    const key = args.join(' ');
    if (key === 'status --porcelain') return '';
    if (key === 'symbolic-ref --quiet --short HEAD') return 'main';
    if (key.startsWith('fetch')) return '';
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return 'origin/main';
    if (key === 'rev-parse HEAD') return head;
    if (key === 'rev-parse origin/main') return upstreamTip;
    if (key.startsWith('merge-base')) return ''; // an ancestor: a fast-forward stands
    if (key.startsWith('merge')) return '';
    return undefined;
  };

test('projects.sync fast-forwards clean checkouts and skips anything that needs a decision', async t => {
  const { directories } = await board(t);
  const projects = [
    { id: 'site', directory: directories.get('site')! },
    { id: 'dirty', directory: directories.get('dirty')! },
    { id: 'plain', directory: directories.get('plain')!, sync: false as const },
    { id: 'gone', directory: join(directories.get('site')!, '..', 'gone', 'source'), removed: true as const },
  ];

  // Upstream moved: site fast-forwards; the dirty checkout is never touched;
  // the `sync: false` project is never visited; the removed project is not.
  const first = scriptedGit((directory, args) => {
    if (directory === projects[1]!.directory && args[0] === 'status') return ' M docs/a.md\n';
    return settled('aaa111', 'bbb222')(directory, args);
  });
  const before = await syncProjects(projects, new Forges(), undefined, first.git);
  assert.deepEqual(
    before.map(o => [o.id, o.state, o.reason]),
    [
      ['site', 'updated', undefined],
      ['dirty', 'skipped', 'local changes in source/'],
    ],
    'a `sync: false` project and a removed one report nothing: the config owns the fact',
  );
  assert.ok(
    !first.calls.some(call => call.directory === projects[2]!.directory),
    'a directory that is no repository is never asked anything of git',
  );
  assert.ok(
    first.calls.some(call => call.args.join(' ') === 'merge --ff-only --quiet origin/main'),
    '--ff-only is the only merge the plain path ever runs',
  );
  assert.ok(
    !first.calls.some(call => call.directory === projects[1]!.directory && call.args[0] === 'merge'),
    'local edits are never touched: the dirty checkout is never asked to merge',
  );

  // Nothing moved since: current, and no merge is asked a second time.
  const second = scriptedGit(settled('bbb222', 'bbb222'));
  const again = await syncProjects([projects[0]!], new Forges(), undefined, second.git);
  assert.deepEqual(again, [{ id: 'site', state: 'current', from: 'bbb222', to: 'bbb222' }]);
  assert.ok(!second.calls.some(call => call.args[0] === 'merge'), 'current says current: nothing runs');

  // A local commit on top of upstream is a divergence, not something to resolve by force.
  const diverged = scriptedGit((directory, args) => {
    if (args[0] === 'merge-base') return { fail: 'not a git commit' };
    return settled('ccc333', 'ddd444')(directory, args);
  });
  const outcomes = await syncProjects([projects[0]!], new Forges(), undefined, diverged.git);
  assert.equal(outcomes[0]!.state, 'skipped');
  assert.match(outcomes[0]!.reason!, /main and origin\/main have diverged/);

  // A detached head and a branch without upstream are said, not fixed.
  const detached = scriptedGit((directory, args) =>
    args[0] === 'symbolic-ref' ? { fail: '' } : settled('aaa111', 'bbb222')(directory, args),
  );
  assert.deepEqual(await syncProjects([projects[0]!], new Forges(), undefined, detached.git), [
    { id: 'site', state: 'skipped', reason: 'detached HEAD' },
  ]);
  const noUpstream = scriptedGit((directory, args) => {
    if (args.join(' ') === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return { fail: 'no upstream' };
    return settled('aaa111', 'bbb222')(directory, args);
  });
  assert.deepEqual(await syncProjects([projects[0]!], new Forges(), undefined, noUpstream.git), [
    { id: 'site', state: 'skipped', reason: 'branch main has no upstream' },
  ]);
  first.assertAllScripted();
  second.assertAllScripted();
  diverged.assertAllScripted();
});

test('a checkout whose remote a forge owns syncs through the forge, and only the forge', async t => {
  const { directories } = await board(t);
  const source = directories.get('site')!;

  const asked: string[] = [];
  let answer: { state: 'updated' | 'current' | 'held'; from?: string; to?: string; reason?: string } = {
    state: 'updated',
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
  };
  const github = {
    async repoFor(project: { id: string }) {
      asked.push(project.id);
      return { id: 'acme/site', remote: 'https://github.com/acme/site' };
    },
    async syncSource(_repo: unknown, _directory: string) {
      return answer;
    },
  };
  const other = {
    async repoFor() {
      return undefined; // never asked: the first forge already claimed the remote
    },
    async syncSource() {
      throw new Error('never');
    },
  };
  const forges = new Forges();
  forges.register(github as never);
  forges.register(other as never);

  const projects = [{ id: 'site', directory: source }];
  // The forge claims it, so the plain path spawns nothing: the runner records
  // silence, and that is the proof.
  const throughForge = scriptedGit(() => undefined);
  const moved = (await syncProjects(projects, forges, undefined, throughForge.git))[0]!;
  assert.deepEqual(asked, ['site'], 'the registry is asked once, and the claiming forge does the sync');
  assert.deepEqual(moved, { id: 'site', state: 'updated', from: 'a'.repeat(40), to: 'b'.repeat(40) });
  assert.deepEqual(throughForge.calls, [], 'plain git moved nothing: the forge answers');

  answer = { state: 'held', reason: 'diverged; a person must decide' };
  const held = (await syncProjects(projects, forges, undefined, scriptedGit(() => undefined).git))[0]!;
  assert.deepEqual(held, { id: 'site', state: 'skipped', reason: 'diverged; a person must decide' });

  // A forge that recognises no remote leaves the plain path as it was.
  const bare = new Forges();
  bare.register({ async repoFor() {}, async syncSource() {} } as never);
  const plain = scriptedGit(settled('aaa111', 'aaa111'));
  const outcome = (await syncProjects(projects, bare, undefined, plain.git))[0]!;
  assert.equal(outcome.state, 'current', 'nobody claimed it: plain git answers, naming no plugin');
  plain.assertAllScripted();
});
