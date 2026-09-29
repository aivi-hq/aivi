import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginSetupCancelled, type PluginSetupContext } from '@aivi/plugin';
import * as prompts from '@clack/prompts';
import setup from '../src/setup.ts';

/** A context that answers prompts from a script, records what is written, and
 *  fetches canned Slack responses. Nothing touches disk or the network.
 *  The flow draws with `ctx.prompts`, so the script replaces clack's drawing
 *  verbs — a real prompt asks again when `validate` refuses, and so does
 *  this: a bad shape is modelled by the next scripted answer. */
interface Harness {
  ctx: PluginSetupContext;
  secrets: Map<string, string>;
  blocks: { path: string[]; value: unknown }[];
  notes: string[];
  logs: string[];
  printed: unknown[];
}

function harness(answers: string[], responses: { match: RegExp; status: number; body: unknown }[]): Harness {
  const queue = [...answers];
  const secrets = new Map<string, string>();
  const blocks: { path: string[]; value: unknown }[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  const printed: unknown[] = [];
  const answered = async (
    validate?: ((value: string | undefined) => string | undefined) | undefined,
  ): Promise<string> => {
    for (;;) {
      const answer = queue.shift();
      if (answer === undefined) throw new Error('the answer script ran dry');
      const problem = validate?.(answer);
      if (!problem) return answer;
      if (queue.length === 0) throw new Error(`validate refused "${answer}" and nothing follows: ${problem}`);
    }
  };
  const ctx: PluginSetupContext = {
    home: '/home',
    configPath: '/home/config.json',
    identityName: 'Clawd',
    config: { version: 1, plugins: {} },
    print: value => printed.push(value),
    withStore: async () => {
      throw new Error('the setup flow reads no store');
    },
    prompts: {
      ...prompts,
      note: (lines = '', title = '') => {
        notes.push(`${title}: ${lines}`);
      },
      text: async (options?: { validate?: (value: string | undefined) => string | undefined }) =>
        answered(options?.validate),
      password: async (options?: { validate?: (value: string | undefined) => string | undefined }) =>
        answered(options?.validate),
      confirm: async () => (await answered()) === 'yes',
      select: async () => answered(),
      log: {
        message: async (message?: string) => {
          logs.push(String(message));
        },
      },
    } as unknown as typeof prompts,
    async fetch(url) {
      const hit = responses.find(r => r.match.test(url));
      if (!hit) throw new Error(`no canned response for ${url}`);
      return { ok: hit.status < 400, status: hit.status, json: async () => hit.body } as Response;
    },
    async writeConfigBlock(path, value) {
      blocks.push({ path, value });
    },
    async writeSecret(key, value) {
      secrets.set(key, value);
    },
  };
  return { ctx, secrets, blocks, notes, logs, printed };
}

const AUTH_OK = {
  match: /auth\.test/,
  status: 200,
  body: { ok: true, team: 'Acme', team_id: 'T1', user: 'clawd', user_id: 'U1' },
};
const SOCKETS_OK = { match: /apps\.connections\.open/, status: 200, body: { ok: true, url: 'wss://socket' } };

test('slack setup prints the manifest, verifies both tokens and writes both files', async () => {
  const h = harness(
    ['aivi', 'xoxb-1', 'xapp-1', 'yes', 'C0000000001', '', 'yes', 'C0000000002', ''],
    [AUTH_OK, SOCKETS_OK],
  );
  const result = await setup(h.ctx);
  assert.equal(result.module, 'channel-slack');
  assert.match(result.summary, /Acme/);
  assert.match(result.summary, /\/aivi-/);
  assert.match(result.summary, /aivi link slack/, 'the summary says how to talk to the bot');
  assert.equal(h.secrets.get('SLACK_BOT_TOKEN'), 'xoxb-1');
  assert.equal(h.secrets.get('SLACK_APP_TOKEN'), 'xapp-1');
  const block = h.blocks[0]!.value as {
    commandPrefix: string;
    access: { dm?: unknown; channels: { id: string }[] };
    reportChannels: string[];
  };
  assert.equal(block.commandPrefix, 'aivi');
  assert.equal(block.access.dm, undefined, 'people link; the config lists places, not identities');
  assert.deepEqual(
    block.access.channels.map(c => c.id),
    ['C0000000001'],
  );
  assert.deepEqual(block.reportChannels, ['C0000000002']);
  assert.deepEqual(h.blocks[0]!.path, ['plugins', 'channel-slack']);
  const note = h.notes.join('\n');
  assert.match(note, /manifest printed above/, 'the note points at the stdout manifest');
  const printed = h.printed as { features: { slash_commands: { command: string }[] } }[];
  assert.match(
    printed[0]!.features.slash_commands[0]!.command,
    /^\/aivi-/,
    'the manifest went to stdout as raw, paste-ready JSON',
  );
});

test('slack setup with no channels configures a DM-only bot', async () => {
  const h = harness(['aivi', 'xoxb-1', 'xapp-1', 'no', 'no'], [AUTH_OK, SOCKETS_OK]);
  const result = await setup(h.ctx);
  const block = h.blocks[0]!.value as { access: { channels: unknown[] } };
  assert.deepEqual(block.access.channels, []);
  assert.match(result.summary, /DMs only/, 'the summary says what it decided');
});

test('slack setup never writes on a refused bot token', async () => {
  const h = harness(
    ['aivi', 'xoxb-1'],
    [{ match: /auth\.test/, status: 200, body: { ok: false, error: 'invalid_auth' } }],
  );
  await assert.rejects(setup(h.ctx), /refused that token/);
  assert.equal(h.blocks.length, 0);
  assert.equal(h.secrets.size, 0);
});

test('slack setup never writes when the app token cannot open Socket Mode', async () => {
  const h = harness(
    ['aivi', 'xoxb-1', 'xapp-1'],
    [AUTH_OK, { match: /apps\.connections\.open/, status: 200, body: { ok: false, error: 'not_allowed_token_type' } }],
  );
  await assert.rejects(setup(h.ctx), /Socket Mode/);
  assert.equal(h.secrets.size, 0, 'the verified bot token is not saved either: both go in together');
});

test('slack setup refuses an already configured module', async () => {
  const h = harness([], [AUTH_OK]);
  h.ctx.config = { version: 1, plugins: { 'channel-slack': { commandPrefix: 'aivi', access: { channels: [] } } } };
  await assert.rejects(setup(h.ctx), /already configured/);
  assert.equal(h.blocks.length, 0);
});

test('slack setup stops on a cancelled prompt with nothing written', async () => {
  const h = harness(['aivi'], [AUTH_OK, SOCKETS_OK]);
  h.ctx.prompts = { ...h.ctx.prompts, text: async () => prompts.CANCEL_SYMBOL } as typeof prompts;
  await assert.rejects(setup(h.ctx), PluginSetupCancelled);
  assert.equal(h.blocks.length, 0);
});

test('slack setup asks channel ids until they match the platform shape', async () => {
  const h = harness(['aivi', 'xoxb-1', 'xapp-1', 'yes', 'nope', 'C0000000001', '', 'no'], [AUTH_OK, SOCKETS_OK]);
  await setup(h.ctx);
  const block = h.blocks[0]!.value as { access: { channels: { id: string }[] } };
  assert.deepEqual(
    block.access.channels.map(c => c.id),
    ['C0000000001'],
    'the bad shape never lands',
  );
});
