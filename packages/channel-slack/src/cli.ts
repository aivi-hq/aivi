/** The Slack module's operator commands, mounted into the server CLI through
 *  the `./cli` subpath contract (@aivi/host `PluginCliCommand`). The manifest
 *  command is the one that runs before the module exists — it is how the app
 *  gets set up — so it reads the config when there is one and asks for the
 *  prefix through the context when there is not. */
import type { PluginCliCommand, PluginCliContext } from '@aivi/host';

const enabled = async (ctx: PluginCliContext) => {
  const loaded = await ctx.loaded();
  const config = typeof loaded.config.modules.slack === 'object' ? loaded.config.modules.slack : undefined;
  if (!config) throw new Error('Slack is not enabled in config.json (no modules.slack block)');
  return config;
};

const slack: PluginCliCommand = {
  name: 'slack',
  description: 'the Slack channel module',
  subcommands: [
    {
      name: 'manifest',
      description: "The Slack app manifest as JSON, ready to paste into Slack's app setup",
      options: [
        { flags: '--prefix <prefix>', description: 'the slash command prefix, when Slack is not configured yet' },
      ],
      async run(ctx, _args, options) {
        const loaded = await ctx.loaded();
        const { slackManifest } = await import('./index.ts');
        // The prefix that matters is the one the configured module runs with;
        // `--prefix` overrides, and an unconfigured home is prompted — this
        // command exists to set the app up in the first place.
        const configured =
          typeof loaded.config.modules.slack === 'object' ? loaded.config.modules.slack.commandPrefix : undefined;
        let prefix = options.prefix ? String(options.prefix) : configured;
        if (!prefix) {
          if (!process.stdin.isTTY)
            throw new Error('Slack is not configured yet; provide the prefix: aivi slack manifest --prefix aivi');
          const answered = await ctx.ask.text({
            message: 'Slash command prefix — the commands become /<prefix>-new, /<prefix>-status, …',
            placeholder: 'aivi',
            validate: value =>
              /^[a-z][a-z0-9_-]*$/.test(String(value ?? '').trim()) ? undefined : 'Lowercase letters, digits, _ or -',
          });
          if (answered === undefined) {
            process.exitCode = 1;
            return;
          }
          prefix = answered.trim();
        }
        // A manifest is pasted into Slack's app setup, so a terminal gets raw
        // JSON text (pretty's quoting would not paste back); a pipe gets the same bytes.
        const manifest = slackManifest(prefix, { name: loaded.config.identity.name });
        ctx.print(manifest, [{ type: 'json', value: manifest }]);
      },
    },
    {
      name: 'status',
      description: 'Inspect Slack turns and leases',
      async run(ctx) {
        const config = await enabled(ctx);
        const { openSlackStore } = await import('./index.ts');
        await ctx.withStore(store => {
          const inbox = openSlackStore(store, config);
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
        const { openSlackStore } = await import('./index.ts');
        await ctx.withStore(store => {
          const inbox = openSlackStore(store, config);
          inbox.resolve(String(id), String(options.reason));
          ctx.print({ resolved: true });
        });
        await ctx.poke();
      },
    },
  ],
};

export default slack;
