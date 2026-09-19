import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig, projectSummaries } from '../src/config.ts';
import {
  addProject,
  parseLaneFlags,
  projectIdFromUrl,
  purgeProject,
  removeProject,
  writeProjectLinear,
} from '../src/projects.ts';

const run = promisify(execFile);

test('project ids follow from the repository URL', () => {
  assert.equal(projectIdFromUrl('https://github.com/acme/Website.git'), 'website');
  assert.equal(projectIdFromUrl('git@github.com:acme/api.git'), 'api');
  assert.equal(projectIdFromUrl('/srv/git/legacy-app/'), 'legacy-app');
});

test('projects add clones into <home>/projects/<id>/source, which is the whole registration', async t => {
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
    directory: join(home, 'projects/acme-site/source'),
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
  await mkdir(join(root, 'projects/site/source/docs'), { recursive: true });
  await mkdir(join(root, 'projects/site/worktrees/eng-1'), { recursive: true });
  await mkdir(join(root, 'projects/site/memory'), { recursive: true });
  await writeFile(join(root, 'projects/site/memory/facts.md'), '# Facts: site\n\n- 2026-09-15: site used pnpm.');

  assert.deepEqual(await removeProject(config, 'site'), { id: 'site', removed: join(root, 'projects/site/source') });
  assert.equal(
    await stat(join(root, 'projects/site/worktrees')).catch(() => null),
    null,
    'worktrees go with the checkout',
  );
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
  assert.deepEqual(dry, { id: 'site', paths: [join(root, 'projects/site')], purged: false });
  assert.ok(await stat(join(root, 'projects/site/memory/facts.md')), 'nothing deleted without confirm');
  const wet = await purgeProject(config, 'site', { confirm: true });
  assert.equal(wet.purged, true);
  assert.equal(await stat(join(root, 'projects/site')).catch(() => null), null);
  assert.deepEqual((await loadConfig(config)).projects, []);
  await assert.rejects(purgeProject(config, 'site', { confirm: true }), /Nothing to purge/);
});

test('writeProjectLinear writes teams, keeps everything else, and restores a config that stops loading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'aivi.json');
  await writeFile(config, `${JSON.stringify({ version: 1, knowledge: [{ id: 'company', path: 'kb' }] }, null, 2)}\n`);
  await mkdir(join(root, 'projects/site/source'), { recursive: true });

  const written = await writeProjectLinear(config, 'site', { teams: ['t-1', 't-2'] });
  assert.deepEqual(written, { id: 'site', teams: ['t-1', 't-2'] });
  const raw = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(raw.projects, { site: { linear: { teams: ['t-1', 't-2'] } } });
  assert.deepEqual(raw.knowledge, [{ id: 'company', path: 'kb' }], 'the rest of the file is kept');

  // An existing lanes block survives a rewrite of the teams; so do other projects' entries.
  await mkdir(join(root, 'projects/other/source'), { recursive: true });
  raw.linear = { apps: { dev: {} } };
  raw.projects.site.linear.lanes = { 'In Progress': 'developer' };
  raw.projects.other = { enabled: true };
  await writeFile(config, JSON.stringify(raw, null, 2));
  assert.deepEqual(await writeProjectLinear(config, 'site', { teams: ['t-3'] }), {
    id: 'site',
    teams: ['t-3'],
    lanes: { 'In Progress': 'developer' },
  });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.other, { enabled: true });

  // Given lanes are written as they are, human lanes included.
  assert.deepEqual(await writeProjectLinear(config, 'site', { teams: ['t-4'], lanes: { Dev: 'dev', Triage: null } }), {
    id: 'site',
    teams: ['t-4'],
    lanes: { Dev: 'dev', Triage: null },
  });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.site.linear.lanes, {
    Dev: 'dev',
    Triage: null,
  });

  await assert.rejects(writeProjectLinear(config, 'site', { teams: [] }), /at least one Linear team/);
  const before = await readFile(config, 'utf8');
  await assert.rejects(
    writeProjectLinear(config, 'site', { teams: [''] }),
    /teams/,
    'the schema rejects an empty team id',
  );
  assert.equal(await readFile(config, 'utf8'), before, 'a config that stopped loading is restored');
  // A lane names an OpenCode agent: no app resolution happens at write time.
  await writeProjectLinear(config, 'site', { teams: ['t-5'], lanes: { Dev: 'ghost-agent' } });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.site.linear.lanes, { Dev: 'ghost-agent' });
  // But a write that stops the config loading for another reason is restored.
  const restored = await readFile(config, 'utf8');
  await assert.rejects(
    writeProjectLinear(config, 'site', { teams: [''] }),
    /teams/,
    'the schema rejects an empty team id',
  );
  assert.equal(await readFile(config, 'utf8'), restored, 'a rejected lane write is restored too');
});

test('lane flags read as a lane map: shorthand, human lanes, colons kept', () => {
  assert.deepEqual(parseLaneFlags(['Dev:dev', 'Review,Build:review'], ['Backlog']), {
    Dev: 'dev',
    Review: 'review',
    Build: 'review',
    Backlog: null,
  });
  assert.deepEqual(parseLaneFlags(['Stand:up:dev'], []), { 'Stand:up': 'dev' }, 'split at the last colon');
  assert.deepEqual(parseLaneFlags([], []), {});
  assert.throws(() => parseLaneFlags(['Dev'], []), /must read LANE:AGENT/);
  assert.throws(() => parseLaneFlags(['Dev:'], []), /must read LANE:AGENT/);
  assert.throws(() => parseLaneFlags([':dev'], []), /must read LANE:AGENT/);
  assert.throws(() => parseLaneFlags(['Dev, :dev'], []), /empty lane name/);
  assert.throws(() => parseLaneFlags(['Dev:dev'], ['Dev']), /both --lane and --unlane/);
  assert.throws(() => parseLaneFlags([], ['  ']), /--unlane needs a lane name/);
});
