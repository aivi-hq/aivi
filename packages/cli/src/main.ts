#!/usr/bin/env node
/** The aivi CLI. It installs and controls the server; the server does the
 *  assistant work. The CLI owns `setup` (sign in or create), `add`, `remove`,
 *  `update`, `upgrade`, `uninstall` and the service commands, and mounts every
 *  other command **in-process** from the installed app (mount.ts) onto the same
 *  commander tree — one help, one parse, no relay. The CLI itself never
 *  imports app or host code statically.
 *
 *  Commands that cannot run on this machine are never registered, and
 *  commands the channel must not run answer their own guard line: the
 *  machine facts — a home here or none, driven remotely or not — are decided
 *  once per run, the home is shown in the help header (`home: ~/.aivi` /
 *  `home: none`), and both are handed to every command provider. A machine
 *  without a home sees only what it can do there; a typed command it does not
 *  have is honestly an unknown command. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { add } from './add.ts';
import { brandBanner } from './brand.ts';
import { loadClientConfig } from './client-config.ts';
import { configure } from './configure.ts';
import { execRemote } from './exec.ts';
import { homeForCreate, homeFromEnvOrConfig, type MachineStatus, machineStatus, requireHome } from './home.ts';
import { link } from './link.ts';
import { appDirFor, mountAppCommands } from './mount.ts';
import { remove } from './remove.ts';
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

/** Driving another machine is intent, typed as `--remote`/`-r`: the flag
 *  comes out, everything else travels verbatim, and local execution never
 *  happens (decision D23 — there is no fallback to a different machine's
 *  answer, and plain commands never touch the network). A driven session is
 *  already the far end of a channel: `-r` does not chain a second hop.
 *  True means this run was handed on and main is done. */
async function takeRemoteFlag(argv: string[], machine: MachineStatus): Promise<boolean> {
  const remoteAt = argv.findIndex(argument => argument === '--remote' || argument === '-r');
  if (remoteAt === -1) return false;
  if (machine.remote === true) throw new Error('remote exec does not chain: this session is already driven remotely');
  await execRemote(argv.toSpliced(remoteAt, 1));
  return true;
}

/** The client-side guard (decision D23): commands that act on the machine you
 *  type on are refused over the channel by *them* — this file declares them,
 *  so this file is the provider that decides. When the machine fact says the
 *  process is driven remotely, their own actions answer the guard line, never
 *  `unknown command`, whatever the help showed. */
const actsHere = (machine: MachineStatus): void => {
  if (machine.remote === true) throw new Error('this acts on the machine you type on');
};

/** Commands that keep their own flag handling (they pass unknown flags to
 *  plugins and scripts) are declared as catch-alls: commander routes, the
 *  command's own extractor rejects what it does not know. */
const passThrough = (program: Command, name: string, description: string) =>
  program.command(`${name} [args...]`).description(description).allowUnknownOption(true);

/** `setup` signs this machine in to a host or creates the server here;
 *  `configure` edits the client record itself, so it is registered exactly
 *  where a record exists — existence, not parseability: a broken record is
 *  what the command is for, and a machine with no record gets `setup`, which
 *  creates the first one. Client-side like `upgrade`: over the channel both
 *  answer the guard line, because the remote person runs them on the laptop,
 *  never through the relay. */
function registerClientCommands(program: Command, machine: MachineStatus): void {
  passThrough(program, 'setup', 'Sign in to an existing host, or create the server here').action(async (...rest) => {
    actsHere(machine);
    const args = rest.at(-1).args as string[];
    await setup(args, { home: homeForCreate() });
  });
  if (machine.clientConfig === undefined) return;
  program
    .command('configure')
    .description("Edit this machine's client record: the host url, the home, the app dir. The signed-in person stays")
    .option('--url <url>', 'where the host answers')
    .option('--home <path>', 'the aivi home this machine works on')
    .option('--app-dir <path>', 'the directory holding the installed server')
    .action(values => {
      actsHere(machine);
      configure({
        url: values.url as string | undefined,
        home: values.home as string | undefined,
        appDir: values.appDir as string | undefined,
      });
    });
}

