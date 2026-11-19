/** The plugin setup plumbing as a unit: which packages have a setup to run,
 *  what the setup is handed, and how its outcome is said and returned. The
 *  prompts, the home's context, core's writers and one package's `./setup`
 *  are module mocks; a package whose `./setup` fails to load or exports no
 *  function is a `data:` module standing in for it. Nothing here draws a
 *  prompt, writes a real config or reaches the network. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, mock, type TestContext, test } from 'node:test';
import { PluginSetupCancelled, type PluginSetupContext } from '@aivi/plugin';
import { keepExitCode, loadedWith, scratchDir, terminal } from './apicli-fixture.ts';

const world = { loaded: loadedWith() };
const intro = mock.fn();
const outro = mock.fn();
const cancel = mock.fn();
const print = mock.fn();
const upsertEnvFile = mock.fn();
const writeConfigBlock = mock.fn(async (..._args: unknown[]) => {});
const withStore = mock.fn(async (_loaded: unknown, fn: (store: string) => unknown) => fn('the store'));
const setup = mock.fn(async (_ctx: PluginSetupContext): Promise<{ summary: string; module: string }> => {
  throw new Error('the test names what the setup does');
});

mock.module('@clack/prompts', { exports: { intro, outro, cancel } });
mock.module('../src/cli/context.ts', { exports: { context: async () => ({ loaded: world.loaded }), withStore } });
mock.module('@aivi/channel-discord/setup', { exports: { default: (ctx: PluginSetupContext) => setup(ctx) } });
const core = await import('@aivi/core');
mock.module('@aivi/core', { exports: { ...core, print, upsertEnvFile, writeConfigBlock } });

const { pluginSetup } = await import('../src/cli/plugin-setup.ts');

beforeEach(() => {
  for (const spy of [intro, outro, cancel, print, upsertEnvFile, writeConfigBlock, withStore, setup])
    spy.mock.resetCalls();
  world.loaded = loadedWith();
});

const spec = '@aivi/channel-discord';

/** A home whose config.json holds a plugin block, a terminal attached or not, and the exit code kept for the end. */
async function setupHome(t: TestContext, attached: boolean) {
  const home = await scratchDir(t, 'aivi-plugin-setup-');
  const configPath = join(home, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, plugins: { browser: {} } }));
  terminal(t, attached);
  keepExitCode(t);
  return { home, configPath, options: { home, configPath, identityName: 'Clawd' } };
}

test('a package with no ./setup has nothing to say, and one that is not installed says how to install it', async t => {
  const { options } = await setupHome(t, true);
  assert.equal(await pluginSetup('@aivi/core', options), null);
  await assert.rejects(
    pluginSetup('@acme/nowhere', options),
    new Error('@acme/nowhere is not installed in this installation. `aivi add @acme/nowhere` adds it first.'),
  );
});

test('a ./setup that fails to load, or exports no function, stops before any prompt is drawn', async t => {
  const { options } = await setupHome(t, true);
  await assert.rejects(
    pluginSetup("data:text/javascript,throw new TypeError('the setup blew up');//", options),
    new TypeError('the setup blew up'),
  );
  const empty = "data:text/javascript,export default 'not a function';//";
  await assert.rejects(pluginSetup(empty, options), new Error(`${empty}/setup exports no function.`));
  assert.equal(intro.mock.callCount(), 0);
});

test('without a terminal the setup is not run, and the person is told to edit the files instead', async t => {
  const { options } = await setupHome(t, false);
  await assert.rejects(
    pluginSetup(spec, options),
    new Error(
      `plugin setup needs an interactive terminal; to configure ${spec} without one, edit config.json and .env by hand (docs/getting-started.md).`,
    ),
  );
  assert.equal(setup.mock.callCount() + intro.mock.callCount(), 0);
});

test('the setup is handed the home and the tools to configure it, and its last line closes the flow', async t => {
  const { home, configPath, options } = await setupHome(t, true);
  const fetched = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  const seen: { ctx?: PluginSetupContext; reply?: unknown; stored?: unknown } = {};
  setup.mock.mockImplementationOnce(async ctx => {
    seen.ctx = ctx;
    ctx.print({ answer: 42 }, 'forty-two');
    seen.reply = await (await ctx.fetch('https://platform.test/me', { method: 'POST' })).json();
    seen.stored = await ctx.withStore(store => `${store} used`);
    await ctx.writeConfigBlock(['plugins', 'channel-discord'], { token: 'abc' });
    await ctx.writeSecret('DISCORD_BOT_TOKEN', 's3cret');
    return { summary: 'Discord is set up.', module: 'channel-discord' };
  });

  assert.equal(await pluginSetup(spec, options), 'channel-discord', 'the module id the setup enabled');

  const { ctx } = seen;
  assert.deepEqual([ctx?.home, ctx?.configPath, ctx?.identityName], [home, configPath, 'Clawd']);
  assert.deepEqual(ctx?.config, { version: 1, plugins: { browser: {} } }, 'the config as it is on disk now');
  assert.equal(ctx?.prompts.outro, outro, 'the very prompts the flow itself draws with');
  assert.deepEqual([seen.reply, seen.stored], [{ ok: true }, 'the store used']);
  assert.deepEqual(intro.mock.calls[0]!.arguments, [`aivi add — ${spec}`]);
  assert.deepEqual(outro.mock.calls[0]!.arguments, ['Discord is set up.']);
  assert.deepEqual(print.mock.calls[0]!.arguments, [{ answer: 42 }, 'forty-two']);
  assert.deepEqual(fetched.mock.calls[0]!.arguments, ['https://platform.test/me', { method: 'POST' }]);
  assert.equal(withStore.mock.calls[0]!.arguments[0], world.loaded);
  assert.deepEqual(writeConfigBlock.mock.calls[0]!.arguments, [
    configPath,
    ['plugins', 'channel-discord'],
    { token: 'abc' },
  ]);
  assert.deepEqual(upsertEnvFile.mock.calls[0]!.arguments, [join(home, '.env'), 'DISCORD_BOT_TOKEN', 's3cret']);
  assert.equal(cancel.mock.callCount(), 0);
});

test('a setup the person cancels or that fails stops the flow with nothing more written and a failed exit', async t => {
  const { options } = await setupHome(t, true);
  setup.mock.mockImplementationOnce(async () => {
    throw new PluginSetupCancelled('no answer');
  });
  assert.equal(await pluginSetup(spec, options), undefined);
  assert.deepEqual(cancel.mock.calls[0]!.arguments, ['Setup stopped. Nothing further was written.']);

  process.exitCode = undefined;
  setup.mock.mockImplementationOnce(async () => {
    throw new Error('the token was refused');
  });
  assert.equal(await pluginSetup(spec, options), undefined);
  assert.deepEqual(cancel.mock.calls[1]!.arguments, [
    'Setup stopped: the token was refused. Nothing further was written.',
  ]);
  assert.equal(process.exitCode, 1);
  assert.equal(outro.mock.callCount(), 0);
});
