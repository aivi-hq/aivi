/** The project wizard as a unit: what it asks, runs and writes for the
 *  plugins a home has configured and the answers a person gives. The
 *  terminal (`@clack/prompts`), the loaded config and the plugin registry are
 *  module mocks, registered before the wizard is imported: nothing here
 *  draws a prompt, loads a real config or resolves a real plugin. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import type { ProjectContributor, ProjectSetupContext, ProjectSetupResult } from '@aivi/plugin';
import type { ProjectContributorEntry } from '../src/cli/registry.ts';

const cancelled = Symbol('cancelled');

interface Question {
  message: string;
  options?: { value: string; label: string }[];
}

/** One run's world: the person's answers, what the home has configured, and
 *  what the wizard asked and said. Each test sets it; the mocks answer from it. */
const scene = {
  answers: [] as unknown[],
  asked: [] as Question[],
  said: [] as string[],
  plugins: {} as Record<string, unknown>,
  projectDefaults: {} as Record<string, unknown>,
  contributors: [] as ProjectContributorEntry[],
  /** What the composed schema says of the config the wizard wrote, when it refuses it. */
  refusal: undefined as string | undefined,
};

const ask = async (question: Question) => {
  scene.asked.push(question);
  assert.ok(scene.answers.length, `Unscripted question: ${question.message}`);
  return scene.answers.shift();
};
const say = (line: string) => {
  scene.said.push(line);
};

mock.module('@clack/prompts', {
  exports: { text: ask, select: ask, isCancel: (answer: unknown) => answer === cancelled, outro: say, cancel: say },
});
mock.module('../src/cli/context.ts', {
  exports: {
    context: async () => ({
      loaded: { config: { plugins: scene.plugins, projectDefaults: scene.projectDefaults } },
      registry: {
        configSchema: {
          parse: () => {
            if (scene.refusal) throw new Error(scene.refusal);
          },
        },
      },
    }),
    withStore: async (_loaded: unknown, fn: (store: unknown) => unknown) => fn('the home store'),
  },
});
mock.module('../src/cli/registry.ts', { exports: { projectContributors: async () => scene.contributors } });

const { runProjectSetup } = await import('../src/cli/project-setup.ts');

/** A home with its config file, a terminal, and a fresh scene. */
async function wizard(t: TestContext, given: Partial<typeof scene> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'aivi-project-wizard-'));
  const configPath = join(home, 'config.json');
  await writeFile(configPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  const terminal = (attached: boolean | undefined) =>
    Object.defineProperty(process.stdin, 'isTTY', { value: attached, configurable: true });
  const attached = process.stdin.isTTY;
  const exitCode = process.exitCode;
  terminal(true);
  t.after(async () => {
    terminal(attached);
    process.exitCode = exitCode;
    await rm(home, { recursive: true, force: true });
  });
  Object.assign(
    scene,
    { answers: [], asked: [], said: [], plugins: {}, projectDefaults: {}, contributors: [], refusal: undefined },
    given,
  );
  return {
    home,
    configPath,
    terminal,
    run: (name?: string) => runProjectSetup({ home, configPath, ...(name ? { name } : {}) }),
    config: async () => JSON.parse(await readFile(configPath, 'utf8')),
  };
}

/** A plugin's contributor: it keeps the context it was handed and answers with `result`. */
function contributor(
  moduleId: string,
  role: ProjectContributor['role'],
  result: ProjectSetupResult | ((ctx: ProjectSetupContext) => Promise<ProjectSetupResult>),
) {
  const handed: ProjectSetupContext[] = [];
  const setup = async (ctx: ProjectSetupContext) => {
    handed.push(ctx);
    return typeof result === 'function' ? result(ctx) : result;
  };
  const entry: ProjectContributorEntry = {
    name: `@aivi/${moduleId}`,
    moduleId,
    ...(role ? { role } : {}),
    contributor: { ...(role ? { role } : {}), setup },
  };
  return { entry, handed };
}

test('the wizard needs a terminal: without one it says how to do without, and asks and makes nothing', async t => {
  const w = await wizard(t);
  w.terminal(false);
  await assert.rejects(
    w.run('research'),
    /projects add needs an interactive terminal; to set a project up without one, write its block in config\.json/,
  );
  assert.deepEqual(scene.asked, []);
  assert.equal(existsSync(join(w.home, 'projects')), false);
});

