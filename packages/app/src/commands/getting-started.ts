/** Identity and install-time plumbing: the commands that run before (or
 *  without) a configured home. */
import type { Command } from 'commander';
import { configPath, context, home, print } from '../context.ts';
import { serverCreate } from '../identity.ts';
import { pluginSetup } from '../plugin-setup.ts';

export function registerGettingStarted(program: Command): void {
  const server = program
    .command('server')
    .description('identity and install-time plumbing')
    .helpGroup('Getting started');
  server
    .command('create')
    .description('The identity step behind aivi setup: init the home, create your person and its token')
    .option('--use <where>', 'this-machine | another; a flag given skips its prompt')
    .option('--name <text>', "your name; records associate with it ('Operator' when unasked)")
    .action(async values => {
      print(await serverCreate({ home: home, configPath, use: values.use, name: values.name }));
    });

  const plugin = program.command('plugin').description('plugin install-time plumbing').helpGroup('Getting started');
  plugin
    .command('setup [spec]')
    .description("The install step behind aivi install: run the plugin's own ./setup")
    .action(async spec => {
      if (!spec) throw new Error('plugin setup needs the installed package.');
      const { loaded } = await context();
      await pluginSetup(spec, { home: home, configPath, identityName: loaded.config.identity.name });
    });
}
