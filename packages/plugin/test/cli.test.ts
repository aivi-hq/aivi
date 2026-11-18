import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as prompts from '@clack/prompts';
import { Command } from 'commander';
import type { PluginCliContext } from '../src/cli.ts';
import type { Store } from '../src/module.ts';
import { cliFixture } from './cli-fixture.ts';

/** A context that answers: the factory must not touch any of it to build
 *  its subtree — building costs nothing at rest. */
const ctx: PluginCliContext = {
  machine: { home: '/home', clientConfig: '/home/.config/aivi/config.json' },
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
    ['@aivi/tracker-github', 'github'],
    ['@aivi/google-meet', 'meet'],
  ] as const) {
    const factory = (await import(`${spec}/cli`)) as { default?: unknown };
    assert.equal(typeof factory.default, 'function', `${spec}/cli exports a factory`);
    const command = await (factory.default as (ctx: PluginCliContext) => Promise<Command> | Command)(ctx);
    assert.equal(command.name(), name, `${spec} answers as ${name}`);
    assert.doesNotThrow(() => validate(command), `${spec}'s command is mountable`);
  }
});

/** The inbox every adapter keeps in the home store, as far as these commands use it. */
interface Inbox {
  enqueue(turn: { id: string; channel: string; user: string; name: string; text: string }, maxPending: number): boolean;
  claimTurn(id: string): unknown;
  block(id: string): void;
  state(id: string): string | undefined;
}

test('every first-party inbox adapter shows its conversations and releases a blocked one', async t => {
  // The home store is the host's; the kit cannot name its own dependents, so they are found by name.
  const host = '@aivi/host';
  const { Store: HomeStore } = (await import(host)) as { Store: new (path: string) => Store & { close(): void } };
  // Enough of a config block for an adapter to name its inbox.
  const block = { applicationId: 'app-1', agent: 'assistant', directory: '/home/projects/site' };
  for (const adapter of [
    { spec: '@aivi/channel-discord', id: 'channel-discord', open: 'openDiscordStore', shows: 'turns' },
    { spec: '@aivi/channel-slack', id: 'channel-slack', open: 'openSlackStore', shows: 'turns' },
    { spec: '@aivi/tracker-linear', id: 'tracker-linear', open: 'openLinearStore', shows: 'conversations' },
    { spec: '@aivi/tracker-github', id: 'tracker-github', open: 'openGithubStore', shows: 'conversations' },
  ] as const) {
    await t.test(adapter.spec, async () => {
      const store = new HomeStore(':memory:');
      const entry = (await import(adapter.spec)) as Record<string, (store: Store, config: unknown) => Inbox>;
      const factory = ((await import(`${adapter.spec}/cli`)) as { default: (ctx: PluginCliContext) => Command })
        .default;
      const inbox = entry[adapter.open]!(store, block);
      inbox.enqueue({ id: 'turn-1', channel: 'conversation-1', user: 'u-1', name: 'Speaker', text: 'Question' }, 10);
      inbox.claimTurn('turn-1');
      inbox.block('turn-1');

      await assert.rejects(
        cliFixture(factory, { store }).run('status'),
        /is not configured in config\.json/,
        'a home without the plugin block says so',
      );

      const cli = cliFixture(factory, { plugins: { [adapter.id]: block }, store });
      await cli.run('status');
      const shown = (cli.printed[0] as Record<string, unknown[]>)[adapter.shows]!;
      assert.equal(shown.length, 1, 'the blocked conversation is shown');
      assert.match(JSON.stringify(shown[0]), /"state":"blocked"/);

      await cli.run('resolve', 'turn-1', '--reason', 'Inspected: the worker had stopped', '--confirm-stopped');
      assert.equal(inbox.state('turn-1'), 'discarded', 'the blocked turn is released');
      assert.deepEqual(cli.printed[1], { resolved: true });
      assert.equal(cli.pokes(), 1, 'the host is woken so freed work dispatches at once');
      store.close();
    });
  }
});
