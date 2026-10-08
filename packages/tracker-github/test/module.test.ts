/**
 * The module as a **follower**: it registers its stages with the host's
 * orchestrator, drives its closings against GitHub's real answers, and posts
 * into the worker's OpenCode session itself — answers through the open form,
 * interjections as steers. These tests run module + the real GitHub adapter
 * over a scripted GitHub + a stub orchestrator; the full orchestrator
 * lifecycle (leases, lanes, queue) is the host's own suite, and Linear's
 * module test proves the mirrored decisions there.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getLogger, type LoadedConfig, loadConfig } from '@aivi/core';
import { webhookSignature } from '@aivi/github';
import { Store } from '@aivi/host';
import type { AiviServices, PublicRequest, RunView } from '@aivi/plugin';
import { GithubClient } from '../src/client.ts';
import { githubSchema } from '../src/config.ts';
import { RunLinks } from '../src/links.ts';
import { branchFor, createGithubModule, GITHUB } from '../src/module.ts';
import { GithubPlatform } from '../src/tracker.ts';
import type { GithubBoard } from '../src/work.ts';
import {
  boardFieldsAnswer,
  commentJson,
  connectApp,
  connectRoutes,
  graphql,
  issueNode,
  type Seen,
  scripted,
} from './github-api.ts';

const SECRET = 'test-webhook-secret';
const log = getLogger(['aivi', 'test']);

test('the branch is generated from the ticket (D8): number first, words after', () => {
  assert.equal(branchFor('acme/shop#47', 'Fix the Login, Please!'), 'aivi/47-fix-the-login-please');
  assert.equal(branchFor('acme/shop#47', '……'), 'aivi/47', 'a title with no words still names a branch');
  const long = branchFor('acme/shop#9', 'x'.repeat(200));
  assert.ok(long.startsWith('aivi/9-x') && long.length <= 58, `long titles are cut, not mangled: ${long}`);
  assert.ok(!long.endsWith('-'), 'the cut does not leave a dangling dash');
});

test('the conversation platform is a worker platform: work effects, GitHub words', () => {
  assert.equal(GITHUB.id, 'github');
  assert.equal(GITHUB.effects, 'work');
  assert.equal(GITHUB.describeSpeaker?.({ name: 'Ann', user: '1' }), '[GitHub follow-up from Ann]');
});

/** What a test turns and reads on the stub world. */
interface Harness {
  services: AiviServices;
  trackers: any[];
  route: (request: PublicRequest) => Promise<{ status: number; body: unknown }>;
  wakes: string[];
  stops: { id: string; why: string }[];
  answers: { session: string; text: string; form?: string | undefined }[];
  prompts: { text: string; delivery?: string }[];
  forms: { id: string }[];
  wakeListeners: (() => void)[];
  state: { active?: RunView; bySession?: RunView };
  loaded: LoadedConfig;
  store: Store;
  links: RunLinks;
  root: string;
}

async function stubServices(loaded: LoadedConfig, store: Store): Promise<Harness> {
  const trackers: any[] = [];
  const wakes: string[] = [];
  const stops: { id: string; why: string }[] = [];
  const answers: { session: string; text: string; form?: string | undefined }[] = [];
  const prompts: { text: string; delivery?: string }[] = [];
  const wakeListeners: (() => void)[] = [];
  const forms: { id: string }[] = [];
  const state: { active?: RunView; bySession?: RunView } = {};
  let route: any;
  const services = {
    loaded,
    store,
    knowledge: {},
    opencode: async () => ({
      session: {
        form: { list: async () => forms },
        prompt: async ({ text, delivery }: any) => void prompts.push({ text, delivery }),
      },
    }),
    events: { watch: () => () => {} },
    signal: new AbortController().signal,
    log,
    channels: { register: () => () => {} },
    routes: {
      register: (_path: string, handler: any) => {
        route = handler;
        return () => {};
      },
    },
    tasks: {},
    tools: {},
    forges: {},
    orchestrator: {
      addTracker: (t: any) => void trackers.push(t),
      wake: async (project?: string) => void wakes.push(project ?? '*'),
      stop: async (id: string, why: string) => void stops.push({ id, why }),
      answer: async (session: string, text: string, form?: string) => {
        answers.push({ session, text, form });
        return { resumed: true } as const;
      },
      activeRun: () => state.active,
      runBySession: (s: string) => state.bySession ?? (s === 'ses_worker' ? state.active : undefined),
      cancelWaiting: () => {},
    },
    wake: () => {},
    onWake: (l: () => void) => {
      wakeListeners.push(l);
      return () => {};
    },
    fail: (error: unknown) => {
      throw error;
    },
  } as unknown as AiviServices;
  return {
    services,
    trackers,
    route: (request: PublicRequest) => route(request),
    wakes,
    stops,
    answers,
    prompts,
    forms,
    wakeListeners,
    state,
    loaded,
    store,
    links: new RunLinks(store),
    root: loaded.path.replace(/\/config\.json$/, ''),
  };
}

