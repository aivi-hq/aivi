/** The server itself: foreground serve, queue status, configuration and
 *  OpenCode checks. */

import { connectOpenCode, status } from '@aivi/host';
import type { MachineStatus } from '@aivi/plugin';
import type { Command } from 'commander';
import { startServer } from '../../server.ts';
import { context, hostUrl, print, withStore } from '../context.ts';

export function registerServer(program: Command, machine: MachineStatus): void {
  program
    .command('serve')
    .description('Start the host: API, scheduler, knowledge, listed plugins')
    .helpGroup('Server')
    .action(async () => {
      // Refuse-relay (the plan's sets): over an exec session, the server is
      // the thing being driven — a second serve would fight the session
      // itself. The provider answers the guard from the machine fact, never
      // `unknown command`, whatever the help showed. launchd boots
      // `dist/server.js` directly and never passes through this tree.
      if (machine.remote === true)
        throw new Error('the server is the thing being driven; serve is not a command over the channel');
      // The plan's other serve answer: while a host already answers on the
      // configured endpoint, the wanted state exists. Say whose it is and
      // exit; never boot a second host beside it. One probe at invocation —
      // not a help-time check, not a poll.
      const { loaded } = await context();
      const url = hostUrl(loaded);
      const answered = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
        .then(response => response.ok)
        .catch(() => false);
      if (answered) {
        print({ alreadyRunning: true, url }, `server already running at ${url}`);
        return;
      }
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
