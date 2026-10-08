/** pluginRemove takes a leaving plugin's whole config out of config.json: the
 *  `plugins` block, the `projectDefaults` section, and the plugin's section
 *  under every project. The composed schema refuses a section of a plugin no
 *  longer listed as an unrecognized key, so a removal that left one behind
 *  made the home un-loadable — found live when `aivi remove
 *  @aivi/tracker-linear` left `projects.aivi.tracker-linear` standing and the
 *  editor schema could not rebuild. The package's module id is read from its
 *  own `./config` declaration, exactly as remove reads it. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pluginRemove } from '../src/cli/plugin-remove.ts';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aivi-plugin-remove-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const configPath = () => join(directory, 'config.json');

/** The home as `aivi projects add` leaves it: a plugins block, Linear's
 *  company-wide defaults, and a Linear section on each project — lanes and
 *  other plugins' sections mixed in. loadConfig discovers projects as the
 *  directories of `<home>/projects`, so the fixture makes them real. */
function seedHome(): void {
  // A project is a directory holding memory/ (a checkout is none of this test).
  for (const project of ['aivi', 'other'])
    mkdirSync(join(directory, 'projects', project, 'memory'), { recursive: true });
  writeFileSync(
    configPath(),
    `${JSON.stringify(
      {
        version: 1,
        plugins: { browser: {}, 'tracker-linear': { apps: { dev: {} }, mcp: false } },
        projectDefaults: { 'tracker-linear': { workspaceId: 'w-1' } },
        projects: {
          aivi: {
            lanes: [{ name: 'Todo', agent: 'dev' }],
            'tracker-linear': { teams: ['t-1'] },
            'tracker-github': { board: 1, repos: ['acme/shop'] },
          },
          other: { 'tracker-linear': { teams: ['t-2'] } },
        },
      },
      null,
      2,
    )}\n`,
  );
}

test('pluginRemove drops the block, the defaults section and every project section', async () => {
  seedHome();
  const { moduleId, blockRemoved, sectionsRemoved } = await pluginRemove('@aivi/tracker-linear', {
    configPath: configPath(),
  });
  assert.equal(moduleId, 'tracker-linear', "the id is the package's own declaration");
  assert.equal(blockRemoved, true);
  assert.equal(sectionsRemoved, 3, 'the defaults section and both project sections');
  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.deepEqual(Object.keys(raw.plugins), ['browser'], 'a staying plugin keeps its block');
  assert.equal(raw.projectDefaults['tracker-linear'], undefined, 'the company-wide section left too');
  assert.equal(raw.projects.aivi['tracker-linear'], undefined, 'the section is gone from the project');
  assert.deepEqual(
    raw.projects.aivi.lanes,
    [{ name: 'Todo', agent: 'dev' }],
    'lanes are core’s fact: they stay with the project',
  );
  assert.deepEqual(
    raw.projects.aivi['tracker-github'],
    { board: 1, repos: ['acme/shop'] },
    'another plugin’s section is none of this removal',
  );
  assert.equal(raw.projects.other['tracker-linear'], undefined);
});

test('a plugin with no block and no sections is a legal removal that writes nothing', async () => {
  seedHome();
  const before = readFileSync(configPath(), 'utf8');
  // channel-slack holds no block and no section in this home: every delete
  // is an absent path, which answers false and writes nothing.
  const { moduleId, blockRemoved, sectionsRemoved } = await pluginRemove('@aivi/channel-slack', {
    configPath: configPath(),
  });
  assert.equal(moduleId, 'channel-slack');
  assert.equal(blockRemoved, false, 'the home holds no channel-slack block');
  assert.equal(sectionsRemoved, 0, 'and no channel-slack sections');
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'the file keeps its bytes');
});

test('the config loads after the removal — the composed schema has nothing left to refuse', async () => {
  seedHome();
  await pluginRemove('@aivi/tracker-linear', { configPath: configPath() });
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as {
    plugins: Record<string, unknown>;
    projectDefaults: Record<string, unknown>;
    projects: Record<string, Record<string, unknown>>;
  };
  // The proof of the bug’s fix: with the plugin out of the list, no project
  // or defaults entry carries its key, so the composed schema — the one serve
  // and the editor load — has no unrecognized key to refuse.
  for (const project of Object.values(raw.projects)) assert.equal(project['tracker-linear'], undefined);
  assert.equal(raw.projectDefaults['tracker-linear'], undefined);
  assert.equal(raw.plugins['tracker-linear'], undefined);
});
