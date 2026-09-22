import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginSetupContext } from '@aivi/core';
import { PluginSetupCancelled } from '@aivi/core';
import setup from '../src/setup.ts';

/** A context that answers prompts from a script, records what is written, and
 *  fetches canned Slack responses. Nothing touches disk or the network. */
interface Harness {
  ctx: PluginSetupContext;
  secrets: Map<string, string>;
  blocks: { path: string[]; value: unknown }[];
  notes: string[];
  logs: string[];
}

function harness(answers: string[], responses: { match: RegExp; status: number; body: unknown }[]): Harness {
  const queue = [...answers];
  const secrets = new Map<string, string>();
  const blocks: { path: string[]; value: unknown }[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  const ctx: PluginSetupContext = {
    home: '/home',
    configPath: '/home/config.json',
    identityName: 'Clawd',
    config: { version: 1, modules: {} },
    note: (title, lines) => notes.push(`${title}: ${lines}`),
    log: message => logs.push(message),
    ask: {
      async text({ validate }) {
        // A real prompt asks again when validate refuses; the script answers
        // until one passes, so a bad shape is modelled by the next answer.
        for (;;) {
          const answer = queue.shift();
          if (answer === undefined) throw new Error('the answer script ran dry');
          const problem = validate?.(answer);
          if (!problem) return answer;
          if (queue.length === 0) throw new Error(`validate refused "${answer}" and nothing follows: ${problem}`);
        }
      },
      async confirm() {
        const answer = queue.shift();
        if (answer === undefined) throw new Error('the answer script ran dry');
        return answer === 'yes';
      },
    },
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
  return { ctx, secrets, blocks, notes, logs };
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
  assert.equal(result.module, 'slack');
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
  assert.deepEqual(h.blocks[0]!.path, ['modules', 'slack']);
  const note = h.notes.join('\n');
  assert.match(note, /app manifest/);
  assert.match(note, /"\/aivi-new"/, 'the manifest in the note is the paste-ready JSON');
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
  h.ctx.config = { version: 1, modules: { slack: { commandPrefix: 'aivi', access: { channels: [] } } } };
  await assert.rejects(setup(h.ctx), /already configured/);
  assert.equal(h.blocks.length, 0);
});

test('slack setup stops on a cancelled prompt with nothing written', async () => {
  const h = harness(['aivi'], [AUTH_OK, SOCKETS_OK]);
  h.ctx.ask.text = async () => {
    throw new PluginSetupCancelled('a prompt was cancelled');
  };
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
