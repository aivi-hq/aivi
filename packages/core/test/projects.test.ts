import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig, projectSummaries } from '../src/config.ts';
import { addProject, projectIdFromUrl, purgeProject, removeProject } from '../src/projects.ts';

const run = promisify(execFile);

test('project ids follow from the repository URL', () => {
  assert.equal(projectIdFromUrl('https://github.com/acme/Website.git'), 'website');
  assert.equal(projectIdFromUrl('git@github.com:acme/api.git'), 'api');
  assert.equal(projectIdFromUrl('/srv/git/legacy-app/'), 'legacy-app');
});

test('projects add clones into <home>/projects/<id>, which is the whole registration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream/Acme-Site');
  await mkdir(join(upstream, 'docs/adr'), { recursive: true });
  await writeFile(join(upstream, 'docs/adr/0001.md'), '# ADR');
  await run('git', ['init', '-q', '-b', 'main', upstream]);
  await run('git', ['-C', upstream, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  await run('git', ['-C', upstream, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  const home = join(root, 'home');
  await mkdir(home);
  await writeFile(join(home, 'aivi.json'), JSON.stringify({ version: 1 }));

  const added = await addProject(join(home, 'aivi.json'), upstream);
  assert.deepEqual(added, {
    id: 'acme-site',
    directory: join(home, 'projects/acme-site'),
    sources: ['docs', 'adr', 'memory'],
  });
  await assert.rejects(addProject(join(home, 'aivi.json'), upstream), /already exists/);
  await assert.rejects(addProject(join(home, 'aivi.json'), upstream, { id: 'Bad Id' }), /must match/);
  let cloned = false;
  const second = await addProject(join(home, 'aivi.json'), upstream, {
    id: 'second',
    clone: async (_url, directory) => {
      cloned = true;
      await mkdir(directory, { recursive: true });
    },
  });
  assert.ok(cloned);
  assert.deepEqual(
    second.sources,
    ['docs', 'adr', 'memory'],
    'sources are configured even before the directories exist',
  );
});

test('remove deletes the checkout and keeps memory; purge shows first and deletes only with confirm', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-rm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'aivi.json');
  await writeFile(config, JSON.stringify({ version: 1 }));
  await mkdir(join(root, 'projects/site/docs'), { recursive: true });
  await mkdir(join(root, 'memory/site'), { recursive: true });
  await writeFile(join(root, 'memory/site/facts.md'), '# Facts: site\n\n- 2026-09-15: site used pnpm.');

  assert.deepEqual(await removeProject(config, 'site'), { id: 'site', removed: join(root, 'projects/site') });
  await assert.rejects(removeProject(config, 'site'), /No checkout/);
  const loaded = await loadConfig(config);
  assert.deepEqual(
    loaded.projects.map(p => [p.id, p.removed]),
    [['site', true]],
  );
  assert.deepEqual(projectSummaries(loaded), [
    { id: 'site', removed: true, sources: [{ id: 'memory', kind: 'memory' }] },
  ]);

  const dry = await purgeProject(config, 'site');
  assert.deepEqual(dry, { id: 'site', paths: [join(root, 'memory/site')], purged: false });
  assert.ok(await stat(join(root, 'memory/site/facts.md')), 'nothing deleted without confirm');
  const wet = await purgeProject(config, 'site', { confirm: true });
  assert.equal(wet.purged, true);
  assert.equal(await stat(join(root, 'memory/site')).catch(() => null), null);
  assert.deepEqual((await loadConfig(config)).projects, []);
  await assert.rejects(purgeProject(config, 'site', { confirm: true }), /Nothing to purge/);
});
