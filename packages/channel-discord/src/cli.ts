/** The Discord module's operator commands, mounted into the server CLI through
 *  the `./cli` subpath contract (@aivi/plugin's `(ctx) => Command`): one command
 *  named after the module, its subcommands the register/status/resolve trio
 *  every channel answers. The run bodies guard their own module block and
 *  import the package's own index lazily, so mounting costs nothing at rest. */
import type { PluginCliContext } from '@aivi/plugin';
import { resolveBlocked } from '@aivi/plugin';
import { Command } from 'commander';

const enabled = async (ctx: PluginCliContext) => {
  const loaded = await ctx.loaded();
  const config = typeof loaded.config.modules.discord === 'object' ? loaded.config.modules.discord : undefined;
  if (!config) throw new Error('Discord is not enabled in config.json (no modules.discord block)');
  return config;
};

export default (ctx: PluginCliContext): Command => {
  const discord = new Command('discord').description('the Discord channel module');
  discord
    .command('register')
    .description('Register slash commands for the configured application')
    .action(async () => {
      const { registerDiscordCommands } = await import('./index.ts');
      await registerDiscordCommands(await enabled(ctx));
      ctx.print({ registered: true });
    });
  discord
    .command('status')
    .description('Inspect Discord turns and leases')
    .action(async () => {
      const config = await enabled(ctx);
      const { openDiscordStore } = await import('./index.ts');
      await ctx.withStore(store => {
        const inbox = openDiscordStore(store, config);
        ctx.print({ turns: inbox.list(), leases: store.leases() });
      });
    });
  discord
    .command('resolve <id>')
    .description('Release a blocked turn')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id: string, options: { reason: string }) => {
      const config = await enabled(ctx);
      const { openDiscordStore } = await import('./index.ts');
      await resolveBlocked(ctx, id, options.reason, store => openDiscordStore(store, config));
    });
  return discord;
};
