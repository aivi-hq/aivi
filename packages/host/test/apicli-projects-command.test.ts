/** The project commands as a unit: what list, add, remove and purge read from
 *  the loaded config, hand to the wizard and the project operations, and say
 *  when they are done. The home's context, the wizard and the two destructive
 *  operations are module mocks; nothing here touches a project directory. */
import assert from 'node:assert/strict';
import { beforeEach, mock, type TestContext, test } from 'node:test';
import { keepExitCode, loadedWith, parse } from './apicli-fixture.ts';

const world = { loaded: loadedWith() };
const print = mock.fn();
const runProjectSetup = mock.fn(async (_options: { home: string; configPath: string; name?: string }) => 'research');
const removeProject = mock.fn(async (_configPath: string, id: string) => ({
  id,
  removed: `/aivi-home/projects/${id}/source`,
}));
const purgeProject = mock.fn(async (_configPath: string, id: string, options: { confirm: boolean }) => ({
  id,
  paths: [`/aivi-home/projects/${id}`],
  purged: options.confirm,
}));

mock.module('../src/cli/context.ts', {
  exports: {
    configPath: () => '/aivi-home/config.json',
    context: async () => ({ loaded: world.loaded }),
    home: () => '/aivi-home',
    print,
  },
});
mock.module('../src/cli/project-setup.ts', { exports: { runProjectSetup } });
const core = await import('@aivi/core');
mock.module('@aivi/core', { exports: { ...core, purgeProject, removeProject } });

const { registerProjects } = await import('../src/cli/commands/projects.ts');

beforeEach(() => {
  for (const spy of [print, runProjectSetup, removeProject, purgeProject]) spy.mock.resetCalls();
  world.loaded = loadedWith();
});

const printed = () => print.mock.calls.map(call => call.arguments);

/** What the command tells the person on stderr; the exit code it leaves behind is given back after. */
function said(t: TestContext) {
  keepExitCode(t);
  process.exitCode = undefined;
  return t.mock.method(console, 'error', () => {});
}

test('list shows each project with its sources, and the directory only where a checkout exists', async () => {
  world.loaded = loadedWith(
    {},
    {
      projects: [
        { id: 'app', directory: '/aivi-home/projects/app/source' },
        { id: 'old', directory: '/aivi-home/projects/old/source', removed: true },
      ],
      sources: [
        { id: 'adrs', path: '/app/docs', kind: 'decision', scope: 'project', projectId: 'app' },
        { id: 'memory', path: '/memory/old', kind: 'memory', scope: 'project', projectId: 'old' },
      ],
    },
  );
  await parse(registerProjects, 'projects', 'list');
  assert.deepEqual(printed(), [
    [
      [
        { id: 'app', sources: [{ id: 'adrs', kind: 'decision' }], directory: '/aivi-home/projects/app/source' },
        { id: 'old', removed: true, sources: [{ id: 'memory', kind: 'memory' }] },
      ],
    ],
  ]);
});

test('add hands the wizard the home and its config, and the name only when one was given', async () => {
  await parse(registerProjects, 'projects', 'add', 'research');
  await parse(registerProjects, 'projects', 'add');
  assert.deepEqual(
    runProjectSetup.mock.calls.map(call => call.arguments),
    [
      [{ home: '/aivi-home', configPath: '/aivi-home/config.json', name: 'research' }],
      [{ home: '/aivi-home', configPath: '/aivi-home/config.json' }],
    ],
  );
});

test('remove deletes the checkout, prints what went and says the memory stays', async t => {
  const stderr = said(t);
  await parse(registerProjects, 'projects', 'remove', 'app');
  assert.deepEqual(removeProject.mock.calls[0]!.arguments, ['/aivi-home/config.json', 'app']);
  assert.deepEqual(printed(), [[{ id: 'app', removed: '/aivi-home/projects/app/source' }]]);
  assert.deepEqual(stderr.mock.calls[0]!.arguments, [
    'Memory kept; the project is listed as removed until `aivi projects purge`. Restart `aivi serve`.',
  ]);
});

test('purge without --confirm only shows what would go, says so and fails the command', async t => {
  const stderr = said(t);
  await parse(registerProjects, 'projects', 'purge', 'app');
  assert.deepEqual(purgeProject.mock.calls[0]!.arguments, ['/aivi-home/config.json', 'app', { confirm: false }]);
  assert.deepEqual(printed(), [[{ id: 'app', paths: ['/aivi-home/projects/app'], purged: false }]]);
  assert.deepEqual(stderr.mock.calls[0]!.arguments, [
    'Nothing deleted. Re-run with --confirm to delete these paths; memory cannot be recovered.',
  ]);
  assert.equal(process.exitCode, 1);
});

test('purge --confirm deletes the project and says the index must restart to forget it', async t => {
  const stderr = said(t);
  await parse(registerProjects, 'projects', 'purge', 'app', '--confirm');
  assert.deepEqual(purgeProject.mock.calls[0]!.arguments, ['/aivi-home/config.json', 'app', { confirm: true }]);
  assert.deepEqual(printed(), [[{ id: 'app', paths: ['/aivi-home/projects/app'], purged: true }]]);
  assert.deepEqual(stderr.mock.calls[0]!.arguments, ['Restart `aivi serve` so the index forgets it.']);
  assert.equal(process.exitCode, undefined, 'a purge that happened is a success');
});
