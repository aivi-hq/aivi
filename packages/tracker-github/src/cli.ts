/** The GitHub tracker module's operator commands, mounted into the server CLI
 *  through the `./cli` subpath contract (@aivi/plugin's `(ctx) => Command`):
 *  status and resolve, over the same conversation store the module runs on.
 *  The command keeps the platform's short name — `aivi github` — for the same
 *  reason the conversations and the route do: they say who a conversation is
 *  on, not which package speaks for it. */
import type { PluginCliContext } from '@aivi/plugin';
import { resolveBlocked } from '@aivi/plugin';
import { Command } from 'commander';
import type { GithubConfig } from './config.ts';

const enabled = async (ctx: PluginCliContext) => {
  const loaded = await ctx.loaded();
  const config = loaded.config.plugins['tracker-github'] as GithubConfig | undefined;
  if (!config) throw new Error('the GitHub tracker is not configured in config.json (no plugins.tracker-github block)');
  return config;
};

export default (ctx: PluginCliContext): Command => {
  const github = new Command('github').description('the GitHub tracker');
  github
    .command('status')
    .description('Inspect GitHub conversations (workers and the assistant)')
    .action(async () => {
      await enabled(ctx);
      const { describeWorkers, openGithubStore } = await import('./index.ts');
      await ctx.withStore(store => {
        const inbox = openGithubStore(store);
        ctx.print({ conversations: describeWorkers(inbox) });
      });
    });
  github
    .command('resolve <id>')
    .description('Release a blocked worker')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id: string, options: { reason: string }) => {
      await enabled(ctx);
      const { openGithubStore } = await import('./index.ts');
      await resolveBlocked(ctx, id, options.reason, store => openGithubStore(store));
    });
  return github;
};