/** Everything below here acts on a home. A machine that has none — a laptop
 *  that only ever drives the server with `-r` — never registers these. */
function registerHomeCommands(program: Command): void {
  passThrough(program, 'link', 'Mint a one-time code that links a channel account to your person').action(
    async (...rest) => {
      const args = rest.at(-1).args as string[];
      await link(args);
    },
  );
  passThrough(
    program,
    'add',
    'Add a plugin to the server home: it installs, configures itself through its own setup entry, joins the plugin list, and aivi comes back with it running',
  )
    .helpGroup('Plugins')
    .action(async (...rest) => {
      const args = rest.at(-1).args as string[];
      const home = requireHome();
      const config = loadClientConfig();
      await add(args, {
        home,
        appDir: appDirFor(home),
        nodePath: config?.nodePath ?? process.execPath,
      });
    });
  passThrough(
    program,
    'remove',
    'Remove a plugin from the server home: out of the plugin list, its config block dropped, the package uninstalled, and aivi comes back without it',
  )
    .helpGroup('Plugins')
    .action(async (...rest) => {
      const args = rest.at(-1).args as string[];
      const home = requireHome();
      const config = loadClientConfig();
      await remove(args, {
        home,
        appDir: appDirFor(home),
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
        appDir: appDirFor(home),
        nodePath: config?.nodePath ?? process.execPath,
      });
    });
}

/** `upgrade` and `uninstall` are registered whatever the home: the exit ramp
 *  is among them because a CLI that refuses to exist when there is no home
 *  could never be uninstalled. */
function registerExitRamp(program: Command, machine: MachineStatus): void {
  program
    .command('upgrade')
    .description('Update this CLI through its install method (npm today)')
    .helpGroup('Updates')
    .action(() => {
      actsHere(machine);
      return upgradeCli();
    });

  program
    .command('uninstall')
    .description(
      'Take aivi off this machine entirely: the home, the client config, the service and this CLI. Lists what would go until --confirm',
    )
    .option('--confirm', 'delete what is listed')
    .option('--with-attribution', "also remove the opencode-attribution plugin, which is not aivi's")
    .helpGroup('Updates')
    .action(async values => {
      // Refuse-relay (decision D14): over the channel this deletes the home
      // the session itself runs on and kills the host driving it. The command
      // answers its own guard, never `unknown command`.
      if (machine.remote === true)
        throw new Error('uninstall deletes the home this session drives; run it on the machine itself');
      // Not interactive: the listing is the confirmation, --confirm is the answer.
      const done = await uninstall({
        home: homeFromEnvOrConfig(),
        confirm: values.confirm ?? false,
        withAttribution: values.withAttribution ?? false,
      });
      if (!done) process.exitCode = 1;
    });
}

/** The service commands' one option set: where the home is and what runs it. */
interface ServiceOptions {
  home: string;
  appDir: string;
  nodePath: string;
}

/** The verb names the operation; anything else is said with the whole list. */
async function serviceVerb(verb: string, options: ServiceOptions): Promise<void> {
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
      return serviceLogs(options.home);
    default:
      throw new Error('Unknown service command. One of: install, uninstall, start, stop, restart, status, logs');
  }
}

function registerServiceCommand(program: Command): void {
  program
    .command('service [verb]')
    .description(
      'Run the server in the background (LaunchAgent / systemd user unit): install, uninstall, start, stop, restart, status, logs',
    )
    .helpGroup('Service')
    .action(async verb => {
      const home = requireHome();
      const config = loadClientConfig();
      await serviceVerb(verb, {
        home,
        appDir: appDirFor(home),
        nodePath: config?.nodePath ?? process.execPath,
      });
    });
}

