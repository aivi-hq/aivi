import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubClient, isGoneError, issueRef } from '../src/client.ts';
import {
  BOARD,
  boardFieldsAnswer,
  commentJson,
  connectApp,
  connectRoutes,
  graphql,
  issueNode,
  scripted,
} from './github-api.ts';

async function clientWith(routes: Record<string, (call: any) => any>): Promise<GithubClient> {
  const { fetch } = scripted(connectRoutes(routes));
  const app = await connectApp(fetch);
  return new GithubClient(app);
}

const graphqlBoard = (extra: Record<string, (v: any) => unknown> = {}) =>
  graphql({ BoardFields: v => boardFieldsAnswer('aivi-hq', v), ...extra });

test('issue ids are the words a person types, and only those', () => {
  assert.deepEqual(issueRef(' acme/shop#47 '), { owner: 'acme', name: 'shop', number: 47 });
  assert.throws(() => issueRef('AIV-1'), /owner\/repo#number/);
  assert.throws(() => issueRef('acme/shop'), /owner\/repo#number/);
});

test('a board resolves its Status and Agent fields once, and never asks again', async () => {
  const board = graphqlBoard();
  const { fetch, calls } = scripted(connectRoutes({ 'POST /graphql': board }));
  const app = await connectApp(fetch);
  const client = new GithubClient(app);
  const fields = await client.boardFields(1);
  assert.equal(fields.projectId, BOARD.projectId);
  assert.deepEqual(
    fields.statusOptions.map(o => o.name),
    ['Backlog', 'Todo', 'In Progress', 'Done'],
  );
  assert.deepEqual(fields.agentOptions, [{ id: 'opt_aivi', name: 'aivi-agent' }]);
  const before = calls().length;
  await client.boardFields(1);
  assert.equal(calls().length, before, 'the board is fetched once per start');
});

test('a board without Status or Agent is said by name with its remedy, never fixed by guessing', async () => {
  const noStatus = graphql({
    BoardFields: () => ({
      organization: { projectV2: { id: 'P', fields: { nodes: [{ id: 'F', name: 'Agent', options: [] }] } } },
    }),
  });
  await assert.rejects(
    clientWith({ 'POST /graphql': noStatus }).then(c => c.boardFields(1)),
    /no "Status" single-select field/,
  );
  const noAgent = graphql({
    BoardFields: () => ({
      organization: { projectV2: { id: 'P', fields: { nodes: [{ id: 'F', name: 'Status', options: [] }] } } },
    }),
  });
  await assert.rejects(
    clientWith({ 'POST /graphql': noAgent }).then(c => c.boardFields(1)),
    /no "Agent" single-select field/,
  );
});

test('a board the app cannot read, or one that lists no fields at all, is said by its number', async t => {
  for (const [name, answer, expected] of [
    [
      'a board that is not visible',
      { organization: { projectV2: null } },
      /board 1 is not visible to the app in aivi-hq/,
    ],
    ['an organization that answers nothing', { organization: null }, /board 1 is not visible to the app in aivi-hq/],
    ['a board with no fields', { organization: { projectV2: { id: 'P' } } }, /no "Status" single-select field/],
  ] as const)
    await t.test(name, async () => {
      const client = await clientWith({ 'POST /graphql': graphql({ BoardFields: () => answer }) });
      await assert.rejects(client.boardFields(1), expected);
    });
});

test('fields that carry no options resolve to empty option lists, so no lane can map', async () => {
  const client = await clientWith({
    'POST /graphql': graphql({
      BoardFields: () => ({
        organization: {
          projectV2: {
            id: 'P',
            fields: { nodes: [null, { id: 'F_s', name: 'Status' }, { id: 'F_a', name: 'Agent', options: null }] },
          },
        },
      }),
    }),
  });
  assert.deepEqual(await client.boardFields(1), {
    projectId: 'P',
    number: 1,
    statusFieldId: 'F_s',
    statusOptions: [],
    agentFieldId: 'F_a',
    agentOptions: [],
  });
  assert.deepEqual(await client.laneOptions(1), []);
});

test('an issue reads its board values, dependencies and authors in aivi words', async () => {
  const client = await clientWith({
    'POST /graphql': graphql({
      IssueFacts: () => ({
        repository: {
          issue: issueNode({
            number: 47,
            labels: ['bug'],
            assignees: ['person'],
            lane: 'Todo',
            agent: 'aivi-agent',
            blockedBy: [{ number: 46, closed: true }, { number: 45 }],
          }),
        },
      }),
    }),
  });
  const issue = await client.issue('acme/shop#47');
  assert.equal(issue.ref, 'acme/shop#47');
  assert.equal(issue.state, 'open');
  assert.deepEqual(
    issue.labels.map(l => l.name),
    ['bug'],
  );
  assert.deepEqual(
    issue.assignees.map(a => a.name),
    ['person'],
  );
  assert.deepEqual(client.laneOf(issue, 1), { name: 'Todo', optionId: 'opt_todo' });
  assert.equal(client.agentOn(issue, 1), 'aivi-agent');
  assert.equal(client.laneOf(issue, 2), undefined, 'another board has no item: the ticket is not on it');
  assert.deepEqual(issue.blockedBy, [
    { id: 'acme/shop#46', completed: true },
    { id: 'acme/shop#45', completed: false },
  ]);
});

test('a closed issue is closed whatever the reason, and reads its reason', async () => {
  const client = await clientWith({
    'POST /graphql': graphql({
      IssueFacts: () => ({
        repository: { issue: issueNode({ state: 'CLOSED', stateReason: 'NOT_PLANNED', lane: null }) },
      }),
    }),
  });
  const issue = await client.issue('acme/shop#47');
  assert.equal(issue.state, 'closed');
  assert.equal(issue.stateReason, 'not_planned');
  assert.equal(client.laneOf(issue, 1), undefined, 'off the board: no lane');
});

test('an issue the API answers thinly still reads in aivi words', async () => {
  const client = await clientWith({
    'POST /graphql': graphql({
      IssueFacts: () => ({
        repository: {
          issue: { id: 'I_5', number: 5, title: 'Bare', url: 'https://github.com/acme/shop/issues/5', state: 'OPEN' },
        },
      }),
    }),
  });
  assert.deepEqual(await client.issue('acme/shop#5'), {
    id: 'I_5',
    ref: 'acme/shop#5',
    repo: 'acme/shop',
    number: 5,
    title: 'Bare',
    body: null,
    url: 'https://github.com/acme/shop/issues/5',
    state: 'open',
    stateReason: null,
    labels: [],
    assignees: [],
    projectItems: [],
    blockedBy: [],
  });
});

test('board items and values the API leaves blank give no lane and no delegate', async () => {
  const blank = issueNode({ lane: null });
  blank.projectItems = {
    nodes: [
      null, // an item of a board the app cannot read
      { project: { number: 1 } }, // an item that names nothing but its board
      {
        id: 'PVTI_2',
        project: { number: 2 },
        fieldValues: { nodes: [null, {}, { field: { name: 'Status' } }, { field: { name: 'Agent' } }] },
      },
    ],
  };
  const client = await clientWith({
    'POST /graphql': graphql({ IssueFacts: () => ({ repository: { issue: blank } }) }),
  });
  const issue = await client.issue('acme/shop#47');
  for (const board of [1, 2]) {
    assert.equal(client.laneOf(issue, board), undefined, `board ${board}: no Status value, no lane`);
    assert.equal(client.agentOn(issue, board), undefined, `board ${board}: no Agent value, no delegate`);
  }
});

test('open issues of a repository that answers nothing read as none, and a read that fills its cap says so', async () => {
  const empty = await clientWith({ 'POST /graphql': graphql({ OpenIssues: () => ({ repository: null }) }) });
  assert.deepEqual(await empty.openIssues('acme/shop'), { issues: [], truncated: false });
  const full = await clientWith({
    'POST /graphql': graphql({
      OpenIssues: () => ({
        repository: { issues: { nodes: [issueNode({ number: 1 }), issueNode({ number: 2 })] } },
      }),
    }),
  });
  const read = await full.openIssues('acme/shop', 2);
  assert.deepEqual(
    read.issues.map(issue => issue.ref),
    ['acme/shop#1', 'acme/shop#2'],
  );
  assert.equal(read.truncated, true, 'a truncated read is said, never silently short');
});

test('setLane moves the Status option, lands on the board first when it must, and says nothing twice', async () => {
  const onBoard: string[] = [];
  const client = await clientWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: 'Todo' }) } }),
      AddItem: () => {
        onBoard.push('add');
        return { addProjectV2ItemById: { item: { id: 'PVTI_new' } } };
      },
      SetSelect: (v: any) => {
        onBoard.push(`set:${v.optionId}`);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
  });
  await client.setLane('acme/shop#47', 1, 'In Progress');
  assert.deepEqual(onBoard, ['set:opt_prog'], 'on the board already: only the option moves');
  await client.setLane('acme/shop#47', 1, 'Todo');
  assert.deepEqual(onBoard, ['set:opt_prog'], 'already there: the re-drive lands as nothing');
  // Not on the board: the add is paid first, then the option.
  const offBoardMoves: string[] = [];
  const offBoard = await clientWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: null }) } }),
      AddItem: () => {
        offBoardMoves.push('add');
        return { addProjectV2ItemById: { item: { id: 'PVTI_new' } } };
      },
      SetSelect: (v: any) => {
        offBoardMoves.push(`set:${v.optionId}`);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new' } } };
      },
    }),
  });
  await offBoard.setLane('acme/shop#47', 1, 'Backlog');
  assert.deepEqual(offBoardMoves, ['add', 'set:opt_backlog']);
  // A lane the board does not carry is said, never created (D4).
  await assert.rejects(client.setLane('acme/shop#47', 1, 'Review'), /no Status option "Review"/);
});

