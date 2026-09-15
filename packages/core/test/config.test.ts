import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextOccurrence } from '../src/clock.ts';
import { configSchema, loadConfig, selectSources } from '../src/config.ts';

test('config rejects ambiguous Linear app ownership and invalid schedule resources', () => {
  assert.equal(
    configSchema.safeParse({
      version: 1,
      linear: {
        applications: {
          developer: { agent: 'dev' },
          reviewer: { agent: 'dev' },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      version: 1,
      schedules: [
        {
          id: 'check',
          cron: '* * * * *',
          resource: 'missing',
          task: { kind: 'system.check' },
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      version: 1,
      schedules: [
        {
          id: 'check',
          cron: '* * * * *',
          timezone: 'Mars/Olympus',
          task: { kind: 'system.check' },
        },
      ],
    }).success,
    false,
  );
  assert.equal(configSchema.safeParse({ version: 1, unexpected: true }).success, false);
});

test('project files own lane mappings and paths; source selection never falls back on an unknown project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'checkout'));
  await writeFile(
    join(root, 'aivi.json'),
    JSON.stringify({
      version: 1,
      knowledge: [{ id: 'company', path: 'handbook' }],
      projects: [{ id: 'website', directory: 'checkout' }],
      linear: { applications: { worker: { agent: 'dev' } } },
    }),
  );
  await writeFile(
    join(root, 'checkout/aivi.project.json'),
    JSON.stringify({
      knowledge: [{ id: 'decisions', path: 'docs/adr' }],
      linear: { workspaceId: 'team', projectId: 'project', lanes: { Development: 'worker', Review: 'worker' } },
    }),
  );
  const loaded = await loadConfig(join(root, 'aivi.json'));
  assert.equal(loaded.config.stateDirectory, join(root, 'state'));
  assert.equal(loaded.projects[0]!.settings.linear!.lanes.Review, 'worker');
  assert.deepEqual(
    selectSources(loaded, ['website']).map(s => s.path),
    [join(root, 'handbook'), join(root, 'checkout/docs/adr')],
  );
  assert.equal(selectSources(loaded, [], true).length, 1);
  assert.equal(selectSources(loaded, ['website'], false)[0]!.projectId, 'website');
  assert.throws(() => selectSources(loaded, ['typo']), /Unknown project/);
  await writeFile(join(root, 'checkout/aivi.project.json'), '{broken');
  await assert.rejects(loadConfig(join(root, 'aivi.json')), SyntaxError);
});

test('calendar calculations use the configured timezone across daylight saving changes', () => {
  const pattern = '0 9 * * *';
  assert.equal(
    new Date(nextOccurrence(pattern, 'Europe/Amsterdam', Date.parse('2026-03-28T00:00:00Z'))).toISOString(),
    '2026-03-28T08:00:00.000Z',
  );
  assert.equal(
    new Date(nextOccurrence(pattern, 'Europe/Amsterdam', Date.parse('2026-03-29T00:00:00Z'))).toISOString(),
    '2026-03-29T07:00:00.000Z',
  );
});

test('agent scheduling is on by default in local-model, can be disabled, and must name an existing pool', () => {
  assert.deepEqual(configSchema.parse({ version: 1 }).scheduler.agentSchedules, { resource: 'local-model', max: 50 });
  assert.equal(
    configSchema.parse({ version: 1, scheduler: { agentSchedules: false } }).scheduler.agentSchedules,
    false,
  );
  const custom = configSchema.safeParse({ version: 1, scheduler: { resources: { gpu: 1 } } });
  assert.equal(custom.success, false, 'default pool local-model does not exist here');
  assert.match(JSON.stringify(custom.error?.issues), /set agentSchedules to false/);
  assert.deepEqual(
    configSchema.parse({ version: 1, scheduler: { resources: { gpu: 1 }, agentSchedules: { resource: 'gpu' } } })
      .scheduler.agentSchedules,
    { resource: 'gpu', max: 50 },
  );
});
