/** Identity and install-time plumbing: the commands that run before (or
 *  without) a configured home. */
import type { Command } from 'commander';
import { configPath, context, home, print } from '../context.ts';
import { serverCreate } from '../identity.ts';
import { pluginSetup } from '../plugin-setup.ts';

export function registerGettingStarted(program: Command): void {
  // `server create` is the identity step `aivi setup` drives — plumbing, not
  // a person-facing command, so it keeps out of the help while staying
  // callable for the flow that spawns it.
  const server = program.command('server', { hidden: true }).description('identity plumbing behind aivi setup');
  server
    .command('create')
    .description('The identity step behind aivi setup: init the home, create your person and its token')
    .option('--use <where>', 'this-machine | another; a flag given skips its prompt')
    .option('--name <text>', "your name; records associate with it ('Operator' when unasked)")
    .option('--public <url>', 'the public base others reach this host at (host.public); stored and soft-probed')
    .option('--lan-bind <ip>', 'listen on this LAN/tailnet address instead of loopback')
    .action(async values => {
      print(
        await serverCreate({
          home: home,
          configPath,
          use: values.use,
          name: values.name,
          public: values.public,
          lanBind: values.lanBind,
        }),
      );
    });

  const plugin = program.command('plugin').description('plugin install-time plumbing').helpGroup('Getting started');
  plugin
    .command('setup [spec]')
    .description("The setup step behind aivi add: run the plugin's own ./setup")
    .action(async spec => {
      if (!spec) throw new Error('plugin setup needs the installed package.');
      const { loaded } = await context();
      await pluginSetup(spec, { home: home, configPath, identityName: loaded.config.identity.name });
    });
}
