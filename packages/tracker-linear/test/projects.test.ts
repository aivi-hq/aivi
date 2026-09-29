import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '@aivi/core';
import { linearTeamCollisions, parseLaneFlags, projectLinear, writeProjectLinear } from '../src/projects.ts';

test('writeProjectLinear writes teams, keeps everything else, and restores a config that stops loading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-linear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await writeFile(config, `${JSON.stringify({ version: 1, knowledge: [{ id: 'company', path: 'kb' }] }, null, 2)}\n`);
  await mkdir(join(root, 'projects/site/source'), { recursive: true });

  const written = await writeProjectLinear(config, 'site', { teams: ['t-1', 't-2'] });
  assert.deepEqual(written, { id: 'site', teams: ['t-1', 't-2'] });
  const raw = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(raw.projects, { site: { linear: { teams: ['t-1', 't-2'] } } });
  assert.deepEqual(raw.knowledge, [{ id: 'company', path: 'kb' }], 'the rest of the file is kept');

  // An existing lanes block survives a rewrite of the teams; so do other projects' entries.
  await mkdir(join(root, 'projects/other/source'), { recursive: true });
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
    'the plugin schema rejects an empty team id',
  );
  assert.equal(await readFile(config, 'utf8'), before, 'a write the plugin schema rejects is restored');
  // A lane names an OpenCode agent: no app resolution happens at write time.
  await writeProjectLinear(config, 'site', { teams: ['t-5'], lanes: { Dev: 'ghost-agent' } });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projects.site.linear.lanes, { Dev: 'ghost-agent' });
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

test('projectLinear: the convention is the base, the entry wins one lane at a time, null means humans', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-linear-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const write = (extra: Record<string, unknown>) =>
    writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, ...extra }));

  await write({
    projectDefaults: { linear: { lanes: { Dev: 'dev', Review: 'dev', Triage: null }, workspaceId: 'ws-default' } },
    projects: {
      site: { linear: { teams: ['t-1'], lanes: { Review: { agent: 'reviewer', worktree: false }, Shipped: null } } },
    },
  });
  const loaded = await loadConfig(join(root, 'config.json'));
  const routing = projectLinear(loaded, 'site')!;
  assert.deepEqual(
    routing.lanes,
    { Dev: { agent: 'dev', worktree: true }, Review: { agent: 'reviewer', worktree: false } },
    'the convention is the base, the entry wins per lane, human lanes are absent from the map the listener consults',
  );
  assert.equal(routing.workspaceId, 'ws-default', 'workspaceId falls back to the convention');
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(raw.projects.site.linear.lanes.Shipped, null, 'the file keeps the human lanes');

  // A bare linear entry gets the whole convention, workspaceId included.
  await write({
    projectDefaults: { linear: { lanes: { Dev: 'dev' }, workspaceId: 'ws-default' } },
    projects: { site: { linear: { teams: ['t-1'] } } },
  });
  const bare = projectLinear(await loadConfig(join(root, 'config.json')), 'site')!;
  assert.deepEqual(bare.lanes, { Dev: { agent: 'dev', worktree: true } }, 'the convention applies untouched');
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
        website: { linear: { teams: ['lt-1'], lanes: {} } },
        api: { linear: { teams: ['lt-1', 'lt-2'], lanes: {} } },
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