/** A home whose project feeds one board, with a store of its own. */
async function home(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'aivi-github-module-'));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      knowledge: [{ id: 'company', path: 'kb' }],
      projects: {
        site: {
          lanes: [
            // A full workflow shape for the wake tests: the queue feeds a
            // working lane, Done is a human lane (the person's answer to the
            // kind question), and options named nowhere here are missing.
            { name: 'Backlog', queue: true },
            { name: 'Todo', agent: 'dev', worktree: false },
            { name: 'In Progress', agent: 'dev', worktree: false },
            { name: 'Done' },
          ],
          'tracker-github': { board: 1, repos: ['acme/shop'] },
        },
      },
    }),
  );
  return stubServices(await loadConfig(config), new Store(':memory:'));
}

const runView = (over: Partial<RunView> = {}): RunView =>
  ({
    id: 'run-1',
    projectId: 'site',
    trackerId: 'tracker-github',
    ticketId: 'acme/shop#47',
    lane: 'Todo',
    agent: 'dev',
    state: 'working',
    updatedAt: 1,
    sessionId: 'ses_worker',
    ...over,
  }) as RunView;

/** Deliver a webhook through the module's own route: seal and all. */
async function deliver(h: Harness, event: string, payload: unknown, id = `dlv-${Math.random()}`) {
  const body = Buffer.from(JSON.stringify(payload));
  return h.route({
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': id,
      'x-hub-signature-256': webhookSignature(SECRET, body),
    },
    body,
  });
}

const settled = () => new Promise(resolve => setTimeout(resolve, 30));

/** Start the module over a scripted GitHub; everything answers the tests.
 *  A test that scripts no `POST /graphql` still gets its board warmed —
 *  `platform.warm()` asks once at the start of every life. */
async function started(
  routes: Record<string, (call: Seen) => any>,
  options: { board?: GithubBoard; harness?: Harness } = {},
) {
  const h = options.harness ?? (await home());
  const script = scripted(
    connectRoutes({
      'POST /graphql': graphql({ BoardFields: v => boardFieldsAnswer('aivi-hq', v) }),
      ...routes,
    }),
  );
  const client = new GithubClient(await connectApp(script.fetch));
  const platform = new GithubPlatform(h.loaded, client, SECRET);
  await platform.warm();
  const board: GithubBoard = options.board ?? {
    projects: () => ['site'],
    tickets: async () => [],
    moveTo: async () => {},
    issue: async () => ({
      identifier: 'acme/shop#47',
      title: 'Fix it',
      description: 'please',
      teamId: 'acme/shop',
      stateName: 'Todo',
      branchName: '',
    }),
  };
  const module = createGithubModule(
    githubSchema.parse({}),
    async () => platform,
    () => board,
  );
  const stopping = await module.start(h.services);
  return { h, script, platform, stopping };
}

