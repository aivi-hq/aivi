import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginCliCommand } from '../src/plugin-cli.ts';

/** The mount function under test: copied shape-wise from the app's
 *  commands/channels.ts `mount` responsibility. The app owns the real one;
 *  here the contract's data shape is what is asserted — the same test would
 *  not compile if the contract changed shape. */
function validate(command: PluginCliCommand): void {
  assert.equal(typeof command.name, 'string');
  assert.match(command.name, /^[a-z][a-z0-9-]*$/, 'a command name is one word');
  for (const sub of command.subcommands) {
    assert.equal(typeof sub.name, 'string');
    assert.equal(typeof sub.description, 'string');
    assert.equal(typeof sub.run, 'function');
    for (const option of sub.options ?? []) {
      assert.match(option.flags, /^--/);
      assert.equal(typeof option.description, 'string');
    }
  }
}

test('a plugin cli command is data the app can mount', () => {
  const command: PluginCliCommand = {
    name: 'acme',
    description: 'the acme module',
    subcommands: [
      {
        name: 'ping',
        description: 'ask acme to answer',
        args: '<id>',
        options: [{ flags: '--reason <text>', description: 'why', required: true }],
        async run(ctx, args, options) {
          ctx.print({ pinged: args[0], reason: options.reason });
        },
      },
    ],
  };
  assert.doesNotThrow(() => validate(command));
});

test('every first-party adapter exports a valid ./cli command', async () => {
  for (const [spec, name] of [
    ['@aivi/channel-discord', 'discord'],
    ['@aivi/channel-slack', 'slack'],
    ['@aivi/linear', 'linear'],
  ] as const) {
    const command = ((await import(`${spec}/cli`)) as { default: PluginCliCommand }).default;
    assert.equal(command.name, name, `${spec} answers as ${name}`);
    assert.doesNotThrow(() => validate(command), `${spec}'s command is mountable`);
  }
});