test('setAgent speaks the delegate in board words and clears it honestly', async () => {
  const moves: string[] = [];
  const client = await clientWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode() } }),
      SetSelect: (v: any) => {
        moves.push(`set:${v.fieldId}`);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
      ClearSelect: () => {
        moves.push('clear');
        return { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
  });
  await client.setAgent('acme/shop#47', 1, 'aivi-agent');
  assert.deepEqual(moves, [`set:${BOARD.agentFieldId}`]);
  await client.setAgent('acme/shop#47', 1, null);
  assert.deepEqual(moves, [`set:${BOARD.agentFieldId}`], 'nothing standing to clear: the clear lands as nothing');
  // With a value standing, the clear is paid.
  const clears: string[] = [];
  const standing = await clientWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ agent: 'aivi-agent' }) } }),
      ClearSelect: () => {
        clears.push('clear');
        return { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
  });
  await standing.setAgent('acme/shop#47', 1, null);
  assert.deepEqual(clears, ['clear']);
  await assert.rejects(client.setAgent('acme/shop#47', 1, 'someone-else'), /no Agent option "someone-else"/);
});

test('setAgent says nothing when the delegate already speaks for the ticket', async () => {
  const moves: string[] = [];
  const client = await clientWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ agent: 'aivi-agent' }) } }),
      SetSelect: () => {
        moves.push('set');
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_47' } } };
      },
    }),
  });
  await client.setAgent('acme/shop#47', 1, 'aivi-agent');
  assert.deepEqual(moves, [], 'the re-drive lands as nothing');
});

