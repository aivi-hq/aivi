import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, projectSummaries } from '../src/config.ts';
import { purgeProject, removeProject } from '../src/projects.ts';

// No clone test lives here: core has no clone. A checkout is a forge's work
// (its own `./setupProject`); core only discovers and removes project
// directories. The linear lane merge and lane flags moved to
// @aivi/tracker-linear with the `linear` project section — their tests are in
// packages/tracker-linear/test/projects.test.ts.

test('remove deletes the checkout and keeps memory; purge shows first and deletes only with confirm', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-rm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
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
