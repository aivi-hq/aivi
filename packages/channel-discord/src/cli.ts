/** The Discord module's operator commands, mounted into the server CLI through
 *  the `./cli` subpath contract (@aivi/host `PluginCliCommand`): one command
 *  named after the module, its subcommands the register/status/resolve trio
 *  every channel answers. The run bodies guard their own module block and
 *  import the package's own index lazily, so mounting costs nothing at rest. */
import { type PluginCliCommand, resolveBlocked } from '@aivi/host';

const enabled = async (ctx: Parameters<PluginCliCommand['subcommands'][number]['run']>[0]) => {
  const loaded = await ctx.loaded();
  const config = typeof loaded.config.modules.discord === 'object' ? loaded.config.modules.discord : undefined;
  if (!config) throw new Error('Discord is not enabled in config.json (no modules.discord block)');
  return config;
};

const discord: PluginCliCommand = {
  name: 'discord',
  description: 'the Discord channel module',
  subcommands: [
    {
      name: 'register',
      description: 'Register slash commands for the configured application',
      async run(ctx) {
        const { registerDiscordCommands } = await import('./index.ts');
        await registerDiscordCommands(await enabled(ctx));
        ctx.print({ registered: true });
      },
    },
    {
      name: 'status',
      description: 'Inspect Discord turns and leases',
      async run(ctx) {
        const config = await enabled(ctx);
        const { openDiscordStore } = await import('./index.ts');
        await ctx.withStore(store => {
          const inbox = openDiscordStore(store, config);
          ctx.print({ turns: inbox.list(), leases: store.leases() });
        });
      },
    },
    {
      name: 'resolve',
      description: 'Release a blocked turn',
      args: '<id>',
      options: [
        { flags: '--reason <text>', description: 'what was found and done', required: true },
        { flags: '--confirm-stopped', description: 'the external side has stopped', required: true },
      ],
      async run(ctx, [id], options) {
        const config = await enabled(ctx);
        const { openDiscordStore } = await import('./index.ts');
        await resolveBlocked(ctx, id, options.reason, store => openDiscordStore(store, config));
      },
    },
  ],
};

export default discord;
