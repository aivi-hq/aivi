/** The server itself: foreground serve, queue status, configuration and
 *  OpenCode checks. */

import { connectOpenCode, status } from '@aivi/host';
import type { Command } from 'commander';
import { startServer } from '../../server.ts';
import { context, print, withStore } from '../context.ts';

export function registerServer(program: Command): void {
  program
    .command('serve')
    .description('Start the host: API, scheduler, knowledge, listed plugins')
    .helpGroup('Server')
    .action(async () => {
      // The boot itself is the host's own (`@aivi/host/server`), called
      // in-process: this command adds a place in the tree and the logging
      // hook, nothing else. launchd runs that boot file directly.
      await startServer();
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
