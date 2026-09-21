/** The thin aivi CLI. It installs and controls the server; the server does the
 *  assistant work. The CLI owns `server create`, `update`, `upgrade` and the
 *  service commands, and forwards every other command into the installed app —
 *  it never imports host code. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClientConfig } from './client-config.ts';
import { serverCreate } from './create.ts';
import { forward } from './forward.ts';
import { homeForCreate, requireHome } from './home.ts';
import {
  serviceInstall,
  serviceLogs,
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
  serviceUninstall,
} from './service.ts';
import { updateServer } from './update.ts';
import { upgradeCli } from './upgrade.ts';

const version = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version: string;
  }
).version;

const usage = `aivi <command>

  server create               Install the server into <home>/app and set up identity
                              [--plugin @aivi/channel-discord …] [--use this-machine|another] [--name TEXT]
  serve                       Start the server in the foreground
  update                      Update the installed server and plugins (channel: config.json update.channel)
  upgrade                     Update this CLI through its install method (npm today)
  service install|uninstall   Run the server in the background (LaunchAgent / systemd user unit)
  service start|stop|restart|status|logs
  jobs, runs, people, projects, sources, knowledge, status, config,
  discord, slack, linear      Run in the installed app; every argument passes through

Home: ~/.aivi (AIVI_HOME leads over the home recorded in ~/.config/aivi.json)
holds config.json, .env, app/ (the installed server) and state/.
`;

export async function main(argv: string[]): Promise<void> {
  const [command, subcommand] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage);
    return;
  }
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === 'server' && subcommand === 'create') {
    serverCreate(argv.slice(2), { home: homeForCreate() });
    return;
  }
  if (command === 'update') {
    const home = requireHome();
    const config = loadClientConfig();
    await updateServer({
      home,
      appDir: config?.appDir ?? join(home, 'app'),
      nodePath: config?.nodePath ?? process.execPath,
    });
    return;
  }
  if (command === 'upgrade') {
    upgradeCli();
    return;
  }
  if (command === 'service') {
    const home = requireHome();
    const config = loadClientConfig();
    const options = {
      home,
      appDir: config?.appDir ?? join(home, 'app'),
      nodePath: config?.nodePath ?? process.execPath,
    };
    switch (subcommand) {
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
  }

  // Everything else runs in the installed app.
  const home = requireHome();
  const appDir = loadClientConfig()?.appDir ?? `${home}/app`;
  process.exitCode = forward(argv, { home, appDir, nodePath: loadClientConfig()?.nodePath });
}

try {
  await main(process.argv.slice(2));
  if (process.exitCode === undefined) process.exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
