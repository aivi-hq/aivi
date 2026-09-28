import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConfigSchema } from '@aivi/core';
import type { PluginSetupContext } from '@aivi/plugin';
import * as prompts from '@clack/prompts';
import setup from '../src/setup.ts';

/** A context that answers confirms from a script and records writes. Nothing touches disk.
 *  The flow draws with `ctx.prompts`, so the script replaces clack's drawing
 *  verbs; the ones the browser flow has no business calling still say so. */
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
      text: async () => {
        throw new Error('the browser has no secrets to ask for');
      },
      password: async () => {
        throw new Error('the browser has no secrets to ask for');
      },
      confirm: async () => {
        const answer = queue.shift();
        if (answer === undefined) throw new Error('the answer script ran dry');
        return answer === 'yes';
      },
      select: async () => {
        throw new Error('the browser has no choices to ask for');
      },
      log: { message: async () => {} },
    } as unknown as typeof prompts,
    async fetch() {
      throw new Error('no platform to fetch');
    },
    async writeConfigBlock(path, value) {
      blocks.push({ path, value });
    },
    async writeSecret() {
      throw new Error('the browser writes no secret');
    },
  };
  return { ctx, blocks, notes };
}

test('browser setup writes the launch block and says what happens on the first call', async () => {
  const h = harness(['yes'], { version: 1 });
  const result = await setup(h.ctx);
  assert.equal(result.module, 'browser');
  assert.match(result.summary, /launches its own Chrome/);
  assert.deepEqual(h.blocks[0]!.path, ['browser']);
  assert.deepEqual(browserConfigSchema.parse(h.blocks[0]!.value).connection, {
    mode: 'launch',
    userDataDir: 'state/chrome',
    headless: false,
  });
  assert.ok(h.notes.join('\n').includes('attach'), 'the three modes are explained before asking');
});

test('a configured browser is never clobbered, and declining writes nothing', async () => {
  const configured = harness([], {
    version: 1,
    browser: { connection: { mode: 'existing', userDataDir: 'my-chrome' } },
  });
  await assert.rejects(setup(configured.ctx), /already configured/);
  assert.deepEqual(configured.blocks, []);

  const declined = harness(['no'], { version: 1 });
  await assert.rejects(setup(declined.ctx), /Nothing was written/);
  assert.deepEqual(declined.blocks, []);
});

test('an explicit false is not a block: installing re-enables by writing the launch block', async () => {
  const h = harness(['yes'], { version: 1, browser: false });
  await setup(h.ctx);
  assert.equal(h.blocks.length, 1, 'the explicit off is what install turns on');
});