test('a run walks its stages: the status comment opens it, the pair is recorded, the branch is generated', async t => {
  const { h, script, stopping } = await started({
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 1234, html_url: 'u' } }),
  });
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    const work = h.trackers[0]!;
    const entry = await work.initWork(runView());
    assert.equal(
      entry.summary,
      '<issue identifier="acme/shop#47"><title>Fix it</title><description>please</description></issue>',
    );
    assert.equal(entry.branch, 'aivi/47-fix-it');
    const posted = script.bodies('/repos/acme/shop/issues/47/comments')[0]!;
    assert.match(posted.body, /Preparing the workspace/);
    // The pair stands before anything can arrive; `ready` attaches the session.
    const link = h.links.byAgentSession('acme/shop#47:c1234');
    assert.equal(link?.ticketId, 'acme/shop#47');
    work.ready(runView());
    assert.equal(h.links.byAgentSession('acme/shop#47:c1234')?.opencodeSession, 'ses_worker');
    work.ready(runView());
    assert.equal(h.links.byAgentSession('acme/shop#47:c1234')?.opencodeSession, 'ses_worker', 'a replay says nothing');
  } finally {
    await stopping.stop();
  }
});

test('the closing is spoken in our order: final comment, frozen line, cleared Agent — and the pair settles', async t => {
  const mutations: string[] = [];
  const { h, script, stopping } = await started({
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 99, html_url: 'u' } }),
    'GET /repos/acme/shop/issues/47/comments': () => ({
      status: 200,
      body: [commentJson(1234, 'aivi-agent[bot]', 'Bot', '**Working**\n<!-- {"kind":"status"} -->')],
    }),
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Working** · x\n\n<!-- {"kind":"status"} -->\n' },
    }),
    'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ agent: 'aivi-agent' }) } }),
      ClearSelect: () => {
        mutations.push('clear');
        return { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
  });
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    const work = h.trackers[0]!;
    h.links.bind('acme/shop#47:c1234', 'acme/shop#47');
    h.links.attach('acme/shop#47', 'ses_worker');
    await work.endWork(runView({ outcome: { kind: 'success', summary: 'Shipped it.' } } as any));
    const posted = script.bodies('/repos/acme/shop/issues/47/comments')[0]!;
    assert.match(posted.body, /Shipped it\./);
    assert.match(posted.body, /"kind":"closing","status":1234,"ok":true/);
    assert.ok(script.calls().includes('PATCH /repos/acme/shop/issues/comments/1234'), 'the line froze');
    assert.deepEqual(mutations, ['clear'], 'every ending releases the delegate');
    assert.notEqual(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined, 'the pair settled');
  } finally {
    await stopping.stop();
  }
});

test('a closing that GitHub refuses stays owed, cries once, and lands on the next wake', async t => {
  let broken = true;
  const { h, script, stopping } = await started({
    'POST /repos/acme/shop/issues/47/comments': () =>
      broken ? { status: 502, body: { message: 'bad gateway' } } : { status: 201, body: { id: 99, html_url: 'u' } },
    'GET /repos/acme/shop/issues/47/comments': () => ({ status: 200, body: [] }),
    'GET /repos/acme/shop/issues/comments/1234': () => ({
      status: 200,
      body: { body: '**Working**\n<!-- {"kind":"status"} -->' },
    }),
    'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ agent: 'aivi-agent' }) } }),
      ClearSelect: () => ({ clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } }),
    }),
  });
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    const work = h.trackers[0]!;
    h.links.bind('acme/shop#47:c1234', 'acme/shop#47');
    h.links.attach('acme/shop#47', 'ses_worker');
    await assert.rejects(work.endWork(runView({ outcome: { kind: 'success', summary: 'Shipped it.' } } as any)));
    assert.equal(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined, 'still owed');
    // The person heard it NOW: the conversation was told. Said once, never
    // repeated on the retry.
    const cries = script.bodies('/repos/acme/shop/issues/47/comments').length;
    assert.ok(cries >= 1, 'the failure was said on the ticket');
    broken = false;
    for (const listener of h.wakeListeners) listener();
    await settled();
    assert.notEqual(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined, 'the wake paid the debt');
  } finally {
    await stopping.stop();
  }
});

