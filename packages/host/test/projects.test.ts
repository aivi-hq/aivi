import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Forges } from '../src/forges.ts';
import { syncProjects } from '../src/projects.ts';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);

test('projects.sync fast-forwards clean checkouts and skips anything that needs a decision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(join(upstream, 'docs'), { recursive: true });
  await writeFile(join(upstream, 'docs/a.md'), 'one');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'one');
  const source = join(root, 'projects/site/source');
  await mkdir(join(root, 'projects/site'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  const dirty = join(root, 'projects/dirty/source');
  await mkdir(join(root, 'projects/dirty'), { recursive: true });
  await run('git', ['clone', '-q', upstream, dirty]);
  await writeFile(join(dirty, 'docs/a.md'), 'edited locally');
  const plain = join(root, 'projects/plain/source');
  await mkdir(plain, { recursive: true });

  const projects = [
    { id: 'site', directory: source },
    { id: 'dirty', directory: dirty },
    { id: 'plain', directory: plain },
    { id: 'gone', directory: join(root, 'projects/gone/source'), removed: true as const },
  ];
  const before = await syncProjects(projects, new Forges());
  assert.deepEqual(
    before.map(o => [o.id, o.state, o.reason]),
    [
      ['site', 'current', undefined],
      ['dirty', 'skipped', 'local changes in source/'],
      ['plain', 'skipped', 'not a git checkout'],
    ],
    'nothing to do yet; removed projects are not visited',
  );

  await writeFile(join(upstream, 'docs/a.md'), 'two');
  await git(upstream, 'commit', '-q', '-am', 'two');
  const after = await syncProjects(projects, new Forges());
  const site = after.find(o => o.id === 'site')!;
  assert.equal(site.state, 'updated');
  assert.notEqual(site.from, site.to);
  assert.equal((await git(source, 'rev-parse', 'HEAD')).stdout.trim(), site.to);
  assert.equal(after.find(o => o.id === 'dirty')!.state, 'skipped', 'local edits are never touched');

  // A local commit on top of upstream is a divergence, not something to resolve by force.
  await writeFile(join(source, 'docs/b.md'), 'local');
  await git(source, 'add', '.');
  await git(source, 'commit', '-q', '-m', 'local');
  await writeFile(join(upstream, 'docs/a.md'), 'three');
  await git(upstream, 'commit', '-q', '-am', 'three');
  const diverged = (await syncProjects([projects[0]!], new Forges()))[0]!;
  assert.equal(diverged.state, 'skipped');
  assert.match(diverged.reason!, /diverged/);
});

test('a checkout whose remote a forge owns syncs through the forge, and only the forge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-sync-forge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(upstream);
  await writeFile(join(upstream, 'a.md'), 'one');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'one');
  const source = join(root, 'projects/site/source');
  await mkdir(join(root, 'projects/site'), { recursive: true });
  await run('git', ['clone', '-q', upstream, source]);
  const head = (await git(source, 'rev-parse', 'HEAD')).stdout.trim();

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
  const moved = (await syncProjects(projects, forges))[0]!;
  assert.deepEqual(asked, ['site'], 'the registry is asked once, and the claiming forge does the sync');
  assert.deepEqual(moved, { id: 'site', state: 'updated', from: 'a'.repeat(40), to: 'b'.repeat(40) });
  assert.equal(
    (await git(source, 'rev-parse', 'HEAD')).stdout.trim(),
    head,
    'plain git moved nothing: the forge answers',
  );

  answer = { state: 'held', reason: 'diverged; a person must decide' };
  const held = (await syncProjects(projects, forges))[0]!;
  assert.deepEqual(held, { id: 'site', state: 'skipped', reason: 'diverged; a person must decide' });

  // A forge that recognises no remote leaves the plain path as it was.
  const bare = new Forges();
  bare.register({ async repoFor() {}, async syncSource() {} } as never);
  const plain = (await syncProjects(projects, bare))[0]!;
  assert.equal(plain.state, 'current', 'nobody claimed it: plain git answers, naming no plugin');
});
