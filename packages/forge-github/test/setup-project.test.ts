/** What the clone contributor decides from a person's answers: the name a
 *  repository suggests, which repository the person is asked for, what stops
 *  the flow before a directory is made, what it does with a checkout that is
 *  already there, and how it asks for the clone. GitHub and git are answered
 *  here — `@aivi/github` is a module mock, registered before the contributor
 *  is imported — so no test reaches the network or spawns git.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { PROJECT_ID } from '@aivi/core';
import * as github from '@aivi/github';
import { PluginSetupCancelled, type ProjectSetupContext } from '@aivi/plugin';
import { cancelSetup, setupFixture } from '../../plugin/test/setup-fixture.ts';

type GitAnswer = Awaited<ReturnType<typeof github.runGit>>;

/** What GitHub and git answer in one run, and what git was asked. Each test
 *  sets it; the mocks answer from it. */
const scene = {
  granted: [] as string[] | Error | { thrown: unknown },
  reads: true,
  git: [] as GitAnswer[],
  ran: [] as { directory: string; args: string[]; env?: Record<string, string> }[],
};
const app = {
  appSlug: 'aivi-app',
  installationId: 42,
  repositories: async () => {
    if (!Array.isArray(scene.granted)) throw scene.granted instanceof Error ? scene.granted : scene.granted.thrown;
    return scene.granted.map(id => ({ id }));
  },
  repository: async () => (scene.reads ? { defaultBranch: 'main' } : undefined),
  gitToken: async () => 'installation-token',
};
const runGit: typeof github.runGit = async (directory, args, options = {}) => {
  scene.ran.push({ directory, args, ...(options.env ? { env: options.env } : {}) });
  const answer = scene.git.shift();
  assert.ok(answer, `Unscripted git: ${args.join(' ')}`);
  return answer;
};
mock.module('@aivi/github', { exports: { ...github, githubApp: async () => app, runGit } });

const { contributor, suggestedProjectId } = await import('../src/setup-project.ts');

/** A home, the person's scripted answers, and the context the runner hands
 *  the forge; `projectId` is the name an earlier role settled. */
