/** The plugin command mount as a unit: which listed packages put commands on
 *  the tree, what they are handed to work with, and what is said when one
 *  cannot be mounted. The home's context and the plugin registry are module
 *  mocks, and so is one package's `./cli`; a package whose `./cli` does not
 *  load or exports no command is a `data:` module standing in for it. */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { MachineStatus, PluginCliContext } from '@aivi/plugin';
import * as clack from '@clack/prompts';
import { Command } from 'commander';
import type { PluginEntry } from '../src/cli/registry.ts';
import { loadedWith } from './apicli-fixture.ts';

const world = { loaded: loadedWith(), entries: [] as PluginEntry[] };
const print = mock.fn();
const poke = mock.fn(async () => {});
const withStore = mock.fn(async (_loaded: unknown, fn: (store: string) => unknown) => fn('the store'));
const pluginRegistry = mock.fn(async (_home: string) => ({ entries: world.entries }));
const handed: PluginCliContext[] = [];
const slackCommands = mock.fn((ctx: PluginCliContext) => {
  handed.push(ctx);
  return new Command('slack');
});

mock.module('../src/cli/context.ts', {
  exports: {
    configPath: () => '/aivi-home/config.json',
    context: async () => ({ loaded: world.loaded, poke }),
    home: () => '/aivi-home',
    print,
    withStore,
  },
});
mock.module('../src/cli/registry.ts', { exports: { pluginRegistry } });
mock.module('@aivi/channel-slack/cli', { exports: { default: slackCommands } });

const { registerChannels } = await import('../src/cli/commands/channels.ts');

beforeEach(() => {
  for (const spy of [print, poke, withStore, pluginRegistry, slackCommands]) spy.mock.resetCalls();
  handed.length = 0;
  world.loaded = loadedWith();
  world.entries = [];
});

const listed = (...names: string[]): PluginEntry[] =>
  names.map(name => ({ name, enabled: true, plugin: {} as PluginEntry['plugin'] }));

/** The tree after the packages of the list have been asked for their commands. */
async function mounted(machine: MachineStatus = {}): Promise<Command> {
  const program = new Command('aivi');
  await registerChannels(program, machine);
  return program;
}

test('a listed package that answers with commands is mounted under Plugins, and handed what it needs to work', async t => {
  const stderr = t.mock.method(console, 'error', () => {});
  world.entries = listed('@aivi/channel-slack');
  const machine: MachineStatus = { home: '/aivi-home', remote: false };
  const program = await mounted(machine);
  assert.deepEqual(
    program.commands.map(command => [command.name(), command.helpGroup()]),
    [['slack', 'Plugins']],
  );
  assert.deepEqual(pluginRegistry.mock.calls[0]!.arguments, ['/aivi-home']);

  const ctx = handed[0]!;
  assert.deepEqual([ctx.machine, ctx.home, ctx.configPath], [machine, '/aivi-home', '/aivi-home/config.json']);
  assert.equal(await ctx.loaded(), world.loaded);
  assert.equal(await ctx.withStore(store => `${store} used`), 'the store used');
  assert.equal(withStore.mock.calls[0]!.arguments[0], world.loaded);
  assert.equal(ctx.print, print);
  assert.equal(ctx.prompts, clack, 'the very clack the built-in commands render with');
  ctx.log('a plugin note');
  assert.deepEqual(stderr.mock.calls[0]!.arguments, ['a plugin note']);
  await ctx.poke();
  assert.equal(poke.mock.callCount(), 1);
});

test('a package with no operator commands is simply absent, and says nothing about it', async t => {
  const stderr = t.mock.method(console, 'error', () => {});
  // `@aivi/browser` is installed and exports no ./cli; `@acme/nowhere` is not installed at all.
  world.entries = listed('@aivi/browser', '@acme/nowhere', '@aivi/channel-slack');
  const program = await mounted();
  assert.deepEqual(
    program.commands.map(command => command.name()),
    ['slack'],
  );
  assert.equal(stderr.mock.callCount(), 0);
});

test('a ./cli that fails to load or exports no command is named and skipped; the other packages still mount', async t => {
  const stderr = t.mock.method(console, 'error', () => {});
  const broken = "data:text/javascript,throw new Error('the cli blew up');//";
  const empty = "data:text/javascript,export default 'not a command';//";
  world.entries = listed(broken, empty, '@aivi/channel-slack');
  const program = await mounted();
  assert.deepEqual(
    program.commands.map(command => command.name()),
    ['slack'],
  );
  assert.deepEqual(
    stderr.mock.calls.map(call => call.arguments),
    [
      [`aivi: ${broken}/cli did not load (the cli blew up); its commands are absent.`],
      [`aivi: ${empty}/cli exports no command; its commands are absent.`],
    ],
  );
});

test('a plugin list that cannot be read is said once, and the built-in commands carry on alone', async t => {
  const stderr = t.mock.method(console, 'error', () => {});
  pluginRegistry.mock.mockImplementationOnce(async () => {
    throw new Error('app/package.json is not valid JSON');
  });
  const program = await mounted();
  assert.deepEqual(program.commands, []);
  assert.deepEqual(stderr.mock.calls[0]!.arguments, [
    'aivi: the plugin list did not load (app/package.json is not valid JSON); plugin commands are absent.',
  ]);
});