test('a named project in a home without a forge is set up untracked', async t => {
  const w = await wizard(t);
  assert.equal(await w.run('research'), 'research');
  assert.deepEqual(scene.asked, [], 'the name given is the project: nobody is asked for it');
  assert.deepEqual(await w.config(), { version: 1, projects: { research: { sync: false } } });
  const note = join(w.home, 'projects', 'research', 'source', 'AGENTS.md');
  assert.match(await readFile(note, 'utf8'), /^# No source/);
  assert.deepEqual(scene.said, [
    'research has no source host (no forge configured); its directory is untracked and holds a note. Restart `aivi serve` to index it.',
  ]);

  await writeFile(note, '# Research\n');
  assert.equal(await w.run('research'), 'research');
  assert.equal(await readFile(note, 'utf8'), '# Research\n', 'the note is written once and never overwritten');
});

test('with no name and no plugin to offer one the person is asked, and a blank or cancelled answer stops the wizard', async t => {
  const w = await wizard(t, { answers: [' research ', '  ', cancelled] });
  assert.equal(await w.run(), 'research');
  assert.deepEqual(
    scene.asked.map(question => question.message),
    ['Project name'],
  );

  assert.equal(await w.run(), undefined);
  assert.equal(
    scene.said.at(-1),
    'Setup stopped: no project name and no configured plugin to offer one. Nothing further was written.',
  );
  assert.equal(process.exitCode, 1, 'a stopped wizard is a failed command');

  assert.equal(await w.run(), undefined);
  assert.equal(scene.said.at(-1), 'Setup stopped. Nothing was written.');
  assert.deepEqual(Object.keys((await w.config()).projects), ['research']);
});

test('a forge clones and a tracker maps: each is handed what the earlier one settled, and the project is written whole', async t => {
  const teams = t.mock.method(globalThis, 'fetch', async () => Response.json({ teams: ['ENG'] }));
  const forge = contributor('forge-github', 'forge', { id: 'site', cloned: true, repository: 'acme/site' });
  const tracker = contributor('tracker-linear', 'tracker', async ctx => {
    assert.equal(await ctx.withStore(store => store), 'the home store');
    assert.deepEqual(await (await ctx.fetch('https://tracker.test/teams')).json(), { teams: ['ENG'] });
    return { id: 'another-name', section: { team: 'ENG' }, lanes: [{ name: 'Todo', queue: true }] };
  });
  const notes = contributor('notes', undefined, { id: 'ignored', section: { folder: 'site' } });
  const idle = contributor('tracker-github', 'tracker', { id: 'never' });
  const w = await wizard(t, {
    plugins: { 'forge-github': {}, 'tracker-linear': { workspace: 'acme' }, notes: {} },
    projectDefaults: { 'tracker-linear': { labels: ['aivi'] } },
    contributors: [notes.entry, tracker.entry, idle.entry, forge.entry],
  });

  assert.equal(await w.run(), 'site', 'the first role to name the project settles it');
  assert.equal(forge.handed[0]!.projectId, undefined);
  assert.equal(forge.handed[0]!.forgeConfigured, true);
  const handed = tracker.handed[0]!;
  assert.deepEqual(
    [handed.projectId, handed.forgeRepository, handed.config, handed.projectDefaults, handed.home],
    ['site', 'acme/site', { workspace: 'acme' }, { labels: ['aivi'] }, w.home],
  );
  assert.equal(teams.mock.callCount(), 1);
  assert.equal(notes.handed[0]!.projectDefaults, undefined, 'a plugin with no defaults is handed none');
  assert.equal(idle.handed.length, 0, 'a plugin with no config block takes no part');
  assert.deepEqual(await w.config(), {
    version: 1,
    projects: {
      site: { lanes: [{ name: 'Todo', queue: true }], 'tracker-linear': { team: 'ENG' }, notes: { folder: 'site' } },
    },
  });
  assert.equal(existsSync(join(w.home, 'projects')), false, 'the forge brought the checkout: the wizard makes none');
  assert.deepEqual(scene.said, [
    'site is set up. Configured for tracker-linear, notes. Restart `aivi serve` to index it.',
  ]);
});

test('two plugins for one role are a choice: the pick runs, and a cancel stops the wizard', async t => {
  const github = contributor('tracker-github', 'tracker', { id: 'site' });
  const linear = contributor('tracker-linear', 'tracker', { id: 'site', section: { team: 'ENG' } });
  const w = await wizard(t, {
    answers: ['tracker-linear', cancelled],
    plugins: { 'tracker-github': {}, 'tracker-linear': {} },
    contributors: [github.entry, linear.entry],
  });

  assert.equal(await w.run(), 'site');
  assert.deepEqual(scene.asked, [
    {
      message: 'Which tracker sets up this project?',
      options: [
        { value: 'tracker-github', label: 'tracker-github' },
        { value: 'tracker-linear', label: 'tracker-linear' },
      ],
    },
  ]);
  assert.deepEqual([github.handed.length, linear.handed.length], [0, 1]);
  assert.equal(linear.handed[0]!.forgeConfigured, false);
  assert.deepEqual((await w.config()).projects.site, { sync: false, 'tracker-linear': { team: 'ENG' } });
  assert.deepEqual(scene.said, [
    'site has no source host (no forge configured); its directory is untracked and holds a note. Configured for tracker-linear. Restart `aivi serve` to index it.',
  ]);

  assert.equal(await w.run(), undefined);
  assert.equal(scene.said.at(-1), 'Setup stopped. Nothing was written.');
});

test('a second lane array, or a config the schema refuses, stops the wizard and leaves the config as it was', async t => {
  const tracker = contributor('tracker-linear', 'tracker', { id: 'site', lanes: [{ name: 'Todo', queue: true }] });
  const board = contributor('board', undefined, { id: 'site', lanes: [{ name: 'Doing', queue: true }] });
  const w = await wizard(t, {
    plugins: { 'tracker-linear': {}, board: {} },
    contributors: [tracker.entry, board.entry],
  });
  const before = await readFile(w.configPath, 'utf8');

  assert.equal(await w.run(), undefined);
  assert.equal(
    scene.said.at(-1),
    'Setup stopped: board also named a lane array; a project has one workflow. Nothing further was written.',
  );
  assert.equal(await readFile(w.configPath, 'utf8'), before);

  scene.contributors = [tracker.entry];
  scene.refusal = 'projects.site.lanes: a queue lane takes no agent';
  assert.equal(await w.run(), undefined);
  assert.equal(
    scene.said.at(-1),
    'Setup stopped: projects.site.lanes: a queue lane takes no agent. Nothing further was written.',
  );
  assert.equal(await readFile(w.configPath, 'utf8'), before, 'the old bytes return');
  assert.equal(process.exitCode, 1);
});
