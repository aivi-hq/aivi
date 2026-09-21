/** The thin aivi CLI. It installs and controls the server; the server does the
 *  assistant work. The CLI owns `server create` (the bootstrap), and forwards
 *  every other command into the installed app — it never imports host code. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadClientConfig } from './client-config.ts';
import { serverCreate } from './create.ts';
import { forward } from './forward.ts';
import { homeForCreate, requireHome } from './home.ts';

const version = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version: string;
  }
).version;

const usage = `aivi <command>

  server create               Install the server into <home>/app and set up identity
                              [--plugin @aivi/channel-discord …] [--use this-machine|another] [--name TEXT]
  serve                       Start the server in the foreground
  jobs, runs, people, projects, sources, knowledge, status, config,
  discord, slack, linear      Run in the installed app; every argument passes through
  update                      Update the installed server (arrives with the first release)
  upgrade                     Update this CLI (arrives with the first release)

Home: ~/.aivi (AIVI_HOME leads over the home recorded in ~/.config/aivi.json)
holds config.json, .env, app/ (the installed server) and state/.
`;

export function main(argv: string[]): void {
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
  if (command === 'update')
    throw new Error(
      'aivi update arrives with the first npm release; it will resolve the newest @aivi/app and install it into <home>/app.',
    );
  if (command === 'upgrade')
    throw new Error(
      'aivi upgrade arrives with the first npm release; it will update this CLI through its install method.',
    );

  // Everything else runs in the installed app.
  const home = requireHome();
  const appDir = loadClientConfig()?.appDir ?? `${home}/app`;
  process.exitCode = forward(argv, { home, appDir, nodePath: loadClientConfig()?.nodePath });
}

try {
  main(process.argv.slice(2));
  if (process.exitCode === undefined) process.exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
