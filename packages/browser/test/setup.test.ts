import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConfigSchema, type PluginSetupContext } from '@aivi/core';
import setup from '../src/setup.ts';

/** A context that answers confirms from a script and records writes. Nothing touches disk. */
function harness(answers: string[], config: Record<string, unknown>) {
  const queue = [...answers];
  const blocks: { path: string[]; value: unknown }[] = [];
  const notes: string[] = [];
  const ctx: PluginSetupContext = {
    home: '/home',
    configPath: '/home/config.json',
    identityName: 'Clawd',
    config,
    note: (title, lines) => notes.push(`${title}: ${lines}`),
    print: () => {},
    log: () => {},
    ask: {
      async text() {
        throw new Error('the browser has no secrets to ask for');
      },
      async confirm() {
        const answer = queue.shift();
        if (answer === undefined) throw new Error('the answer script ran dry');
        return answer === 'yes';
      },
    },
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
