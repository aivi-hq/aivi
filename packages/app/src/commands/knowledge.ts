/** Knowledge: search over the running host and queued reindexing. */
import { randomUUID } from 'node:crypto';
import { selectSources } from '@aivi/core';
import { createHostClient } from '@aivi/host';
import type { Command } from 'commander';
import { collect, context, hostUrl, print, withStore } from '../context.ts';

export function registerKnowledge(program: Command): void {
  const knowledge = program.command('knowledge').description('search and indexing').helpGroup('Knowledge');
  program
    .command('sources')
    .description('List configured knowledge sources')
    .option('--project <id>', 'restrict to a project; repeatable', collect)
    .helpGroup('Knowledge')
    .action(async values => {
      const { loaded } = await context();
      print(selectSources(loaded, values.project));
    });
  knowledge
    .command('search <query>')
    .description('Search via the running host')
    .option('--project <id>', 'restrict to a project; repeatable', collect)
    .option('--core-only', 'search only the core sources')
    .option('--no-core', 'exclude the core sources')
    .option('--limit <n>', 'at most this many hits')
    .action(async (query, values) => {
      const { loaded } = await context();
      if (values.coreOnly && values.project?.length) throw new Error('Choose --core-only or --project');
      const client = createHostClient(hostUrl(loaded));
      print(
        await client.search({
          query,
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values.coreOnly ? { projects: [] } : values.project ? { projects: values.project } : {}),
          ...(values.core === false ? { includeCore: false } : {}),
        }),
      );
    });
  knowledge
    .command('index')
    .description('Queue a source refresh now')
    .option('--resource <pool>', 'the pool the index run takes', 'maintenance')
    .action(async values => {
      const { loaded, poke } = await context();
      if (!loaded.config.search) throw new Error('Knowledge search is not configured');
      if (!(values.resource in loaded.config.scheduler.resources))
        throw new Error('Configure a maintenance resource pool or pass --resource');
      await withStore(loaded, store =>
        print(store.enqueue({ kind: 'invocation', name: 'knowledge.index' }, values.resource, `index:${randomUUID()}`)),
      );
      await poke();
    });
}
