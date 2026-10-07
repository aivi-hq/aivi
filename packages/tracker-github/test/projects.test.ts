import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '@aivi/core';
import { assistantAgent, githubProjectSchema, githubSchema } from '../src/config.ts';
import { githubRepoCollisions, projectGithub, writeProjectGithub } from '../src/projects.ts';

test('the block keeps no facts by default, and names the human label and the pool', () => {
  const config = githubSchema.parse({});
  assert.equal(config.humanLabel, 'needs-human');
  assert.equal(config.resource, 'local-model');
  assert.equal(config.progress, 'tools');
  assert.equal(config.trust, 'members', 'the divider line is the default on a public repository');
  assert.throws(() => githubSchema.parse({ trust: 'everyone ' }), /trust/, 'one space is not a tier');
  assert.equal(assistantAgent(undefined), 'assistant');
  assert.equal(assistantAgent(config), 'assistant');
  assert.equal(assistantAgent(githubSchema.parse({ agent: 'helper' })), 'helper');
});

test('the project section names one board and at least one repository', () => {
  assert.deepEqual(githubProjectSchema.parse({ board: 1, repos: ['acme/shop'] }), {
    board: 1,
    repos: ['acme/shop'],
  });
  assert.throws(() => githubProjectSchema.parse({ board: 0, repos: ['acme/shop'] }), /board/);
  assert.throws(() => githubProjectSchema.parse({ board: 1.5, repos: ['acme/shop'] }), /board/);
  assert.throws(() => githubProjectSchema.parse({ board: 1, repos: [] }), /repos/);
  assert.throws(
    () => githubProjectSchema.parse({ board: 1, repos: ['acme/shop'], teams: ['no'] }),
    /teams/,
    'the section is strict: a Linear word typed here is said, not ignored',
  );
});

test('projectGithub merges the create lane from defaults; no section means no routing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  await mkdir(join(root, 'projects/other/source'), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      knowledge: [{ id: 'company', path: 'kb' }],
      projectDefaults: { 'tracker-github': { createLane: 'Backlog' } },
      projects: {
        site: { 'tracker-github': { board: 1, repos: ['acme/shop'] } },
        other: { 'tracker-github': { board: 2, repos: ['acme/tools'], createLane: 'Triage Own' } },
      },
    }),
  );
  const loaded = await loadConfig(config);
  assert.deepEqual(projectGithub(loaded, 'site'), { board: 1, repos: ['acme/shop'], createLane: 'Backlog' });
  assert.deepEqual(projectGithub(loaded, 'other'), {
    board: 2,
    repos: ['acme/tools'],
    createLane: 'Triage Own',
  });
});

test('a repository feeds one board: every collision is said, not just the first', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  await mkdir(join(root, 'projects/other/source'), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      knowledge: [{ id: 'company', path: 'kb' }],
      projects: {
        site: { 'tracker-github': { board: 1, repos: ['acme/shop', 'acme/shared'] } },
        other: { 'tracker-github': { board: 2, repos: ['acme/shared'] } },
      },
    }),
  );
  const collisions = githubRepoCollisions(await loadConfig(config));
  assert.equal(collisions.length, 1);
  assert.match(collisions[0]!, /acme\/shared/);
  assert.match(collisions[0]!, /already feeds project site/);
});

test('writeProjectGithub writes the section and core lanes, and restores what it broke', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-projects-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await writeFile(config, `${JSON.stringify({ version: 1, knowledge: [{ id: 'company', path: 'kb' }] }, null, 2)}\n`);
  await mkdir(join(root, 'projects/site/source'), { recursive: true });

  const written = await writeProjectGithub(config, 'site', { board: 1, repos: ['acme/shop'] });
  assert.deepEqual(written, { id: 'site', board: 1, repos: ['acme/shop'] });
  const raw = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(raw.projects, { site: { 'tracker-github': { board: 1, repos: ['acme/shop'] } } });
  assert.deepEqual(raw.knowledge, [{ id: 'company', path: 'kb' }], 'the rest of the file is kept');

  // Given lanes go to the project's **core** array; the section keeps board and repos.
  await writeProjectGithub(config, 'site', {
    board: 1,
    repos: ['acme/shop'],
    lanes: [
      { name: 'Triage', worktree: true },
      { name: 'Dev', agent: 'dev', worktree: true },
    ],
  });
  const again = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(again.projects.site.lanes, [
    { name: 'Triage', worktree: true },
    { name: 'Dev', agent: 'dev', worktree: true },
  ]);
  assert.equal(again.projects.site['tracker-github'].lanes, undefined);

  // A repository that already feeds another project refuses the write, and
  // the previous bytes stand.
  await mkdir(join(root, 'projects/other/source'), { recursive: true });
  raw.projects.other = { 'tracker-github': { board: 2, repos: ['acme/second'] } };
  await writeFile(config, JSON.stringify(raw, null, 2));
  const before = await readFile(config, 'utf8');
  await assert.rejects(
    writeProjectGithub(config, 'site', { board: 1, repos: ['acme/second'] }),
    /acme\/second already feeds project other/,
  );
  assert.equal(await readFile(config, 'utf8'), before, 'a refused write restores the bytes');

  await assert.rejects(writeProjectGithub(config, 'site', { board: 1, repos: [] }), /at least one repositor/i);
});