test('the boot pass catches up closings that died in an outage, without saying anything twice', async t => {
  const h = await home();
  // A previous life left an owed pair behind: the closing comment already
  // landed (so nothing is said again), the freeze and the clear did not.
  h.links.bind('acme/shop#47:c1234', 'acme/shop#47', 100);
  h.links.attach('acme/shop#47', 'ses_worker');
  const ended = runView({ state: 'completed', outcome: { kind: 'success', summary: 'Shipped it.' } } as any);
  h.state.bySession = ended;
  const { script, stopping } = await started(
    {
      'GET /repos/acme/shop/issues/47/comments': () => ({
        status: 200,
        body: [
          commentJson(1234, 'aivi-agent[bot]', 'Bot', '**Working** · x\n<!-- {"kind":"status"} -->'),
          commentJson(
            99,
            'aivi-agent[bot]',
            'Bot',
            'Shipped it.\n\n<!-- {"kind":"closing","status":1234,"ok":true} -->',
          ),
        ],
      }),
      'GET /repos/acme/shop/issues/comments/1234': () => ({
        status: 200,
        body: { body: '**Working** · x\n\n<!-- {"kind":"status"} -->\n' },
      }),
      'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
      'POST /graphql': graphql({
        BoardFields: v => boardFieldsAnswer('aivi-hq', v),
        IssueFacts: () => ({ repository: { issue: issueNode({ agent: 'aivi-agent' }) } }),
        ClearSelect: () => ({ clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } }),
      }),
    },
    {
      harness: h,
      board: {
        projects: () => ['site'],
        tickets: async () => [],
        moveTo: async () => {},
        issue: async () => undefined,
      },
    },
  );
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    assert.notEqual(h.links.byAgentSession('acme/shop#47:c1234')?.endedAt, undefined, 'boot paid the debt');
    const posted = script.bodies('/repos/acme/shop/issues/47/comments');
    assert.deepEqual(posted, [], 'the catch-up says nothing twice: resultShown spoke first');
    assert.ok(
      script.calls().includes('PATCH /repos/acme/shop/issues/comments/1234'),
      'the half-landed ceremony finished',
    );
  } finally {
    await stopping.stop();
  }
});

test('a person’s comment answers an open form or steers a running turn — never through the orchestrator’s prompt path', async t => {
  const { h, stopping } = await started({
    'GET /repos/acme/shop/issues/47/comments': () => ({ status: 200, body: [] }),
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 5, html_url: 'u' } }),
  });
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    h.state.active = runView({ sessionId: 'ses_worker' });
    // A form stands: the message is an answer.
    h.forms.push({ id: 'frm_open' });
    await deliver(h, 'issue_comment', {
      action: 'created',
      comment: { id: 7, body: 'use main', user: { login: 'person', type: 'User' }, author_association: 'MEMBER' },
      issue: { number: 47 },
      repository: { full_name: 'acme/shop' },
    });
    await settled();
    assert.deepEqual(h.answers, [{ session: 'ses_worker', text: 'use main', form: 'frm_open' }]);
    // No form: the same words steer.
    h.forms.length = 0;
    await deliver(
      h,
      'issue_comment',
      {
        action: 'created',
        comment: {
          id: 8,
          body: 'also fix the test',
          user: { login: 'person', type: 'User' },
          author_association: 'MEMBER',
        },
        issue: { number: 47 },
        repository: { full_name: 'acme/shop' },
      },
      'dlv-2',
    );
    await settled();
    assert.deepEqual(h.prompts, [{ text: 'also fix the test', delivery: 'steer' }]);
  } finally {
    await stopping.stop();
  }
});

