import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
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
  const before = await syncProjects(projects);
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
  const after = await syncProjects(projects);
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
  const diverged = (await syncProjects([projects[0]!]))[0]!;
  assert.equal(diverged.state, 'skipped');
  assert.match(diverged.reason!, /diverged/);
});
