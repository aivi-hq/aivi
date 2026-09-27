#!/usr/bin/env node
/** The host's command surface (`@aivi/host/cli`): `registerCommands` hangs the
 *  operator commands on any commander tree — its own, or the thin `@aivi/cli`'s
 *  when that mounts it in-process — and `main` is the direct entry launchd and
 *  the dev script run. The commands themselves live in cli/commands/, grouped
 *  by category; the shared plumbing in cli/context.ts. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureLogging, isTty } from '@aivi/core';
import { Command, CommanderError } from 'commander';
import { registerChannels } from './cli/commands/channels.ts';
import { registerGettingStarted } from './cli/commands/getting-started.ts';
import { registerHost } from './cli/commands/host.ts';
import { registerJobs } from './cli/commands/jobs.ts';
import { registerKnowledge } from './cli/commands/knowledge.ts';
import { registerPeople } from './cli/commands/people.ts';
import { registerProjects } from './cli/commands/projects.ts';
import { registerServer } from './cli/commands/server.ts';
import { home } from './cli/context.ts';
import { rootBanner } from './cli/help.ts';

// Set once the preAction hook configured logging; the finally below flushes sinks on every exit path.
let closeLogging: () => Promise<void> = async () => {};

const version = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
).version;

/** Hang the operator commands on a commander tree and keep their logging.
 *  The options are declared on the tree's root, but the hooks are hung on
 *  each command this register adds — never on the root — so a host tree (the
 *  thin CLI's machine commands) is untouched by them. The hooks inherit down
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

async function main(argv: string[]): Promise<void> {
  const program = new Command('aivi').version(version).showHelpAfterError('(run `aivi --help` for a list of commands)');

  await registerCommands(program);

  program.addHelpText('before', rootBanner(version, home, process.stdout));
  program.addHelpText(
    'after',
    `
Home: ~/.aivi (override with AIVI_HOME) holds config.json, .env, and state/.
The live config.json is yours and aivi's to edit; it stays out of version control.
Secrets come from the environment: DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN,
OPENCODE_USERNAME/OPENCODE_PASSWORD (only with opencode.url).
<home>/.env is loaded without overriding existing variables; fnox exec works too.
No secrets in config files.`,
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

// The bin runs itself; the thin CLI's mount imports this module for
// registerCommands alone, and must not start a second parse.
if (import.meta.main)
  main(process.argv.slice(2))
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeLogging());
