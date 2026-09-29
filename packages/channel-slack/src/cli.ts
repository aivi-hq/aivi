/** The Slack module's operator commands, mounted into the server CLI through
 *  the `./cli` subpath contract (@aivi/plugin's `(ctx) => Command`). The manifest
 *  command is the one that runs before the module exists — it is how the app
 *  gets set up — so it reads the config when there is one and asks for the
 *  prefix with the runner's own clack when there is not. */
import type { PluginCliContext } from '@aivi/plugin';
import { resolveBlocked } from '@aivi/plugin';
import { Command } from 'commander';
import type { SlackConfig } from './config.ts';
import { MODULE_ID } from './config.ts';

const enabled = async (ctx: PluginCliContext): Promise<SlackConfig> => {
  const loaded = await ctx.loaded();
  const config = loaded.config.plugins[MODULE_ID] as SlackConfig | undefined;
  if (!config) throw new Error('Slack is not configured in config.json (no plugins.channel-slack block)');
  return config;
};

export default (ctx: PluginCliContext): Command => {
  const slack = new Command('slack').description('the Slack channel module');
  slack
    .command('manifest')
    .description("The Slack app manifest as JSON, ready to paste into Slack's app setup")
    .option('--prefix <prefix>', 'the slash command prefix, when Slack is not configured yet')
    .action(async (options: { prefix?: string }) => {
      const loaded = await ctx.loaded();
      const { slackManifest } = await import('./index.ts');
      // The prefix that matters is the one the configured module runs with;
      // `--prefix` overrides, and an unconfigured home is prompted — this
      // command exists to set the app up in the first place.
      const configured = (loaded.config.plugins[MODULE_ID] as SlackConfig | undefined)?.commandPrefix;
      let prefix = options.prefix ? String(options.prefix) : configured;
      if (!prefix) {
        if (!process.stdin.isTTY)
          throw new Error('Slack is not configured yet; provide the prefix: aivi slack manifest --prefix aivi');
        const answered = await ctx.prompts.text({
          message: 'Slash command prefix — the commands become /<prefix>-new, /<prefix>-status, …',
          placeholder: 'aivi',
          validate: value =>
            !String(value ?? '').trim() || /^[a-z][a-z0-9_-]*$/.test(String(value ?? '').trim())
              ? undefined
              : 'Lowercase letters, digits, _ or -',
        });
        // Clack answers Ctrl+C with its cancel symbol and an empty Enter with
        // nothing — neither is an answer; the command ends unsaid.
        if (ctx.prompts.isCancel(answered) || answered === undefined) {
          process.exitCode = 1;
          return;
        }
        prefix = String(answered).trim() || 'aivi';
      }
      // A manifest is pasted into Slack's app setup, so a terminal gets raw
      // JSON text (pretty's quoting would not paste back); a pipe gets the same bytes.
      const manifest = slackManifest(prefix, { name: loaded.config.identity.name });
      ctx.print(manifest, [{ type: 'json', value: manifest }]);
    });
  slack
    .command('status')
    .description('Inspect Slack turns and leases')
    .action(async () => {
      const config = await enabled(ctx);
      const { openSlackStore } = await import('./index.ts');
      await ctx.withStore(store => {
        const inbox = openSlackStore(store, config);
        ctx.print({ turns: inbox.list(), leases: store.leases() });
      });
    });
  slack
    .command('resolve <id>')
    .description('Release a blocked turn')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id: string, options: { reason: string }) => {
      const config = await enabled(ctx);
      const { openSlackStore } = await import('./index.ts');
      await resolveBlocked(ctx, id, options.reason, store => openSlackStore(store, config));
    });
  return slack;
};
