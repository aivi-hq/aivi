/** What the host *provides*: `registerCommands` hangs the operator commands
 *  on any commander tree it is handed — the `@aivi/cli` bin collects them into
 *  its own, the one bin on PATH and the one thing that parses argv. The host
 *  parses nothing: it boots through `@aivi/host/server`. The CLI's machine
 *  state comes in as an argument (the `registerCommands(program, ctx)` shape
 *  one-cli.md always meant), so providers decide membership from a stated
 *  fact, not from env archaeology. The commands themselves live in
 *  cli/commands/, grouped by category; the shared plumbing in cli/context.ts. */
import { resolve } from 'node:path';

import { configureLogging, isTty } from '@aivi/core';
import type { MachineStatus } from '@aivi/plugin';
import type { Command } from 'commander';
import { registerChannels } from './cli/commands/channels.ts';
import { registerGettingStarted } from './cli/commands/getting-started.ts';
import { registerHost } from './cli/commands/host.ts';
import { registerJobs } from './cli/commands/jobs.ts';
import { registerKnowledge } from './cli/commands/knowledge.ts';
import { registerPeople } from './cli/commands/people.ts';
import { registerProjects } from './cli/commands/projects.ts';
import { registerServer } from './cli/commands/server.ts';
import { home } from './cli/context.ts';

// Set once serve's preAction hook configured logging; the collector's exit path flushes sinks.
let closeLogging: () => Promise<void> = async () => {};

/** Hang the operator commands on a commander tree and keep their logging.
 *  The machine's state arrives as an argument: whoever provides commands
 *  decides from it what exists here, and the CLI stays in its lane as the
 *  scaffold. The logging options are declared on `serve` — the one command
 *  that logs — so the collecting tree's root stays flag-free and a provider
 *  never pollutes commands that are not its own. */
export async function registerCommands(program: Command, machine: MachineStatus): Promise<void> {
  registerGettingStarted(program);
  registerServer(program);
  registerHost(program);
  registerPeople(program);
  registerProjects(program);
  registerKnowledge(program);
  registerJobs(program);
  // The plugin commands mount before parsing: their packages are asked for
  // their ./cli subpath, so `aivi --help` already shows what is installed.
  // They see the same machine state: a plugin that cannot work without a
  // home registers nothing — membership is the provider's, decided by not
  // registering, never the collector's decided by hiding.
  await registerChannels(program, machine);

  // Logging belongs to serve, the command that actually logs: stderr mirrors
  // the run — pretty on a terminal, JSON lines when piped — and serve
  // additionally appends JSON lines to state/logs/aivi.log whatever the
  // console does. stdout stays reserved for output. The rest of the CLI
  // answers through clack and print and needs no logger of its own.
  const serve = program.commands.find(command => command.name() === 'serve');
  if (!serve) return;
  serve
    .option('--log-level <level>', 'debug|info|warn|error', 'info')
    .option('--log-format <format>', 'auto|pretty|json (auto: pretty on a terminal, JSON lines when piped)', 'auto')
    .hook('preAction', async (_owner: Command, actionCommand: Command) => {
      const values = actionCommand.opts<{ logLevel?: string; logFormat?: string }>();
      const level = values.logLevel ?? 'info';
      const format = values.logFormat ?? 'auto';
      if (!['debug', 'info', 'warn', 'error'].includes(level))
        throw new Error(`Unknown log level: ${level}. Use debug, info, warn, or error.`);
      if (!['auto', 'pretty', 'json'].includes(format))
        throw new Error(`Unknown log format: ${format}. Use auto, pretty, json.`);
      closeLogging = await configureLogging({
        level: level as 'debug' | 'info' | 'warn' | 'error',
        format: (format === 'auto' ? (isTty(process.stderr) ? 'pretty' : 'json') : format) as 'pretty' | 'json',
        logFile: resolve(home, 'state', 'logs', 'aivi.log'),
      });
    })
    // The same close the direct bin's finally does, for the mounted case;
    // closeLogging is idempotent, so flushing twice is silence.
    .hook('postAction', () => closeLogging());
}