/** The installed app's commands join this tree only when the request is not
 *  a machine command built above: commander's own registry is the machine
 *  set, so there is no second list to keep in step. A help form mounts on
 *  best effort — help shows what is mounted, and a missing or broken install
 *  says so in the footer instead of hiding the machine commands; an operator
 *  command mounts or says why it cannot run. Without a home there is no app
 *  to mount and no attempt is made: what is not here stays not here. The
 *  answer is the reason a mount could not happen, when it could not. */
async function mountForRequest(
  program: Command,
  command: string | undefined,
  machine: MachineStatus,
): Promise<string | undefined> {
  if (machine.home === undefined) return undefined;
  const machineCommands = new Set(program.commands.map(c => c.name()));
  const helpForm = command === undefined || command === 'help' || command === '--help' || command === '-h';
  if (helpForm) {
    try {
      await mountAppCommands(program);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  } else if (command !== '--version' && !machineCommands.has(command)) {
    await mountAppCommands(program);
  }
  return undefined;
}

/** The help footer: where the home is, and what this machine's state means
 *  for what the listing holds. */
function helpFooter(home: string | undefined, mountError: string | undefined): string {
  const footer = `
Home: ~/.aivi (AIVI_HOME leads over the home recorded in ~/.config/aivi/config.json)
holds config.json, .env, app/ (the installed server) and state/`;
  if (home === undefined)
    return `${footer}
No server here: \`aivi setup\` creates one, or signs this machine in to another
(the header line says what this machine is). What is not listed is not here.`;
  if (mountError === undefined)
    return `${footer}
The installed app's commands — status, jobs, runs, people, projects, sources,
knowledge, serve and the channels — mount onto this tree.`;
  return `${footer}
App commands unavailable: ${mountError}`;
}

export async function main(argv: string[]): Promise<void> {
  // The machine's facts, decided once per run from the environment and no
  // probe: a home here or none, and whether this process is itself driven
  // remotely. The header shows the home; providers receive both.
  const machine = machineStatus();
  if (await takeRemoteFlag(argv, machine)) return;

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

  const program = new Command('aivi')
    .version(version)
    .showHelpAfterError('(run `aivi --help` for a list of commands)')
    // Commander never exits the process itself: it throws CommanderError and
    // main maps it to an exit code below. The bin keeps one owner of the
    // exit, and main stays callable from tests without killing the runner.
    .exitOverride();

  // The registration order *is* the help listing's order; each group below
  // keeps its place. `add` and `update` act on the server machine and
  // therefore relay, so they are not in the client-side set.
  registerClientCommands(program, machine);
  if (machine.home !== undefined) registerHomeCommands(program);
  registerExitRamp(program, machine);
  if (machine.home !== undefined) registerServiceCommand(program);

  const mountError = await mountForRequest(program, command, machine);

  program.addHelpText(
    'before',
    `${brandBanner(
      [
        {
          text: `aivi v${version}${machine.remote === true ? ' (remote)' : ''} — the always-on teammate around OpenCode`,
        },
        { text: 'The server does the work; this CLI installs and controls it.', muted: true },
        { text: `home: ${machine.home ?? 'none'}`, muted: true },
      ],
      process.stdout,
      // The wordmark goes amber when this process answers a driven session:
      // the machine fact owns the marker, so `aivi -r --help` streams a page
      // that cannot be mistaken for the laptop's own. The `(remote)` word is
      // plain text — pipes and NO_COLOR terminals still read it.
      { remote: machine.remote === true },
    )}\n`,
  );
  program.addHelpText('after', helpFooter(machine.home, mountError));

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = commanderExit(error);
      return;
    }
    throw error;
  }
}

/** Commander has written its message already; showing help or the version is success. */
const commanderExit = (error: CommanderError): number =>
  error.code === 'commander.help' || error.code === 'commander.helpDisplayed' || error.code === 'commander.version'
    ? 0
    : error.exitCode;

// The bin runs itself; tests import main() without starting a parse.
if (import.meta.main)
  try {
    await main(process.argv.slice(2));
    if (process.exitCode === undefined) process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
