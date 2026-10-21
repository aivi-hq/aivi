import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginSetupContext } from '@aivi/plugin';
import * as prompts from '@clack/prompts';
import { meetConfigSchema } from '../src/config.ts';
import setup from '../src/setup.ts';

/** A context answering confirms from a script and recording writes; the
 *  Meet flow touches no disk, no network, and no store. */
function harness(answers: string[], config: Record<string, unknown>) {
  const queue = [...answers];
  const blocks: { path: string[]; value: unknown }[] = [];
  const notes: string[] = [];
  const ctx: PluginSetupContext = {
    home: '/home',
    configPath: '/home/config.json',
    identityName: 'Clawd',
    config,
    print: () => {},
    withStore: async () => {
      throw new Error('the setup flow reads no store');
    },
    prompts: {
      ...prompts,
      note: (lines = '', title = '') => {
        notes.push(`${title}: ${lines}`);
      },
      confirm: async () => {
        const answer = queue.shift();
        if (answer === undefined) throw new Error('the answer script ran dry');
        return answer === 'yes';
      },
      spinner: () => ({ start: () => {}, message: () => {}, stop: () => {} }),
      log: { message: async () => {} },
    } as unknown as typeof prompts,
    async fetch() {
      throw new Error('no platform to fetch');
    },
    async writeConfigBlock(path, value) {
      blocks.push({ path, value });
    },
    async writeSecret() {
      throw new Error('Meet writes no secret');
    },
  };
  return { ctx, blocks, notes };
}

test('Meet setup writes a block that loads, and names the two things the meeting stands on', async () => {
  const h = harness(['no'], { version: 1 });
  const result = await setup(h.ctx);
  assert.equal(result.module, 'google-meet');
  assert.deepEqual(h.blocks[0]!.path, ['plugins', 'google-meet']);
  assert.deepEqual(meetConfigSchema.parse(h.blocks[0]!.value), meetConfigSchema.parse({}), 'headless defaults');
  const said = h.notes.join('\n');
  assert.match(said, /@aivi\/voice/, 'the voice dependency is named before asking anything');
  assert.match(said, /serve/, 'the meeting lives in serve, said plainly');
  assert.match(result.summary, /aivi meet join/, 'the summary ends in the command to actually use');
  assert.match(result.summary, /voice is NOT configured yet/, 'with no voice block the summary says what is missing');
});

test('the window question lands in the block, and a configured voice is acknowledged', async () => {
  const h = harness(['yes'], {
    version: 1,
    plugins: { voice: { asr: { command: 'p', args: [] } } },
  });
  const result = await setup(h.ctx);
  const block = meetConfigSchema.parse(h.blocks[0]!.value);
  assert.equal(block.headless, false, 'a visible window is a written choice');
  assert.match(result.summary, /visible window/);
  assert.ok(!/NOT configured/.test(result.summary), 'voice is there, the summary does not cry wolf');
});

test('an existing block is never overwritten', async () => {
  const h = harness([], {
    version: 1,
    plugins: { 'google-meet': { mode: 'meeting' } },
  });
  await assert.rejects(() => setup(h.ctx), /already configured/);
  assert.equal(h.blocks.length, 0);
});
