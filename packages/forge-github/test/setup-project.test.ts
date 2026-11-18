/** What the clone contributor decides from a person's answers, with no
 *  network and no git: the name a repository suggests, which repository the
 *  person is asked for, and what stops the flow before a directory is made.
 *  A checkout that is already there and the clone itself are not proved
 *  here: the contributor calls git directly.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { PROJECT_ID } from '@aivi/core';
import { GitHubApp } from '@aivi/github';
import { PluginSetupCancelled, type ProjectSetupContext } from '@aivi/plugin';
import { cancelSetup, setupFixture } from '../../plugin/test/setup-fixture.ts';
import { contributor, suggestedProjectId } from '../src/setup-project.ts';

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

/** What GitHub says of the app's grant. The forge keeps one app connection
 *  for the whole process, so one app answers every test here and each test
 *  sets what it says. The token is always refused: the flow stops there,
 *  one step before the forge reaches git. */
const github: { granted: string[] | Error; reads: boolean } = { granted: [], reads: true };
const app = {
  appSlug: 'aivi-app',
  installationId: 42,
  repositories: async () => {
    if (github.granted instanceof Error) throw github.granted;
    return github.granted.map(id => ({ id }));
  },
  repository: async () => (github.reads ? { defaultBranch: 'main' } : undefined),
  gitToken: async (): Promise<string> => {
    throw new Error('GitHub refused the installation token');
  },
};

/** A home, the person's scripted answers, and the context the runner hands
 *  the forge; `projectId` is the name an earlier role settled. */
async function wizard(t: TestContext, answers: unknown[], projectId?: string) {
  const home = await mkdtemp(join(tmpdir(), 'aivi-forge-project-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.mock.method(GitHubApp, 'connect', async () => app as unknown as GitHubApp);
  const h = setupFixture(t, answers);
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
    ...(projectId ? { projectId } : {}),
  };
  return { ...h, ctx, home };
}

test('the forge offers the granted repositories, proves the pick, and asks for the project name', async t => {
  github.granted = ['acme/site', 'acme/docs'];
  github.reads = true;
  const h = await wizard(t, ['acme/site', 'my-site']);
  await assert.rejects(contributor.setup(h.ctx), /GitHub refused the installation token/);

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
  assert.equal(existsSync(join(h.home, 'projects')), false, 'nothing is made before the token is in hand');
});

test('a name an earlier role settled is not asked again', async t => {
  github.granted = ['acme/site'];
  github.reads = true;
  const h = await wizard(t, ['acme/site'], 'site');
  await assert.rejects(contributor.setup(h.ctx), /GitHub refused the installation token/);
  assert.deepEqual(h.spinners[0]!.stop.mock.calls[0]!.arguments, ['The app can see 1 repository']);
  assert.deepEqual(
    h.questions.map(question => question.message),
    ['Which GitHub repository is this project?'],
  );
});

test('a grant that cannot be listed leaves the typed question, and its answer is still refereed', async t => {
  github.granted = new Error('Bad credentials');
  github.reads = false;
  const h = await wizard(t, ['https://gitlab.com/acme/site', 'acme/site']);
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
});

test('a cancelled question stops the forge before anything is made', async t => {
  github.granted = ['acme/site'];
  github.reads = true;
  const h = await wizard(t, [cancelSetup, 'acme/site', cancelSetup]);
  await assert.rejects(contributor.setup(h.ctx), PluginSetupCancelled, 'which repository');
  await assert.rejects(contributor.setup(h.ctx), PluginSetupCancelled, 'the project name');
  assert.equal(existsSync(join(h.home, 'projects')), false);
});
