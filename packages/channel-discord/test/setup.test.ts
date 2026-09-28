import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginSetupCancelled, type PluginSetupContext } from '@aivi/plugin';
import * as prompts from '@clack/prompts';
import setup from '../src/setup.ts';

/** A context that answers prompts from a script, records what is written, and
 *  fetches canned Discord responses. Nothing touches disk or the network.
 *  The flow draws with `ctx.prompts`, so the script replaces clack's drawing
 *  verbs — a real prompt asks again when `validate` refuses, and so does
 *  this: a bad shape is modelled by the next scripted answer. */
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
    config: { version: 1, modules: {} },
    print: () => {},
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
  return { ctx, secrets, blocks, notes, logs };
}

const BOT_OK = { match: /users\/@me/, status: 200, body: { id: '10000000000000001', username: 'clawd' } };

test('discord setup verifies the token, derives the application id and writes both files', async () => {
  const h = harness(['tok', 'yes', '30000000000000003', '', 'yes', 'yes', '40000000000000004', ''], [BOT_OK]);
  const result = await setup(h.ctx);
  assert.equal(result.module, 'discord');
  assert.match(result.summary, /@clawd/);
  assert.match(result.summary, /aivi link discord/, 'the summary says how to talk to the bot');
  assert.equal(h.secrets.get('DISCORD_BOT_TOKEN'), 'tok');
  const block = h.blocks[0]!.value as {
    applicationId: string;
    access: { dm?: unknown; channels: { id: string; trigger?: string }[] };
    reportChannels: string[];
    messageContent: boolean;
  };
  assert.equal(block.applicationId, '10000000000000001', 'derived from the bot, never asked');
  assert.equal(block.access.dm, undefined, 'people link; the config lists places, not identities');
  assert.deepEqual(
    block.access.channels.map(c => c.id),
    ['30000000000000003'],
  );
  assert.equal(block.access.channels[0]!.trigger, undefined, 'with the intent, the default trigger stands');
  assert.deepEqual(block.reportChannels, ['40000000000000004']);
  assert.equal(block.messageContent, true);
  assert.deepEqual(h.blocks[0]!.path, ['modules', 'discord']);
  assert.ok(h.notes.join('\n').includes('discord.com/developers'), 'the app-creation instructions print');
});

test('discord setup without the intent marks channels mention-only', async () => {
  const h = harness(['tok', 'yes', '30000000000000003', '', 'no', 'no'], [BOT_OK]);
  await setup(h.ctx);
  const block = h.blocks[0]!.value as { access: { channels: { trigger: string }[] }; messageContent?: boolean };
  assert.equal(block.access.channels[0]!.trigger, 'mention');
  assert.equal(block.messageContent, undefined);
  assert.equal(h.secrets.has('DISCORD_BOT_TOKEN'), true);
});

test('discord setup with no channels configures a DM-only bot', async () => {
  const h = harness(['tok', 'no', 'no', 'no'], [BOT_OK]);
  const result = await setup(h.ctx);
  const block = h.blocks[0]!.value as { access: { channels: unknown[] } };
  assert.deepEqual(block.access.channels, []);
  assert.match(result.summary, /DMs only/, 'the summary says what it decided');
});

test('discord setup refuses an already configured module', async () => {
  const h = harness([], [BOT_OK]);
  h.ctx.config = { version: 1, modules: { discord: { applicationId: '10000000000000001', access: { channels: [] } } } };
  await assert.rejects(setup(h.ctx), /already configured/);
  assert.equal(h.blocks.length, 0);
});

test('discord setup never writes on a refused token', async () => {
  const h = harness(['bad'], [{ match: /users\/@me/, status: 401, body: { message: 'Unauthorized' } }]);
  await assert.rejects(setup(h.ctx), /refused that token/);
  assert.equal(h.blocks.length, 0);
  assert.equal(h.secrets.size, 0);
});

test('discord setup stops on a cancelled prompt with nothing written', async () => {
  const h = harness(['tok'], [BOT_OK]);
  h.ctx.prompts = { ...h.ctx.prompts, password: async () => prompts.CANCEL_SYMBOL } as typeof prompts;
  await assert.rejects(setup(h.ctx), PluginSetupCancelled);
  assert.equal(h.blocks.length, 0);
  assert.equal(h.secrets.size, 0);
});

test('discord setup asks channel ids until they match the snowflake shape', async () => {
  const h = harness(['tok', 'yes', 'short', '30000000000000003', '', 'no', 'no'], [BOT_OK]);
  await setup(h.ctx);
  const block = h.blocks[0]!.value as { access: { channels: { id: string }[] } };
  assert.deepEqual(
    block.access.channels.map(c => c.id),
    ['30000000000000003'],
    'the bad shape never lands',
  );
});
