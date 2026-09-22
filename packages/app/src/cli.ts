#!/usr/bin/env node
/** The aivi server CLI's entry: commander's tree, the logging preAction hook,
 *  the themed help, and the register calls that hang the commands on it. The
 *  commands themselves live in commands/, grouped by category; the shared
 *  plumbing in context.ts. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureLogging, isTty } from '@aivi/core';
import { Command, CommanderError } from 'commander';
import { registerChannels } from './commands/channels.ts';
import { registerGettingStarted } from './commands/getting-started.ts';
import { registerJobs } from './commands/jobs.ts';
import { registerKnowledge } from './commands/knowledge.ts';
import { registerPeople } from './commands/people.ts';
import { registerProjects } from './commands/projects.ts';
import { registerServer } from './commands/server.ts';
import { home } from './context.ts';
import { applyThemedHelp, rootBanner } from './help.ts';

// Set once the preAction hook configured logging; the finally below flushes sinks on every exit path.
let closeLogging: () => Promise<void> = async () => {};

const version = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
).version;

async function main(argv: string[]): Promise<void> {
  const program = new Command('aivi')
    .version(version)
    .showHelpAfterError('(run `aivi --help` for a list of commands)')
    .option('--log-level <level>', 'debug|info|warn|error', 'info')
    .option('--log-format <format>', 'auto|pretty|json (auto: pretty on a terminal, JSON lines when piped)', 'auto');

  // Logging is configured once, before any action, for the whole process: stderr mirrors the
  // run — pretty on a terminal, JSON lines when piped — and serve additionally appends JSON
  // lines to state/logs/aivi.log whatever the console does. stdout stays reserved for output.
  program.hook('preAction', async thisCommand => {
    const values = thisCommand.opts<{ logLevel?: string; logFormat?: string }>();
    const level = values.logLevel ?? 'info';
    const format = values.logFormat ?? 'auto';
    if (!['debug', 'info', 'warn', 'error'].includes(level))
      throw new Error(`Unknown log level: ${level}. Use debug, info, warn, or error.`);
    if (!['auto', 'pretty', 'json'].includes(format))
      throw new Error(`Unknown log format: ${format}. Use auto, pretty, or json.`);
    closeLogging = await configureLogging({
      level: level as 'debug' | 'info' | 'warn' | 'error',
      format: (format === 'auto' ? (isTty(process.stderr) ? 'pretty' : 'json') : format) as 'pretty' | 'json',
      ...(thisCommand.name() === 'serve' ? { logFile: resolve(home, 'state', 'logs', 'aivi.log') } : {}),
    });
  });

  registerGettingStarted(program);
  registerServer(program);
  registerPeople(program);
  registerProjects(program);
  registerKnowledge(program);
  registerJobs(program);
  // The plugin commands mount before parsing: their packages are asked for
  // their ./cli subpath, so `aivi --help` already shows what is installed.
  await registerChannels(program);

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
  applyThemedHelp(program);

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

main(process.argv.slice(2))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeLogging());
