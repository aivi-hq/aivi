/** The board as the eligibility walk reads it: what sits in a lane, what the
 *  walk may start, and how a ticket enters a lane. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getLogger, loadConfig } from '@aivi/core';
import { GithubClient } from '../src/client.ts';
import { githubSchema } from '../src/config.ts';
import { githubBoard, issueDossier } from '../src/work.ts';
import { boardFieldsAnswer, connectApp, connectRoutes, graphql, issueNode, type Seen, scripted } from './github-api.ts';

const log = getLogger(['aivi', 'test']);

async function boardWith(routes: Record<string, (call: Seen) => any>, extraProject: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aivi-github-board-'));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      knowledge: [{ id: 'company', path: 'kb' }],
      projects: { site: { 'tracker-github': { board: 1, repos: ['acme/shop'] }, ...extraProject } },
    }),
  );
  const loaded = await loadConfig(config);
  const script = scripted(connectRoutes(routes));
  const client = new GithubClient(await connectApp(script.fetch));
  return {
    board: githubBoard(githubSchema.parse({ humanLabel: 'needs-human' }), { loaded }, client, log),
    script,
    root,
  };
}

test('the walk speaks for the projects that name a board, and only those', async t => {
  const { board, root } = await boardWith({});
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(board.projects(), ['site']);
});

test('a lane answers its tickets in order; delegates, human labels and closed tickets stay out', async t => {
  const { board, script, root } = await boardWith({
    'POST /graphql': graphql({
      OpenIssues: () => ({
        repository: {
          issues: {
            nodes: [
              issueNode({ number: 41, lane: 'Todo' }),
              issueNode({ number: 42, lane: 'Todo', agent: 'aivi-agent' }),
              issueNode({ number: 43, lane: 'Todo', labels: ['needs-human'] }),
              issueNode({ number: 44, lane: 'In Progress' }),
              issueNode({ number: 45, lane: null }),
              issueNode({ number: 46, lane: 'Todo', blockedBy: [{ number: 40 }] }),
            ],
          },
        },
      }),
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const tickets = await board.tickets('site', 'Todo');
  assert.deepEqual(tickets, [
    { id: 'acme/shop#41', blocked: false },
    { id: 'acme/shop#46', blocked: true },
  ]);
  assert.ok(!script.calls().some(c => c.startsWith('POST /repos')), 'the walk reads the board, not the comment trail');
});

test('a lane no repository feeds answers empty without asking GitHub at all', async t => {
  const { board, root } = await boardWith({ 'POST /graphql': graphql({}) });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await board.tickets('other', 'Todo'), []);
});

test('the walk moves a ticket to a lane the board carries, and says the ones it does not', async t => {
  const mutations: string[] = [];
  const { board, root } = await boardWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: 'Todo' }) } }),
      SetSelect: (v: any) => {
        mutations.push(`set:${v.optionId}`);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await board.moveTo('site', 'acme/shop#47', 'In Progress');
  assert.deepEqual(mutations, ['set:opt_prog']);
  await assert.rejects(board.moveTo('site', 'acme/shop#47', 'Review'), /no Status option "Review"/);
  await assert.rejects(board.moveTo('other', 'acme/shop#47', 'Todo'), /project other has no GitHub board/);
});

test('the ticket’s words for the stages: identifier, team, and the lane on its own board', async t => {
  const { board, root } = await boardWith({
    'POST /graphql': graphql({ IssueFacts: () => ({ repository: { issue: issueNode({ lane: 'Todo' }) } }) }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await board.issue('acme/shop#47'), {
    identifier: 'acme/shop#47',
    title: 'Fix it',
    description: 'please',
    teamId: 'acme/shop',
    stateName: 'Todo',
    branchName: '',
  });
});

test('a deleted ticket reads as gone, and the stage says so', async t => {
  const { board, root } = await boardWith({
    'POST /graphql': graphql({ IssueFacts: () => ({ repository: { issue: null } }) }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(board.issue('acme/shop#47'), /answers nothing/);
});

test('the dossier is the ticket’s own words, the same for every way the worker was reached', () => {
  assert.equal(
    issueDossier({ identifier: 'acme/shop#47', title: 'Fix it', description: 'please' }),
    '<issue identifier="acme/shop#47"><title>Fix it</title><description>please</description></issue>',
  );
  assert.equal(
    issueDossier({ identifier: 'x#1', title: 't', description: null }),
    '<issue identifier="x#1"><title>t</title><description></description></issue>',
  );
});
