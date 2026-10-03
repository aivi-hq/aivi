import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { laneOf, loadConfig } from '@aivi/core';
import { linearTeamCollisions, projectLinear, writeProjectLinear } from '../src/projects.ts';

test('writeProjectLinear writes teams, keeps everything else, and restores a config that stops loading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await writeFile(config, `${JSON.stringify({ version: 1, knowledge: [{ id: 'company', path: 'kb' }] }, null, 2)}\n`);
  await mkdir(join(root, 'projects/site/source'), { recursive: true });

  const written = await writeProjectLinear(config, 'site', { teams: ['t-1', 't-2'] });
  assert.deepEqual(written, { id: 'site', teams: ['t-1', 't-2'] });
  const raw = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(raw.projects, { site: { 'tracker-linear': { teams: ['t-1', 't-2'] } } });
  assert.deepEqual(raw.knowledge, [{ id: 'company', path: 'kb' }], 'the rest of the file is kept');

  // An existing lanes block survives a rewrite of the teams; so do other projects' entries.
  await mkdir(join(root, 'projects/other/source'), { recursive: true });
  raw.projects.site.lanes = [{ name: 'In Progress', agent: 'developer', worktree: true }];
  raw.projects.other = { enabled: true };
  await writeFile(config, JSON.stringify(raw, null, 2));
  assert.deepEqual(await writeProjectLinear(config, 'site', { teams: ['t-3'] }), {
    id: 'site',
    teams: ['t-3'],
    lanes: [{ name: 'In Progress', agent: 'developer', worktree: true }],
  });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.other, { enabled: true });

  // Given lanes are written to the project's **core** array, in order,
  // human lanes (no agent) included; the plugin section holds teams only.
  assert.deepEqual(
    await writeProjectLinear(config, 'site', {
      teams: ['t-4'],
      lanes: [
        { name: 'Triage', worktree: true },
        { name: 'Dev', agent: 'dev', worktree: true },
      ],
    }),
    {
      id: 'site',
      teams: ['t-4'],
      lanes: [
        { name: 'Triage', worktree: true },
        { name: 'Dev', agent: 'dev', worktree: true },
      ],
    },
  );
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.site.lanes, [
    { name: 'Triage', worktree: true },
    { name: 'Dev', agent: 'dev', worktree: true },
  ]);
  assert.equal(JSON.parse(await readFile(config, 'utf8')).projects.site['tracker-linear'].lanes, undefined);

  await assert.rejects(writeProjectLinear(config, 'site', { teams: [] }), /at least one Linear team/);
  const before = await readFile(config, 'utf8');
  await assert.rejects(
    writeProjectLinear(config, 'site', { teams: [''] }),
    /teams/,
    'the plugin schema rejects an empty team id',
  );
  assert.equal(await readFile(config, 'utf8'), before, 'a write the plugin schema rejects is restored');
  // A lane names an OpenCode agent: no app resolution happens at write time.
  await writeProjectLinear(config, 'site', {
    teams: ['t-5'],
    lanes: [{ name: 'Dev', agent: 'ghost-agent', worktree: true }],
  });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.site.lanes, [
    { name: 'Dev', agent: 'ghost-agent', worktree: true },
  ]);
});

test('projectLinear: the convention is the base, the entry wins one lane at a time, null means humans', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const write = (extra: Record<string, unknown>) =>
    writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, ...extra }));

  await write({
    projectDefaults: { 'tracker-linear': { workspaceId: 'ws-default' } },
    projects: {
      site: {
        'tracker-linear': { teams: ['t-1'] },
        lanes: [
          { name: 'Dev', agent: 'dev', worktree: true },
          { name: 'Review', agent: 'reviewer', worktree: false, next: 'Shipped' },
          { name: 'Shipped' },
        ],
      },
    },
  });
  const loaded = await loadConfig(join(root, 'config.json'));
  const routing = projectLinear(loaded, 'site')!;
  assert.deepEqual(
    routing,
    { teams: ['t-1'], workspaceId: 'ws-default' },
    'the section routes teams and workspace only',
  );
  const project = loaded.projects.find(p => p.id === 'site')!;
  assert.deepEqual(
    project.lanes,
    [
      { name: 'Dev', agent: 'dev', queue: false, worktree: true },
      { name: 'Review', agent: 'reviewer', queue: false, worktree: false, next: 'Shipped' },
      { name: 'Shipped', queue: false, worktree: false },
    ],
    'the lanes are core\u2019s, on the project, in the written order; queue and worktree default in',
  );
  assert.deepEqual(laneOf(project, 'Review'), {
    name: 'Review',
    agent: 'reviewer',
    queue: false,
    worktree: false,
    next: 'Shipped',
  });
  assert.equal(laneOf(project, 'Gone'), undefined, 'an unmapped state is silence');

  // A bare section entry still gets the convention workspace.
  await write({
    projectDefaults: { 'tracker-linear': { workspaceId: 'ws-default' } },
    projects: { site: { 'tracker-linear': { teams: ['t-1'] } } },
  });
  const bare = projectLinear(await loadConfig(join(root, 'config.json')), 'site')!;
  assert.equal(bare.workspaceId, 'ws-default');

  // A project with no linear section routes nothing: undefined, not an empty map.
  await write({ projects: { site: {} } });
  assert.equal(projectLinear(await loadConfig(join(root, 'config.json')), 'site'), undefined);
});

test('a Linear team belongs to exactly one project; the collision is said for every clash', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-collide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects/website/source'), { recursive: true });
  await mkdir(join(root, 'projects/api/source'), { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      projects: {
        website: { 'tracker-linear': { teams: ['lt-1'], lanes: {} } },
        api: { 'tracker-linear': { teams: ['lt-1', 'lt-2'], lanes: {} } },
      },
    }),
  );
  const collisions = linearTeamCollisions(await loadConfig(join(root, 'config.json')));
  assert.equal(collisions.length, 1, 'one team is claimed twice');
  assert.match(collisions[0]!, /already mapped to project website/);

  // A write that would collide is refused and the file restored.
  await writeProjectLinear(join(root, 'config.json'), 'api', { teams: ['lt-1'] }).then(
    () => assert.fail('a colliding write should be refused'),
    () => {},
  );
});