async function wizard(
  t: TestContext,
  given: {
    answers: unknown[];
    granted: string[] | Error | { thrown: unknown };
    reads?: boolean;
    git?: GitAnswer[];
    projectId?: string;
  },
) {
  const home = await mkdtemp(join(tmpdir(), 'aivi-forge-project-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  Object.assign(scene, { granted: given.granted, reads: given.reads ?? true, git: given.git ?? [], ran: [] });
  const h = setupFixture(t, given.answers);
  const ctx: ProjectSetupContext = {
    home,
    configPath: join(home, 'config.json'),
    config: {},
    forgeConfigured: true,
    print: h.print,
    fetch: h.fetch,
    withStore: h.withStore,
    agents: async () => [],
    prompts: { ...h.ctx.prompts, autocomplete: h.ask } as unknown as ProjectSetupContext['prompts'],
    ...(given.projectId ? { projectId: given.projectId } : {}),
  };
  return { ...h, ctx, home };
}

test('a repository name becomes the project name a directory can take', () => {
  assert.equal(suggestedProjectId('widget'), 'widget');
  assert.equal(suggestedProjectId('My-Repo'), 'my-repo');
  assert.equal(suggestedProjectId('aivi.core'), 'aivi-core');
  assert.equal(suggestedProjectId('Under_score'), 'under_score');
});

test('and the suggestion is always a name aivi accepts, never one to be fixed later', () => {
  for (const named of ['widget', 'My-Repo', '123-numbers', '-leading', '_under', 'a b c', 're/po'])
    assert.ok(PROJECT_ID.test(suggestedProjectId(named)), `${named} suggests ${suggestedProjectId(named)}`);
  assert.equal(
    suggestedProjectId('123-numbers'),
    'p-123-numbers',
    'a name that no longer starts with a letter keeps one',
  );
});

test('the forge offers the granted repositories, proves the pick, asks the project name, and clones as the app', async t => {
  const h = await wizard(t, {
    answers: ['acme/site', ' '],
    granted: ['acme/site', 'acme/docs'],
    git: [{ ok: true, stdout: '' }],
  });
  assert.deepEqual(await contributor.setup(h.ctx), { id: 'site', cloned: true, repository: 'acme/site' });

  assert.deepEqual(h.spinners[0]!.stop.mock.calls[0]!.arguments, ['The app can see 2 repositories']);
  assert.deepEqual(h.questions[0]!.options, [
    { value: 'acme/site', label: 'acme/site' },
    { value: 'acme/docs', label: 'acme/docs' },
  ]);
  assert.deepEqual(
    h.log.mock.calls.map(call => call.arguments[0]),
    ['The app reads acme/site (default branch main).'],
  );
  const name = h.questions[1]!;
  assert.equal(name.message, 'Project name');
  assert.equal(name.validate!(''), undefined, 'enter takes the name the repository suggests');
  assert.equal(name.validate!(undefined), undefined);
  assert.equal(name.validate!('my-site'), undefined);
  assert.match(name.validate!('My Site')!, /lowercase letters, digits, dashes and underscores/);

  const project = join(h.home, 'projects', 'site');
  assert.deepEqual(scene.ran, [
    {
      directory: project,
      args: ['clone', '--quiet', 'https://github.com/acme/site.git', join(project, 'source')],
      env: github.gitCredential('installation-token'),
    },
  ]);
  assert.equal(existsSync(project), true, 'the place for the clone is made first');
  assert.deepEqual(h.spinners[1]!.start.mock.calls[0]!.arguments, ['cloning acme/site…']);
  assert.deepEqual(h.spinners[1]!.stop.mock.calls[0]!.arguments, ['Cloned acme/site into projects/site/source.']);
});

test('a clone that git refuses stops the forge and says why', async t => {
  const h = await wizard(t, {
    answers: ['acme/site', 'my-site'],
    granted: ['acme/site'],
    git: [{ ok: false, message: 'Repository not found' }],
  });
  await assert.rejects(contributor.setup(h.ctx), /clone of acme\/site failed: Repository not found/);
  assert.deepEqual(h.spinners[1]!.stop.mock.calls[0]!.arguments, ['could not clone acme/site: Repository not found']);
  assert.equal(
    scene.ran[0]!.directory,
    join(h.home, 'projects', 'my-site'),
    'the name the person typed is the project',
  );
});

test('a checkout already there is taken as it stands when it is this repository, and never taken over when it is not', async t => {
  const h = await wizard(t, {
    answers: ['acme/site', 'acme/site', 'acme/site'],
    granted: ['acme/site'],
    git: [
      { ok: true, stdout: 'https://github.com/acme/site.git\n' },
      { ok: true, stdout: 'https://github.com/other/thing.git\n' },
      { ok: false, message: "error: No such remote 'origin'" },
    ],
    projectId: 'site',
  });
  const source = join(h.home, 'projects', 'site', 'source');
  await mkdir(join(source, '.git'), { recursive: true });

  assert.deepEqual(await contributor.setup(h.ctx), { id: 'site', cloned: true, repository: 'acme/site' });
  assert.equal(
    h.log.mock.calls.at(-1)!.arguments[0],
    'projects/site/source is already a checkout of acme/site; left as it is.',
  );
  await assert.rejects(
    contributor.setup(h.ctx),
    /projects\/site\/source is a checkout of other\/thing\. Move it aside, or choose a project name/,
  );
  await assert.rejects(contributor.setup(h.ctx), /is a checkout of something that is not a GitHub repository/);

  assert.deepEqual(
    scene.ran,
    Array.from({ length: 3 }, () => ({ directory: source, args: ['remote', 'get-url', 'origin'] })),
    'git is only asked what the checkout is: nothing is cloned over it',
  );
  assert.deepEqual(h.spinners[0]!.stop.mock.calls[0]!.arguments, ['The app can see 1 repository']);
  assert.deepEqual(
    h.questions.map(question => question.message),
    Array.from({ length: 3 }, () => 'Which GitHub repository is this project?'),
    'the name an earlier role settled is not asked again',
  );
});

test('a grant that cannot be listed leaves the typed question, and its answer is still refereed', async t => {
  const h = await wizard(t, {
    answers: ['https://gitlab.com/acme/site', 'acme/site'],
    granted: new Error('Bad credentials'),
    reads: false,
  });
  await assert.rejects(contributor.setup(h.ctx), /gitlab\.com is not github\.com, and this forge speaks github\.com/);
  assert.deepEqual(h.spinners[0]!.stop.mock.calls[0]!.arguments, [
    "Could not list the app's repositories: Bad credentials",
  ]);
  const typed = h.questions[0]!;
  assert.equal(typed.options, undefined, 'there is no list to pick from');
  assert.equal(typed.validate!('acme/site'), undefined);
  assert.match(typed.validate!('not a repository')!, /owner\/repo, or as a github\.com URL/);
  assert.match(typed.validate!(undefined)!, /owner\/repo, or as a github\.com URL/);

  await assert.rejects(
    contributor.setup(h.ctx),
    /the app aivi-app cannot see acme\/site through installation #42\. Grant it that repository/,
  );
  assert.equal(existsSync(join(h.home, 'projects')), false, 'nothing is made for a repository the app cannot read');
  assert.deepEqual(scene.ran, [], 'and git is never asked');
});

test('a grant that fails with something that is not an Error is said as it is', async t => {
  const h = await wizard(t, { answers: ['acme/site'], granted: { thrown: 'the network is gone' }, reads: false });

  await assert.rejects(contributor.setup(h.ctx), /the app aivi-app cannot see acme\/site/);

  assert.deepEqual(h.spinners[0]!.stop.mock.calls[0]!.arguments, [
    "Could not list the app's repositories: the network is gone",
  ]);
});

test('an answer that names no repository stops the forge before anything is made', async t => {
  const h = await wizard(t, { answers: ['not a repository'], granted: ['acme/site'] });

  await assert.rejects(contributor.setup(h.ctx), /no repository named/);

  assert.equal(existsSync(join(h.home, 'projects')), false);
  assert.deepEqual(scene.ran, []);
});

test('a cancelled question stops the forge before anything is made', async t => {
  const h = await wizard(t, { answers: [cancelSetup, 'acme/site', cancelSetup], granted: ['acme/site'] });
  await assert.rejects(contributor.setup(h.ctx), PluginSetupCancelled, 'which repository');
  await assert.rejects(contributor.setup(h.ctx), PluginSetupCancelled, 'the project name');
  assert.equal(existsSync(join(h.home, 'projects')), false);
  assert.deepEqual(scene.ran, []);
});
