/** The server itself: foreground serve, queue status, configuration and
 *  OpenCode checks. */

import type { LoadedConfig, Logger } from '@aivi/core';
import { isTty } from '@aivi/core';
import type { AiviModule, HostResources } from '@aivi/host';
import { connectOpenCode, runHost, status } from '@aivi/host';
import { createKnowledgeService } from '@aivi/knowledge';
import type { Command } from 'commander';
import { context, home, print, withStore } from '../context.ts';
import { buildModules } from '../registry.ts';

export function registerServer(program: Command): void {
  program
    .command('serve')
    .description('Start the host: API, scheduler, knowledge, listed plugins')
    .helpGroup('Server')
    .action(async () => {
      const { loaded, registry, protectedEnv, log } = await context();
      // The `aivi-plugins` list in app/package.json says which modules run; the
      // config block is configuration only. Packages were read at context load
      // (their ./config declarations); the module code itself loads here.
      const modules: AiviModule[] = await buildModules(registry, loaded, home);
      const abort = new AbortController();
      // Stop means stop, and the operator sees it: the drains after this can
      // take seconds (idle keep-alive sockets expire on their own), so silence
      // here reads as a hung terminal. Measured on the dev home 2026-09-28:
      // the first Ctrl+C looked stuck for ~5 s.
      const stop = () => {
        log.info('host.stopping', {
          hint: 'shutting down gracefully — modules stop, in-flight work drains; a second Ctrl+C ends now',
        });
        abort.abort();
      };
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
  return { knowledge };
}
