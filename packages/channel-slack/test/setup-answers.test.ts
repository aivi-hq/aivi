/** What the Slack setup does with each answer and each reply from Slack, over the kit's
 *  scripted prompts: which answers its prompts accept, what a half-empty `auth.test`
 *  reply still says, and how a refused or failed call ends the flow with nothing written.
 *  The whole-flow cases that read like a person's run are in `setup.test.ts`. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { PluginSetupCancelled } from '@aivi/plugin';
import { setupFixture } from '../../plugin/test/setup-fixture.ts';
import setup from '../src/setup.ts';

interface Reply {
  status?: number;
  body: unknown;
}

/** The flow's questions, in the order a person with one channel of each kind answers them. */
const FULL_RUN = ['aivi', 'xoxb-1', 'xapp-1', true, 'C0000000001', '', true, 'C0000000002', ''];
/** Both tokens, then no shared channels and no report channels. */
const TOKENS_ONLY = ['aivi', 'xoxb-1', 'xapp-1', false, false];

/** The flow over scripted answers; Slack answers each method from `replies`, well by default. */
function slack(t: TestContext, answers: unknown[], replies: Record<string, Reply> = {}) {
  const h = setupFixture(t, answers);
  const answering: Record<string, Reply> = {
    'auth.test': { body: { ok: true, team: 'Acme', user: 'clawd' } },
    'apps.connections.open': { body: { ok: true } },
    ...replies,
  };
  h.fetch.mock.mockImplementation(async url => {
    const reply = answering[String(url).split('/').at(-1)!]!;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as Response;
  });
  return h;
}

test('each prompt accepts the shape Slack uses, and says what to fix for any other', async t => {
  const h = slack(t, FULL_RUN);
  await setup(h.ctx);

  const [prefix, bot, app, , channel, , , report] = h.questions;
  const prefixRule = 'Lowercase letters, digits, _ or -';
  const idRule = 'A Slack channel id starts with C or G — or an empty line to stop';
  const checks: [typeof prefix, (string | undefined)[], [string | undefined, string][]][] = [
    [
      prefix,
      [undefined, '', '  ', 'aivi', 'my-bot_2'],
      [
        ['Bot', prefixRule],
        ['2bot', prefixRule],
        ['my bot', prefixRule],
      ],
    ],
    [
      bot,
      ['xoxb-1', ' xoxb-1 '],
      [
        [undefined, 'A bot token starts with xoxb-'],
        ['xapp-1', 'A bot token starts with xoxb-'],
      ],
    ],
    [
      app,
      ['xapp-1'],
      [
        [undefined, 'An app-level token starts with xapp-'],
        ['xoxb-1', 'An app-level token starts with xapp-'],
      ],
    ],
    [
      channel,
      [undefined, '', 'C0000000001', 'G0000000001'],
      [
        ['general', idRule],
        ['D0000000001', idRule],
      ],
    ],
    [report, [undefined, '', 'C0000000002'], [['nope', idRule]]],
  ];
  for (const [question, accepted, refused] of checks) {
    for (const value of accepted) assert.equal(question!.validate!(value), undefined, `${question!.message}: ${value}`);
    for (const [value, reason] of refused)
      assert.equal(question!.validate!(value), reason, `${question!.message}: ${value}`);
  }
});

test('a prompt submitted empty stops the flow with nothing written', async t => {
  const h = slack(t, [undefined]);

  await assert.rejects(setup(h.ctx), (error: unknown) => {
    assert.ok(error instanceof PluginSetupCancelled);
    assert.match(error.message, /submitted empty/);
    return true;
  });

  assert.equal(h.configWrites.mock.callCount(), 0);
  assert.equal(h.secretWrites.mock.callCount(), 0);
});

test('a blank prefix means the default one', async t => {
  const h = slack(t, ['  ', ...TOKENS_ONLY.slice(1)]);

  await setup(h.ctx);

  assert.deepEqual(h.configWrites.mock.calls[0]!.arguments, [
    ['plugins', 'channel-slack'],
    { commandPrefix: 'aivi', access: { channels: [] } },
  ]);
});

test('the workspace is named from whatever auth.test knows, and never left out', async t => {
  for (const [body, workspace, bot] of [
    [{ ok: true, team: 'Acme', team_id: 'T1', user: 'clawd', user_id: 'U1' }, 'Acme', 'clawd'],
    [{ ok: true, team_id: 'T1', user_id: 'U1' }, 'T1', 'U1'],
    [{ ok: true, user_id: 'U1' }, 'your workspace', 'U1'],
  ] as const) {
    const h = slack(t, TOKENS_ONLY, { 'auth.test': { body } });

    const result = await setup(h.ctx);

    assert.match(result.summary, new RegExp(`Slack is configured for workspace ${workspace}:`));
    assert.ok(
      h.log.mock.calls.some(call => call.arguments[0] === `Verified: bot @${bot} in ${workspace}.`),
      `the bot is named as ${bot}`,
    );
  }
});

test('a call Slack refuses or fails ends the flow in words, and the verified tokens are not kept', async t => {
  for (const [method, reply, said] of [
    ['auth.test', { status: 500, body: {} }, /auth\.test answered HTTP 500\./],
    ['auth.test', { body: { ok: false } }, /Slack refused that token \(auth\.test: not ok\)\./],
    ['apps.connections.open', { status: 502, body: {} }, /apps\.connections\.open answered HTTP 502\./],
  ] as const) {
    const h = slack(t, TOKENS_ONLY, { [method]: reply });

    await assert.rejects(setup(h.ctx), said);

    assert.equal(h.configWrites.mock.callCount(), 0, `${method}: no config block`);
    assert.equal(h.secretWrites.mock.callCount(), 0, `${method}: no secret`);
  }
});
