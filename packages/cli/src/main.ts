#!/usr/bin/env node
/** The thin aivi CLI. It installs and controls the server; the server does the
 *  assistant work. The CLI owns `setup` (sign in or create), `update`,
 *  `upgrade`, `uninstall` and the service commands, and forwards every other
 *  command — argv untouched — into the installed app; it never imports host
 *  code. Commander owns parsing and help for the commands it owns; anything
 *  else is forwarded before commander sees it, so the app's own help and
 *  errors are the ones a person gets. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandBanner } from '@aivi/core';
import { Command, CommanderError } from 'commander';
import { loadClientConfig } from './client-config.ts';
import { forward } from './forward.ts';
import { homeForCreate, homeFromEnvOrConfig, requireHome } from './home.ts';
import { install } from './install.ts';
import { link } from './link.ts';
import {
  serviceInstall,
  serviceLogs,
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
  serviceUninstall,
} from './service.ts';
import { setup } from './setup.ts';
import { uninstall } from './uninstall.ts';
import { updateServer } from './update.ts';
import { upgradeCli } from './upgrade.ts';

const version = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
).version;

/** The commands this CLI owns; everything else forwards into the installed app. */
const OWN = new Set(['setup', 'link', 'install', 'update', 'upgrade', 'uninstall', 'service']);
const HELP_FORMS = new Set(['help', '--help', '-h', '--version', 'version']);

export async function main(argv: string[]): Promise<void> {
  const [command, subcommand] = argv;

  // `server create` moved behind `aivi setup`; say so rather than forwarding
  // into the app, whose copy would do the identity step twice.
  if (command === 'server' && subcommand === 'create')
    throw new Error('`server create` is now part of `aivi setup`. Run: aivi setup');

  // `aivi version` is this CLI's version, not the app's.
  if (command === 'version') {
    process.stdout.write(`${version}\n`);
    return;
  }

  // Not ours (or not a help form we can answer): the installed app runs it with
  // the same arguments — the forwarding contract is argv, byte for byte.
  if (command !== undefined && !OWN.has(command) && !HELP_FORMS.has(command)) {
    const home = requireHome();
    const appDir = loadClientConfig()?.appDir ?? `${home}/app`;
    process.exitCode = forward(argv, { home, appDir, nodePath: loadClientConfig()?.nodePath });
    return;
  }
  // `aivi help X` for a command the thin CLI does not own also belongs to the
  // app — its help knows the jobs, channels and the rest.
  if (command === 'help' && subcommand !== undefined && !OWN.has(subcommand)) {
    const home = requireHome();
    const appDir = loadClientConfig()?.appDir ?? `${home}/app`;
    process.exitCode = forward(argv, { home, appDir, nodePath: loadClientConfig()?.nodePath });
    return;
  }

  const program = new Command('aivi').version(version).showHelpAfterError('(run `aivi --help` for a list of commands)');

  // These commands keep their own flag handling (they pass unknown flags to
  // plugins and scripts), so they are declared as catch-alls: commander routes,
  // the command's own extractor rejects what it does not know.
  const passThrough = (name: string, description: string) =>
    program.command(`${name} [args...]`).description(description).allowUnknownOption(true);

  passThrough('setup', 'Sign in to an existing host, or create the server here').action(async (...rest) => {
    const args = rest.at(-1).args as string[];
    await setup(args, { home: homeForCreate() });
  });
  passThrough('link', 'Mint a one-time code that links a channel account to your person').action(async (...rest) => {
    const args = rest.at(-1).args as string[];
    await link(args);
  });
  passThrough(
    'install',
    'Add a plugin to the server home: it installs, configures itself through its own setup entry, and aivi comes back with it running',
  )
    .helpGroup('Plugins')
    .action(async (...rest) => {
      const args = rest.at(-1).args as string[];
      const home = requireHome();
      const config = loadClientConfig();
      await install(args, {
        home,
        appDir: config?.appDir ?? join(home, 'app'),
        nodePath: config?.nodePath ?? process.execPath,
      });
    });

  program
    .command('update')
    .description('Update the installed server and plugins (channel: config.json update.channel)')
    .helpGroup('Updates')
    .action(async () => {
      const home = requireHome();
      const config = loadClientConfig();
      await updateServer({
        home,
        appDir: config?.appDir ?? join(home, 'app'),
        nodePath: config?.nodePath ?? process.execPath,
      });
    });

  program
    .command('upgrade')
    .description('Update this CLI through its install method (npm today)')
    .helpGroup('Updates')
    .action(() => upgradeCli());

  program
    .command('uninstall')
    .description('Delete the aivi home and the client config, then this CLI. Lists what would go until --confirm')
    .option('--confirm', 'delete what is listed')
    .option('--with-attribution', "also remove the opencode-attribution plugin, which is not aivi's")
    .helpGroup('Updates')
    .action(async values => {
      // Not interactive: the listing is the confirmation, --confirm is the answer.
      const done = await uninstall({
        home: homeFromEnvOrConfig(),
        confirm: values.confirm ?? false,
        withAttribution: values.withAttribution ?? false,
      });
      if (!done) process.exitCode = 1;
    });

  program
    .command('service [verb]')
    .description(
      'Run the server in the background (LaunchAgent / systemd user unit): install, uninstall, start, stop, restart, status, logs',
    )
    .helpGroup('Service')
    .action(async verb => {
      const home = requireHome();
      const config = loadClientConfig();
      const options = {
        home,
        appDir: config?.appDir ?? join(home, 'app'),
        nodePath: config?.nodePath ?? process.execPath,
      };
      switch (verb) {
        case 'install':
          return serviceInstall(options);
        case 'uninstall':
          return serviceUninstall();
        case 'start':
          return serviceStart();
        case 'stop':
          return serviceStop();
        case 'restart':
          return serviceRestart();
        case 'status':
          return serviceStatus();
        case 'logs':
          return serviceLogs(home);
        default:
          throw new Error('Unknown service command. One of: install, uninstall, start, stop, restart, status, logs');
      }
    });

  program.addHelpText(
    'before',
    `${brandBanner(
      [
        { text: `aivi v${version} — the always-on teammate around OpenCode` },
        { text: 'The server does the work; this CLI installs and controls it.', muted: true },
      ],
      process.stdout,
    )}\n`,
  );
  program.addHelpText(
    'after',
    `
Home: ~/.aivi (AIVI_HOME leads over the home recorded in ~/.config/aivi.json)
holds config.json, .env, app/ (the installed server) and state/.
Every other command — jobs, runs, people, projects, sources, knowledge, status,
config, discord, slack, linear — runs in the installed app, arguments and all.`,
  );

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has written its message already; showing help or the version is success.
      process.exitCode =
        error.code === 'commander.help' ||
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version'
          ? 0
          : error.exitCode;
      return;
    }
    throw error;
  }
}

try {
  await main(process.argv.slice(2));
  if (process.exitCode === undefined) process.exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
