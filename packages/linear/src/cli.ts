/** The Linear module's operator commands, mounted into the server CLI through
 *  the `./cli` subpath contract (@aivi/host `PluginCliCommand`): status and
 *  resolve, over the same conversation store the module runs on. */
import { type PluginCliCommand, type PluginCliContext, resolveBlocked } from '@aivi/host';

const enabled = async (ctx: PluginCliContext) => {
  const loaded = await ctx.loaded();
  if (!loaded.config.linear) throw new Error('Linear is not configured in config.json');
  return loaded.config.linear;
};

const linear: PluginCliCommand = {
  name: 'linear',
  description: 'the Linear module',
  subcommands: [
    {
      name: 'status',
      description: 'Inspect Linear conversations (workers and the assistant) and leases',
      async run(ctx) {
        await enabled(ctx);
        const { describeWorkers, openLinearStore } = await import('./index.ts');
        await ctx.withStore(store => {
          const inbox = openLinearStore(store);
          ctx.print({ conversations: describeWorkers(inbox), leases: store.leases() });
        });
      },
    },
    {
      name: 'resolve',
      description: 'Release a blocked worker',
      args: '<id>',
      options: [
        { flags: '--reason <text>', description: 'what was found and done', required: true },
        { flags: '--confirm-stopped', description: 'the external side has stopped', required: true },
      ],
      async run(ctx, [id], options) {
        await enabled(ctx);
        const { openLinearStore } = await import('./index.ts');
        await resolveBlocked(ctx, id, options.reason, store => openLinearStore(store));
      },
    },
  ],
};

export default linear;
