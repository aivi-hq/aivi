/** The server itself: foreground serve, queue status, configuration and
 *  OpenCode checks. */

import type { LoadedConfig, Logger } from '@aivi/core';
import { isTty } from '@aivi/core';
import type { HostModule, HostResources } from '@aivi/host';
import { connectOpenCode, runHost, status } from '@aivi/host';
import { createKnowledgeService } from '@aivi/knowledge';
import type { Command } from 'commander';
import { context, print, withStore } from '../context.ts';

export function registerServer(program: Command): void {
  program
    .command('serve')
    .description('Start the host: API, scheduler, knowledge, configured modules')
    .helpGroup('Server')
    .action(async () => {
      const { loaded, protectedEnv, log } = await context();
      // A modules block that is present and not false enables its module; the schema checked its
      // pool. The packages themselves load lazily, so an installation without a channel package
      // runs every other command untouched.
      const modules: HostModule[] = [];
      if (typeof loaded.config.modules.discord === 'object')
        modules.push((await import('@aivi/channel-discord')).createDiscordModule(loaded.config.modules.discord));
      if (typeof loaded.config.modules.slack === 'object')
        modules.push((await import('@aivi/channel-slack')).createSlackModule(loaded.config.modules.slack));
      if (loaded.config.linear) modules.push((await import('@aivi/linear')).createLinearModule(loaded.config.linear));
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await withStore(loaded, async store => {
        try {
          await runHost({
            loaded,
            store,
            modules,
            protectedEnv,
            log,
            signal: abort.signal,
            resources: () => createResources(loaded, log),
            onReady: address => {
              const ready = {
                listening: address,
                modules: modules.map(m => m.id),
                sources: loaded.sources.length,
              };
              // The record lands in the log stream and file whatever the console.
              log.info('host.listening', ready);
              // The raw JSON line is the machine-readable contract, for whoever
              // pipes stdout (scripts, smoke, supervisors). A human on a terminal
              // gets the pretty host.listening log record instead of a JSON blob.
              if (!isTty(process.stdout)) console.log(JSON.stringify(ready));
            },
          });
        } finally {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        }
      });
    });

  program
    .command('status')
    .description('Inspect durable queue counts')
    .helpGroup('Server')
    .action(async () => {
      const { loaded } = await context();
      await withStore(loaded, store => print(status(store, loaded)));
    });

  const config = program.command('config').description('configuration checks').helpGroup('Server');
  config
    .command('check')
    .description('Validate core and per-project configuration')
    .action(async () => {
      const { loaded } = await context();
      print({
        valid: true,
        projects: loaded.projects.map(project => ({ id: project.id, directory: project.directory })),
        sources: loaded.sources.length,
        host: loaded.config.host,
      });
    });

  const opencode = program.command('opencode').description('the OpenCode service the host uses').helpGroup('Server');
  opencode
    .command('check')
    .description('Probe the OpenCode v2 service the host would use')
    .action(async () => {
      const { loaded } = await context();
      const client = await connectOpenCode(loaded.config.opencode);
      print(await client.server.info({ signal: AbortSignal.timeout(10000) }));
    });
}
async function createResources(loaded: LoadedConfig, log: Logger): Promise<HostResources> {
  // Knowledge logs under its own category: the service is built here, before
  // any host exists, and keeps this logger whatever job triggers an index.
  const knowledge = await createKnowledgeService(loaded, undefined, log.getChild('knowledge'));
  // Browser construction is lazy; no Chrome launch occurs until a tool call.
  const browser =
    loaded.config.browser !== false ? (await importBrowser()).createBrowserService(loaded.config.browser) : undefined;
  return { knowledge, ...(browser ? { browser } : {}) };
}

/** `@aivi/browser` is a dependency of this package, so a miss here means a
 *  broken install, not a disabled feature; say so with the repair command
 *  instead of a bare ERR_MODULE_NOT_FOUND. */
async function importBrowser(): Promise<typeof import('@aivi/browser')> {
  try {
    return await import('@aivi/browser');
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      throw new Error(
        'The browser service (@aivi/browser) is missing from this installation. Repair it with `aivi update`.',
      );
    throw error;
  }
}
