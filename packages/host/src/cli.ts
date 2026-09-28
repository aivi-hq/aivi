/** What the host *provides*: `registerCommands` hangs the operator commands
 *  on any commander tree it is handed — the `@aivi/cli` bin collects them into
 *  its own, the one bin on PATH and the one thing that parses argv. The host
 *  parses nothing: it boots through `@aivi/host/server`. The commands
 *  themselves live in cli/commands/, grouped by category; the shared plumbing
 *  in cli/context.ts. */
import { resolve } from 'node:path';

import { configureLogging, isTty } from '@aivi/core';
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

// Set once the preAction hook configured logging; the collector's exit path flushes sinks.
let closeLogging: () => Promise<void> = async () => {};

/** Hang the operator commands on a commander tree and keep their logging.
 *  The options are declared on the tree's root, but the hooks are hung on
 *  each command this register adds — never on the root — so the collecting
 *  tree's own machine commands (`setup`, `service`, …) are untouched by them.
 *  The hooks inherit down
 *  to subcommands; the root's option values are read from the root. */
export async function registerCommands(program: Command): Promise<void> {
  program
    .option('--log-level <level>', 'debug|info|warn|error', 'info')
    .option('--log-format <format>', 'auto|pretty|json (auto: pretty on a terminal, JSON lines when piped)', 'auto');
  const host = new Set(program.commands.map(command => command.name()));

  registerGettingStarted(program);
  registerServer(program);
  registerHost(program);
  registerPeople(program);
  registerProjects(program);
  registerKnowledge(program);
  registerJobs(program);
  // The plugin commands mount before parsing: their packages are asked for
  // their ./cli subpath, so `aivi --help` already shows what is installed.
  await registerChannels(program);

  // Logging is configured once, before any action: stderr mirrors the
  // run — pretty on a terminal, JSON lines when piped — and serve additionally
  // appends JSON lines to state/logs/aivi.log whatever the console does.
  // stdout stays reserved for output.
  const configure = async (_owner: Command, actionCommand: Command): Promise<void> => {
    const values = program.opts<{ logLevel?: string; logFormat?: string }>();
    const level = values.logLevel ?? 'info';
    const format = values.logFormat ?? 'auto';
    if (!['debug', 'info', 'warn', 'error'].includes(level))
      throw new Error(`Unknown log level: ${level}. Use debug, info, warn, or error.`);
    if (!['auto', 'pretty', 'json'].includes(format))
      throw new Error(`Unknown log format: ${format}. Use auto, pretty, or json.`);
    closeLogging = await configureLogging({
      level: level as 'debug' | 'info' | 'warn' | 'error',
      format: (format === 'auto' ? (isTty(process.stderr) ? 'pretty' : 'json') : format) as 'pretty' | 'json',
      ...(actionCommand.name() === 'serve' ? { logFile: resolve(home, 'state', 'logs', 'aivi.log') } : {}),
    });
  };
  for (const command of program.commands) {
    if (host.has(command.name())) continue;
    command.hook('preAction', configure);
    // The same close the direct bin's finally does, for the mounted case;
    // closeLogging is idempotent, so the bin flushing twice is silence.
    command.hook('postAction', () => closeLogging());
  }
}
