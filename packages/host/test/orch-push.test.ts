import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrFacts } from '@aivi/plugin/forge';
import { ToolError } from '../src/tools.ts';
import { call, calls, fakeForge, type GitAnswers, pull, repo, scriptedGit, seeded, world } from './orch-fixture.ts';

const branch = 'me/t-1';
const remote = `refs/remotes/origin/${branch}`;
const onBranch: GitAnswers = {
  'symbolic-ref --quiet --short HEAD': branch,
  'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
};
const published: GitAnswers = { ...onBranch, [`rev-parse --verify --quiet ${remote}`]: 'the-tip' };
const unreadable = { fail: 'fatal: not a git repository' };

/** The remote already holds the branch: how far each side is ahead of the other. */
const counts = (ahead: string | { fail: string }, behind: string | { fail: string }): GitAnswers => ({
  ...published,
  [`rev-list --count ${remote}..HEAD`]: ahead,
  [`rev-list --count HEAD..${remote}`]: behind,
});

interface Case {
  name: string;
  tool: 'pushTool' | 'syncTool' | 'prTool';
  input?: Record<string, unknown>;
  git: GitAnswers;
  /** The pull request the forge knows over the branch. */
  existing?: PrFacts;
  returns?: unknown;
  refused?: [status: number, message: string];
  pushed?: unknown[][];
}

const cases: Case[] = [
  {
    name: 'aivi_push says plainly that the directory does not read as a git checkout',
    tool: 'pushTool',
    git: counts(unreadable, unreadable),
    refused: [500, 'This directory does not read as a git checkout: /checkout'],
  },
  {
    name: 'aivi_push treats a remote it cannot compare as a person’s work: it merges it in, then pushes without force',
    tool: 'pushTool',
    git: {
      ...counts('2', '1'),
      [`cherry HEAD ${remote}`]: unreadable,
      [`merge --no-edit --quiet ${remote}`]: '',
    },
    returns: { pushed: true, branch },
    pushed: [[repo, '/checkout', branch]],
  },
  {
    name: 'aivi_push names a merge git refused even when no file is in conflict',
    tool: 'pushTool',
    git: {
      ...counts('2', '1'),
      [`cherry HEAD ${remote}`]: '+ abc111',
      [`merge --no-edit --quiet ${remote}`]: { fail: 'fatal: refusing to merge unrelated histories' },
      'diff --name-only --diff-filter=U': '',
    },
    refused: [409, `Could not merge origin/${branch}: fatal: refusing to merge unrelated histories`],
  },
  {
    name: 'aivi_push, with nothing to push and nothing to bring in, says only that the remote has every commit',
    tool: 'pushTool',
    git: counts('0', '0'),
    refused: [409, `Nothing to push: origin/${branch} already has every commit here.`],
  },
  {
    name: 'aivi_sync on a detached HEAD says the refs are fresh and counts nothing',
    tool: 'syncTool',
    git: { 'symbolic-ref --quiet --short HEAD': unreadable },
    returns: { synced: true, note: 'detached HEAD: refs are fresh, no branch to count against' },
  },
  {
    name: 'aivi_sync with no default branch known counts the branch only',
    tool: 'syncTool',
    git: { ...counts('2', '0'), 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': unreadable },
    returns: { synced: true, branch, behind: '0', ahead: '2' },
  },
  {
    name: 'aivi_pr answers an open pull request without saying commits were pushed when none were',
    tool: 'prTool',
    input: { title: 'Widget' },
    git: counts('0', '0'),
    existing: pull(),
    returns: { pull: pull().url, state: 'open' },
  },
  {
    name: 'aivi_pr with no pull request and nothing to push says that no pull request stands for the branch',
    tool: 'prTool',
    input: { title: 'Widget' },
    git: counts('0', '0'),
    refused: [
      409,
      `Nothing to push: origin/${branch} already has every commit here, and no pull request stands for the branch.`,
    ],
  },
];

for (const { name, tool, input = {}, git, existing, returns, refused, pushed = [] } of cases) {
  test(name, async () => {
    const w = world({ deps: { git: scriptedGit(git) } });
    const forge = fakeForge();
    forge.prForBranch.does(async () => existing);
    w.forges.register(forge);
    const run = seeded(w);

    const done = w.orchestrator[tool](call(run, input));

    if (refused)
      await assert.rejects(
        done,
        (error: unknown) => error instanceof ToolError && error.status === refused[0] && error.message === refused[1],
      );
    else assert.deepEqual(await done, returns);
    assert.deepEqual(calls(forge.push), pushed);
  });
}
