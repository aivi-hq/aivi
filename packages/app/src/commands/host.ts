/** The host's own record: the diary of requests it has answered. */

import { parseDuration } from '@aivi/core';
import type { Command } from 'commander';
import { context, print, withStore } from '../context.ts';

export function registerHost(program: Command): void {
  const host = program
    .command('host')
    .description("the host's own record: the requests it has answered")
    .helpGroup('Server');
  host
    .command('clear-logs')
    .description('Forget request-diary rows older than a duration')
    .requiredOption('--older-than <duration>', 'drop diary rows older than this: 30m, 12h, 30d')
    .action(async values => {
      const { loaded } = await context();
      // The diary is read and retired straight from the store, the way every
      // other command reaches it; the running host notices nothing because a
      // forgotten row changes nothing it schedules.
      const olderThan = Date.now() - parseDuration(values.olderThan);
      await withStore(loaded, store => print({ removed: store.clearRequests(olderThan) }));
    });
}
