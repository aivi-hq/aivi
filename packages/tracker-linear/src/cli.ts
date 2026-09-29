/** The Linear module's operator commands, mounted into the server CLI through
 *  the `./cli` subpath contract (@aivi/plugin's `(ctx) => Command`): status and
 *  resolve, over the same conversation store the module runs on. */
import type { PluginCliContext } from '@aivi/plugin';
import { resolveBlocked } from '@aivi/plugin';
import { Command } from 'commander';
import type { LinearConfig } from './config.ts';

const enabled = async (ctx: PluginCliContext) => {
  const loaded = await ctx.loaded();
  const config = loaded.config.plugins['tracker-linear'] as LinearConfig | undefined;
  if (!config) throw new Error('Linear is not configured in config.json (no plugins.tracker-linear block)');
  return config;
};

export default (ctx: PluginCliContext): Command => {
  const linear = new Command('linear').description('the Linear module');
  linear
    .command('status')
    .description('Inspect Linear conversations (workers and the assistant) and leases')
    .action(async () => {
      await enabled(ctx);
      const { describeWorkers, openLinearStore } = await import('./index.ts');
      await ctx.withStore(store => {
        const inbox = openLinearStore(store);
        ctx.print({ conversations: describeWorkers(inbox), leases: store.leases() });
      });
    });
  linear
    .command('resolve <id>')
    .description('Release a blocked worker')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id: string, options: { reason: string }) => {
      await enabled(ctx);
      const { openLinearStore } = await import('./index.ts');
      await resolveBlocked(ctx, id, options.reason, store => openLinearStore(store));
    });
  return linear;
};
