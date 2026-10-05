import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as prompts from '@clack/prompts';
import { Command } from 'commander';
import type { PluginCliContext } from '../src/cli.ts';

/** A context that answers: the factory must not touch any of it to build
 *  its subtree — building costs nothing at rest. */
const ctx: PluginCliContext = {
  machine: { home: '/home', clientConfig: '/home/.config/aivi.json' },
  home: '/home',
  configPath: '/home/config.json',
  loaded: async () => {
    throw new Error('a factory builds before it runs: nothing loads at mount time');
  },
  withStore: async () => {
    throw new Error('a factory builds before it runs: no store opens at mount time');
  },
  print: () => {},
  log: () => {},
  poke: async () => {},
  prompts,
};

/** The shape the mount asserts: a named commander subtree with named subcommands. */
function validate(command: Command): void {
  assert.match(command.name(), /^[a-z][a-z0-9-]*$/, 'a command name is one word');
  assert.ok(command.description(), 'the command says what it is');
  for (const sub of command.commands) {
    assert.match(sub.name(), /^[a-z][a-z0-9-]*$/, 'a subcommand name is one word');
    assert.ok(sub.description(), 'the subcommand says what it does');
  }
}

test('a plugin cli factory builds its own commander subtree', async () => {
  const factory = (_ctx: PluginCliContext): Command => {
    const acme = new Command('acme').description('the acme module').helpGroup('Channels');
    acme
      .command('ping <id>')
      .description('ask acme to answer')
      .requiredOption('--reason <text>', 'why')
      .action(() => {});
    return acme;
  };
  const command = await factory(ctx);
  assert.doesNotThrow(() => validate(command));
  assert.equal(command.name(), 'acme');
});

test('every first-party adapter exports a valid ./cli factory', async () => {
  for (const [spec, name] of [
    ['@aivi/channel-discord', 'discord'],
    ['@aivi/channel-slack', 'slack'],
    ['@aivi/tracker-linear', 'linear'],
  ] as const) {
    const factory = (await import(`${spec}/cli`)) as { default?: unknown };
    assert.equal(typeof factory.default, 'function', `${spec}/cli exports a factory`);
    const command = await (factory.default as (ctx: PluginCliContext) => Promise<Command> | Command)(ctx);
    assert.equal(command.name(), name, `${spec} answers as ${name}`);
    assert.doesNotThrow(() => validate(command), `${spec}'s command is mountable`);
  }
});
