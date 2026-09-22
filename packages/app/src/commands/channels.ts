/** Channel modules: Discord, Slack and Linear operator commands. The packages
 *  themselves load lazily, only in the commands that need them. */

import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { context, print, withStore } from '../context.ts';

export function registerChannels(program: Command): void {
  const discordConfig = async () => {
    const { loaded } = await context();
    const value = typeof loaded.config.modules.discord === 'object' ? loaded.config.modules.discord : undefined;
    if (!value) throw new Error('Discord is not enabled in config.json (no modules.discord block)');
    return value;
  };
  const discord = program.command('discord').description('the Discord channel module').helpGroup('Channels');
  discord
    .command('register')
    .description('Register slash commands for the configured application')
    .action(async () => {
      const discord = await import('@aivi/channel-discord');
      await discord.registerDiscordCommands(await discordConfig());
      print({ registered: true });
    });
  discord
    .command('status')
    .description('Inspect Discord turns and leases')
    .action(async () => {
      const { loaded } = await context();
      const config = await discordConfig();
      const discord = await import('@aivi/channel-discord');
      await withStore(loaded, store => {
        const inbox = discord.openDiscordStore(store, config);
        print({ turns: inbox.list(), leases: store.leases() });
      });
    });
  discord
    .command('resolve <id>')
    .description('Release a blocked turn')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id, values) => {
      const { loaded, poke } = await context();
      const config = await discordConfig();
      const discord = await import('@aivi/channel-discord');
      await withStore(loaded, store => {
        const inbox = discord.openDiscordStore(store, config);
        inbox.resolve(id, values.reason);
        print({ resolved: true });
      });
      await poke();
    });

  const slackConfigured = async () => {
    const { loaded } = await context();
    const value = typeof loaded.config.modules.slack === 'object' ? loaded.config.modules.slack : undefined;
    if (!value) throw new Error('Slack is not enabled in config.json (no modules.slack block)');
    return value;
  };
  const slack = program.command('slack').description('the Slack channel module').helpGroup('Channels');
  slack
    .command('manifest')
    .description("The Slack app manifest as JSON, ready to paste into Slack's app setup")
    .option('--prefix <prefix>', 'the slash command prefix, when Slack is not configured yet')
    .action(async values => {
      const { loaded } = await context();
      const slack = await import('@aivi/channel-slack');
      // The prefix that matters is the one the configured module runs with;
      // `--prefix` overrides, and an unconfigured home is prompted — this
      // command exists to set the app up in the first place.
      const configured =
        typeof loaded.config.modules.slack === 'object' ? loaded.config.modules.slack.commandPrefix : undefined;
      let prefix = values.prefix ?? configured;
      if (!prefix) {
        if (!process.stdin.isTTY)
          throw new Error('Slack is not configured yet; provide the prefix: aivi slack manifest --prefix aivi');
        const answered = await p.text({
          message: 'Slash command prefix — the commands become /<prefix>-new, /<prefix>-status, …',
          placeholder: 'aivi',
          validate: value =>
            /^[a-z][a-z0-9_-]*$/.test(String(value ?? '').trim()) ? undefined : 'Lowercase letters, digits, _ or -',
        });
        if (p.isCancel(answered)) {
          process.exitCode = 1;
          return;
        }
        prefix = answered.trim();
      }
      print(slack.slackManifest(prefix, { name: loaded.config.identity.name }));
    });
  slack
    .command('status')
    .description('Inspect Slack turns and leases')
    .action(async () => {
      const { loaded } = await context();
      const config = await slackConfigured();
      const slack = await import('@aivi/channel-slack');
      await withStore(loaded, store => {
        const inbox = slack.openSlackStore(store, config);
        print({ turns: inbox.list(), leases: store.leases() });
      });
    });
  slack
    .command('resolve <id>')
    .description('Release a blocked turn')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id, values) => {
      const { loaded, poke } = await context();
      const config = await slackConfigured();
      const slack = await import('@aivi/channel-slack');
      await withStore(loaded, store => {
        const inbox = slack.openSlackStore(store, config);
        inbox.resolve(id, values.reason);
        print({ resolved: true });
      });
      await poke();
    });

  const linear = program.command('linear').description('the Linear module').helpGroup('Channels');
  linear
    .command('status')
    .description('Inspect Linear conversations (workers and the assistant) and leases')
    .action(async () => {
      const { loaded } = await context();
      if (!loaded.config.linear) throw new Error('Linear is not configured in config.json');
      const linearModule = await import('@aivi/linear');
      await withStore(loaded, store => {
        const inbox = linearModule.openLinearStore(store);
        print({ conversations: linearModule.describeWorkers(inbox), leases: store.leases() });
      });
    });
  linear
    .command('resolve <id>')
    .description('Release a blocked worker')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id, values) => {
      const { loaded, poke } = await context();
      if (!loaded.config.linear) throw new Error('Linear is not configured in config.json');
      const linearModule = await import('@aivi/linear');
      await withStore(loaded, store => {
        const inbox = linearModule.openLinearStore(store);
        inbox.resolve(id, values.reason);
        print({ resolved: true });
      });
      await poke();
    });
}