test('a ticket that is not on the board has no Agent value to set or to clear', async () => {
  const client = await clientWith({
    'POST /graphql': graphql({
      BoardFields: v => boardFieldsAnswer('aivi-hq', v),
      IssueFacts: () => ({ repository: { issue: issueNode({ lane: null }) } }),
    }),
  });
  await assert.rejects(
    client.setAgent('acme/shop#47', 1, 'aivi-agent'),
    /not on board 1; it has no Agent value to set/,
  );
  await assert.rejects(client.setAgent('acme/shop#47', 1, null), /not on board 1; it has no Agent value to clear/);
});

test('the comment trail reads oldest first with authors in GitHub words', async () => {
  const { fetch } = scripted(
    connectRoutes({
      'GET /repos/acme/shop/issues/47/comments': () => ({
        status: 200,
        body: [commentJson(1, 'person', 'User', 'hello'), commentJson(2, 'aivi-agent[bot]', 'Bot', 'working')],
      }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  const comments = await client.comments('acme/shop#47');
  assert.deepEqual(comments, [
    { id: 1, author: 'person', authorIsBot: false, body: 'hello', at: '2026-10-07T00:00:00Z' },
    { id: 2, author: 'aivi-agent[bot]', authorIsBot: true, body: 'working', at: '2026-10-07T00:00:00Z' },
  ]);
});

test('a comment is created, read, edited and deleted by its GitHub id', async () => {
  const { fetch, calls, seen } = scripted(
    connectRoutes({
      'POST /repos/acme/shop/issues/47/comments': () => ({ status: 201, body: { id: 1234, html_url: 'u' } }),
      'GET /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: { body: '**Working** · x' } }),
      'PATCH /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: {} }),
      'DELETE /repos/acme/shop/issues/comments/1234': () => ({ status: 204, body: null }),
      'GET /repos/acme/shop/issues/comments/9999': () => ({ status: 404, body: { message: 'Not Found' } }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  assert.deepEqual(await client.createComment('acme/shop#47', 'word'), { id: 1234, url: 'u' });
  assert.equal(await client.getComment('acme/shop#47', 1234), '**Working** · x');
  await client.updateComment('acme/shop#47', 1234, 'edited');
  await client.deleteComment('acme/shop#47', 1234);
  assert.equal(await client.getComment('acme/shop#47', 9999), undefined, 'a gone comment reads as gone');
  assert.ok(calls().includes('PATCH /repos/acme/shop/issues/comments/1234'));
  assert.ok(calls().includes('DELETE /repos/acme/shop/issues/comments/1234'));
  const patch = seen.find(c => c.method === 'PATCH')!;
  assert.deepEqual(JSON.parse(patch.body!), { body: 'edited' });
});

test('a comment whose author is gone, or that lacks a body or a time, still reads', async () => {
  const { fetch } = scripted(
    connectRoutes({
      'GET /repos/acme/shop/issues/47/comments': () => ({
        status: 200,
        body: [
          { id: 1, user: null, body: null, created_at: null, updated_at: '2026-10-08T00:00:00Z' },
          { id: 2, user: { login: 'person', type: 'User' }, body: 'hi', created_at: null, updated_at: null },
        ],
      }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  assert.deepEqual(await client.comments('acme/shop#47'), [
    { id: 1, author: null, authorIsBot: false, body: '', at: '2026-10-08T00:00:00Z' },
    { id: 2, author: 'person', authorIsBot: false, body: 'hi', at: '' },
  ]);
});

test('a status comment with an empty body reads as empty, not as gone', async () => {
  const { fetch } = scripted(
    connectRoutes({
      'GET /repos/acme/shop/issues/comments/1234': () => ({ status: 200, body: { body: null } }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  assert.equal(await client.getComment('acme/shop#47', 1234), '');
});

test('a new issue carries the words and ensures every label before it adds one', async () => {
  const callsMade: string[] = [];
  const { fetch } = scripted(
    connectRoutes({
      'POST /repos/acme/shop/issues': call => {
        callsMade.push('create');
        const body = JSON.parse(call.body!);
        assert.deepEqual(body, { title: 'Do it', body: 'why' });
        return { status: 201, body: { number: 48 } };
      },
      'GET /repos/acme/shop/labels/needs-human': () => ({ status: 404, body: { message: 'Not Found' } }),
      'POST /repos/acme/shop/labels': call => {
        callsMade.push('label');
        assert.deepEqual(JSON.parse(call.body!), { name: 'needs-human', color: 'ededed' });
        return { status: 201, body: {} };
      },
      'POST /repos/acme/shop/issues/48/labels': () => {
        callsMade.push('add');
        return { status: 200, body: [] };
      },
      'POST /graphql': graphql({
        IssueFacts: v => {
          assert.equal(v.number, 48);
          return { repository: { issue: issueNode({ number: 48, lane: null }) } };
        },
      }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  const made = await client.createIssue('acme/shop', { title: 'Do it', body: 'why', labels: ['needs-human'] });
  assert.deepEqual(callsMade, ['create', 'label', 'add'], 'the label is created before it is added');
  assert.equal(made.ref, 'acme/shop#48');
});

test('removing a label that is not on the ticket says done, not broken', async () => {
  const { fetch, calls } = scripted(
    connectRoutes({
      'DELETE /repos/acme/shop/issues/47/labels/needs-human': () => ({ status: 404, body: { message: 'Not Found' } }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  await client.removeLabel('acme/shop#47', 'needs-human');
  assert.ok(calls().includes('DELETE /repos/acme/shop/issues/47/labels/needs-human'));
});

test('removing a label that GitHub refuses for another reason stands as the failure', async () => {
  const { fetch } = scripted(
    connectRoutes({
      'DELETE /repos/acme/shop/issues/47/labels/needs-human': () => ({ status: 403, body: { message: 'Forbidden' } }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  await assert.rejects(client.removeLabel('acme/shop#47', 'needs-human'), { status: 403 });
});

test('a label is created only where the repository lacks it, and a refusal other than not-found stands', async t => {
  const lookup = 'GET /repos/acme/shop/labels/needs-human';
  for (const [name, status, expected, refused] of [
    ['a label the repository carries is left alone', 200, [lookup], false],
    ['a missing label is created', 404, [lookup, 'POST /repos/acme/shop/labels'], false],
    ['a refusal other than not-found creates nothing', 403, [lookup], true],
  ] as const)
    await t.test(name, async () => {
      const { fetch, calls } = scripted(
        connectRoutes({
          [lookup]: () => ({ status, body: {} }),
          'POST /repos/acme/shop/labels': () => ({ status: 201, body: {} }),
        }),
      );
      const client = new GithubClient(await connectApp(fetch));
      const ensured = client.ensureLabel('acme/shop', 'needs-human');
      await (refused ? assert.rejects(ensured, { status }) : ensured);
      assert.deepEqual(
        calls().filter(call => call.includes('/repos/')),
        expected,
      );
    });
});

test('the label catalogue is read a page at a time until a short page ends it', async () => {
  const pages: (string | null)[] = [];
  const { fetch } = scripted(
    connectRoutes({
      'GET /repos/acme/shop/labels': call => {
        const page = new URLSearchParams(call.search).get('page');
        pages.push(page);
        const full = Array.from({ length: 100 }, (_, n) => ({ name: `label-${n}` }));
        return { status: 200, body: page === '1' ? full : [{ name: 'last' }] };
      },
    }),
  );
  const labels = await new GithubClient(await connectApp(fetch)).repoLabels('acme/shop');
  assert.equal(labels.length, 101);
  assert.equal(labels.at(-1), 'last');
  assert.deepEqual(pages, ['1', '2']);
});

test('updating an issue sends only the words named, then answers the issue as it now reads', async t => {
  for (const [changes, sent] of [
    [{ title: 'New title' }, { title: 'New title' }],
    [{ description: 'New why' }, { body: 'New why' }],
    [
      { title: 'New title', description: 'New why' },
      { title: 'New title', body: 'New why' },
    ],
  ] as const)
    await t.test(Object.keys(changes).join(' and '), async () => {
      const { fetch, bodies, calls } = scripted(
        connectRoutes({
          'PATCH /repos/acme/shop/issues/47': () => ({ status: 200, body: {} }),
          'POST /graphql': graphql({
            IssueFacts: () => ({ repository: { issue: issueNode({ title: 'New title' }) } }),
          }),
        }),
      );
      const updated = await new GithubClient(await connectApp(fetch)).updateIssue('acme/shop#47', changes);
      assert.deepEqual(bodies('/repos/acme/shop/issues/47'), [sent]);
      assert.deepEqual(
        calls().slice(-2),
        ['PATCH /repos/acme/shop/issues/47', 'POST /graphql'],
        'the write, then the read',
      );
      assert.equal(updated.title, 'New title');
    });
});

test('the assistant marks react to the issue, and only aivi own reactions are taken back', async () => {
  const deleted: number[] = [];
  const { fetch } = scripted(
    connectRoutes({
      'POST /repos/acme/shop/issues/47/reactions': call => {
        assert.equal(JSON.parse(call.body!).content, 'eyes');
        return { status: 201, body: { id: 1 } };
      },
      'GET /repos/acme/shop/issues/47/reactions': () => ({
        status: 200,
        body: [
          { id: 7, user: { login: 'person' } },
          { id: 8, user: { login: 'aivi-agent[bot]' } },
        ],
      }),
      'DELETE /repos/acme/shop/issues/47/reactions/8': () => {
        deleted.push(8);
        return { status: 204, body: null };
      },
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  await client.addReaction('acme/shop#47', 'eyes');
  await client.removeOwnReaction('acme/shop#47', 'eyes');
  assert.deepEqual(deleted, [8], 'a person reaction is nobody to touch');
});

test('a board node id resolves to the ticket it names, and non-issues say nothing', async () => {
  const { fetch } = scripted(
    connectRoutes({
      'POST /graphql': graphql({
        NodeRef: v =>
          v.id === 'PR_1'
            ? { node: null }
            : { node: { number: 47, repository: { owner: { login: 'acme' }, name: 'shop' } } },
      }),
    }),
  );
  const client = new GithubClient(await connectApp(fetch));
  assert.equal(await client.nodeRef('I_1'), 'acme/shop#47');
  assert.equal(await client.nodeRef('PR_1'), undefined);
});

test('gone is GitHub saying the thing does not exist, and nothing else', () => {
  assert.equal(isGoneError({ status: 404 }), true);
  assert.equal(isGoneError({ status: 410 }), true);
  assert.equal(isGoneError(new Error('Could not resolve to a Node with the id of PVTI_1')), true);
  assert.equal(isGoneError({ status: 502 }), false, 'a bad gateway is a retry, not a grave');
  assert.equal(isGoneError(new Error('rate limit exceeded')), false);
});