test('a hand-set Agent value with no run working the ticket gets the fixed refusal, cleared and said', async t => {
  let agentCleared = 0;
  const { h, script, stopping } = await started({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      NodeRef: () => ({ node: { number: 47, repository: { owner: { login: 'acme' }, name: 'shop' } } }),
      IssueFacts: () => ({ repository: { issue: issueNode({ agent: 'aivi-agent' }) } }),
      ClearSelect: () => {
        agentCleared++;
        return { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
    'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 5, html_url: 'u' } }),
  });
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    await deliver(h, 'projects_v2_item', {
      action: 'edited',
      changes: { field_name: 'Agent', field_value: { from: '', to: 'aivi-agent' } },
      projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: 'I_47' },
    });
    await settled();
    assert.equal(agentCleared, 1, 'the value was cleared: the app must not sit on the ticket');
    const said = script.bodies('/repos/acme/shop/issues/47/comments');
    assert.equal(said.length, 1);
    assert.match(said[0]!.body, /nothing I can do at this time/);
    assert.match(said[0]!.body, /work reaches me through the board/);
  } finally {
    await stopping.stop();
  }
});

test('a lane move a person made wakes the walk, and the run works on while its lane keeps its agent', async t => {
  const { h, stopping } = await started({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      NodeRef: () => ({ node: { number: 47, repository: { owner: { login: 'acme' }, name: 'shop' } } }),
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: 'In Progress', agent: 'aivi-agent' }) } }),
    }),
  });
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    h.state.active = runView({ sessionId: 'ses_worker' }); // the run works under the same Agent value
    await deliver(h, 'projects_v2_item', {
      action: 'edited',
      changes: { field_name: 'Status', field_value: { from: 'Todo', to: 'In Progress' } },
      projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: 'I_47' },
    });
    await settled();
    assert.deepEqual(h.stops, [], 'the lane still speaks the run’s agent: the run works on');
    assert.ok(h.wakes.includes('site'), 'and the walk woke to look');
  } finally {
    await stopping.stop();
  }
});

/** The three wake answers of the lane model: a working lane or the queue
 *  wakes, a human lane that is not the queue and a lane missing from the
 *  array are out of sight, out of mind. */
const statusMove = (from: string, to: string) => ({
  action: 'edited',
  changes: { field_name: 'Status', field_value: { from, to } },
  projects_v2_item: { project_node_id: 'PVT_board_1', content_node_id: 'I_47' },
});
const answersLane = (lane: string) => ({
  'POST /graphql': graphql({
    BoardFields: v => boardFieldsAnswer('aivi-hq', v),
    NodeRef: () => ({ node: { number: 47, repository: { owner: { login: 'acme' }, name: 'shop' } } }),
    IssueFacts: () => ({ repository: { issue: issueNode({ lane }) } }),
  }),
});

test('a ticket moved into a human lane is out of sight: the event wakes nothing', async t => {
  const { h, stopping } = await started(answersLane('Done'));
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    const before = h.wakes.length;
    await deliver(h, 'projects_v2_item', statusMove('Todo', 'Done'));
    await settled();
    assert.deepEqual(h.wakes.slice(before), [], 'aivi does not look at tickets in a human lane');
    assert.deepEqual(h.stops, [], 'no run was working the ticket: nothing to stop');
  } finally {
    await stopping.stop();
  }
});

test('a ticket moved to an option named nowhere in the array is out of sight too', async t => {
  const { h, stopping } = await started(answersLane('Release'));
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    const before = h.wakes.length;
    await deliver(h, 'projects_v2_item', statusMove('Todo', 'Release'));
    await settled();
    assert.deepEqual(h.wakes.slice(before), [], 'the missing option is not aivi’s workflow: the event is ignored');
  } finally {
    await stopping.stop();
  }
});

test('a ticket moved into the queue lane still wakes: waiting is how the queue feeds', async t => {
  const { h, stopping } = await started(answersLane('Backlog'));
  t.after(() => rm(h.root, { recursive: true, force: true }));
  try {
    const before = h.wakes.length;
    await deliver(h, 'projects_v2_item', statusMove('In Progress', 'Backlog'));
    await settled();
    assert.ok(h.wakes.slice(before).includes('site'), 'the queue is watched: the walk may hand the next ticket over');
  } finally {
    await stopping.stop();
  }
});
