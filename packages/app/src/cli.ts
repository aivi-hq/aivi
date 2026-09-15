#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type { LoadedConfig, Logger, LogLevel } from '@aivi/core';
import { createLogger, errorMessage, loadConfig, parseDue, reportSchema, selectSources, taskSchema } from '@aivi/core';
import type { HostModule, HostResources } from '@aivi/host';
import { connectOpenCode, createHostClient, resolveHostAuth, runHost, Store, status } from '@aivi/host';
import { createKnowledgeService } from '@aivi/knowledge';
import { z } from 'zod';

const usage = `aivi <command>

  serve                        Start the host: API, scheduler, knowledge, configured modules
  tick                         Materialize schedules and dispatch due jobs once, then exit
  status                       Inspect durable queue counts
  config check                 Validate core and per-project configuration
  sources [--project ID]       List configured knowledge sources
  knowledge search QUERY       Search via the running host [--project ID --core-only --no-core --limit N]
  knowledge index              Queue a source refresh [--resource maintenance]
  jobs list                    List jobs (operator output, including prompts)
  jobs show ID                 Inspect one job and its audit history
  jobs enqueue FILE            Enqueue a task file: a task, or {task, report?, resource?}
                               [--key ID --resource POOL --at ISO|30m|2h|1d]
  jobs cancel ID               Cancel a queued job only
  jobs abort ID                Ask the scheduler to stop a running job; it ends blocked for resolve
  jobs resolve ID              Release a blocked job after inspection/repair
                               --outcome succeeded|failed --reason TEXT --confirm-stopped
  schedules sync               Reconcile configured schedules
  schedules list               Configured and agent-created schedules with their next occurrence
  schedules pause|resume ID    Pause or resume an agent-created schedule
  schedules remove ID          Remove an agent-created schedule
  schedules run ID             Enqueue one occurrence of a schedule now
  discord register             Register slash commands for the configured application
  discord status               Inspect Discord turns and leases
  discord resolve ID           Release a blocked turn --reason TEXT --confirm-stopped
  opencode check               Probe the OpenCode v2 service the host would use

Home: ~/.aivi (override with AIVI_HOME) holds aivi.json, .env, and state/;
an aivi.local.json there takes precedence over aivi.json.
Options: --log-level debug|info|warn|error
Secrets come from the environment: AIVI_TOKEN (host.auth.mode "token"),
DISCORD_BOT_TOKEN, OPENCODE_USERNAME/OPENCODE_PASSWORD (only with opencode.url).
<home>/.env is loaded without overriding existing variables; fnox exec works too.
No secrets in config files.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      limit: { type: 'string' },
      'core-only': { type: 'boolean' },
      'no-core': { type: 'boolean' },
      project: { type: 'string', multiple: true },
      key: { type: 'string' },
      at: { type: 'string' },
      resource: { type: 'string' },
      outcome: { type: 'string' },
      reason: { type: 'string' },
      'confirm-stopped': { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) {
    console.log(usage);
    return;
  }
  const log = createLogger({ level: (values['log-level'] as LogLevel | undefined) ?? 'info' });
  // One home holds everything: aivi.json, .env, state/. Paths in the config resolve against it.
  // A git-ignored aivi.local.json wins, so a checked-in example home can carry a private setup.
  const home = resolve(process.env.AIVI_HOME ?? resolve(homedir(), '.aivi'));
  const configPath = ['aivi.local.json', 'aivi.json'].map(name => resolve(home, name)).find(path => existsSync(path));
  if (!configPath)
    throw new Error(`No aivi.json in ${home}. Create one, or point AIVI_HOME at a directory that has one.`);
  const protectedEnv = loadEnvFile(resolve(home, '.env'), log);
  const loaded = await loadConfig(configPath);
  const [command = '', subcommand, argument] = positionals;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  // The CLI writes to SQLite directly; a running host learns about it now instead of at its safety-net tick.
  const poke = async () => {
    await createHostClient(hostUrl(loaded), { token: process.env.AIVI_TOKEN })
      .wake()
      .catch(() => {});
  };

  const discord = loaded.config.modules.discord ? await import('@aivi/discord') : undefined;
  const discordConfig = discord ? await discord.loadDiscordConfig(loaded.config.modules.discord!.config) : undefined;
  if (discordConfig && !(discordConfig.resource in loaded.config.scheduler.resources))
    throw new Error('Unknown Discord resource pool');

  // Commands that need no database.
  switch (`${command} ${subcommand ?? ''}`.trim()) {
    case 'config check':
      print({
        valid: true,
        projects: loaded.projects.length,
        sources: loaded.sources.length,
        host: loaded.config.host,
      });
      return;
    case 'sources':
      print(selectSources(loaded, values.project));
      return;
    case 'opencode check': {
      const client = await connectOpenCode(loaded.config.opencode);
      print(await client.health.get({ signal: AbortSignal.timeout(10000) }));
      return;
    }
    case 'knowledge search': {
      if (!argument) throw new Error('Provide a search query');
      if (values['core-only'] && values.project?.length) throw new Error('Choose --core-only or --project');
      const client = createHostClient(hostUrl(loaded), { token: process.env.AIVI_TOKEN });
      print(
        await client.search({
          query: argument,
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values['core-only'] ? { projects: [] } : values.project ? { projects: values.project } : {}),
          ...(values['no-core'] ? { includeCore: false } : {}),
        }),
      );
      return;
    }
  }

  const store = new Store(resolve(loaded.config.stateDirectory, 'aivi.sqlite'));
  try {
    if (command === 'discord') {
      if (!discord || !discordConfig) throw new Error('Discord module is not configured in aivi.json');
      if (subcommand === 'register') {
        await discord.registerDiscordCommands(discordConfig);
        print({ registered: true });
        return;
      }
      const inbox = new discord.DiscordStore(store, discord.bindingFor(discordConfig));
      if (subcommand === 'status') {
        print({ turns: inbox.list(), leases: store.leases() });
        return;
      }
      if (subcommand === 'resolve') {
        if (!argument || !values.reason || !values['confirm-stopped'])
          throw new Error('discord resolve ID --reason TEXT --confirm-stopped');
        inbox.resolve(argument, values.reason);
        print({ resolved: true });
        return;
      }
      throw new Error('Discord runs inside `aivi serve`; commands: register, status, resolve');
    }
    if (command === 'status') {
      print(status(store, loaded));
      return;
    }
    if (command === 'schedules') {
      switch (subcommand) {
        case 'sync':
          store.syncSchedules(loaded.config.schedules);
          print({ schedules: loaded.config.schedules.length });
          await poke();
          return;
        case 'list':
          print(
            store.schedules().map(s => ({
              id: s.spec.id,
              source: s.source,
              enabled: s.enabled,
              cron: s.spec.cron,
              timezone: s.spec.timezone,
              nextAt: new Date(s.nextAt).toISOString(),
              kind: s.spec.task.kind,
              lastRun: store.lastRun(s.spec.id)?.state ?? null,
            })),
          );
          return;
        case 'pause':
        case 'resume':
          if (!argument) break;
          print(store.setScheduleEnabled(argument, subcommand === 'resume'));
          await poke();
          return;
        case 'remove':
          if (!argument) break;
          store.removeSchedule(argument);
          print({ removed: argument });
          return;
        case 'run':
          if (!argument) break;
          print(store.runSchedule(argument));
          await poke();
          return;
      }
    }
    if (command === 'knowledge' && subcommand === 'index') {
      if (!loaded.config.search) throw new Error('Knowledge search is not configured');
      const resource = values.resource ?? 'maintenance';
      if (!(resource in loaded.config.scheduler.resources))
        throw new Error('Configure a maintenance resource pool or pass --resource');
      print(store.enqueue({ kind: 'knowledge.index' }, resource, `index:${randomUUID()}`));
      await poke();
      return;
    }
    if (command === 'jobs') {
      switch (subcommand) {
        case 'list':
          print(store.list());
          return;
        case 'show':
          if (argument) {
            print({ job: store.get(argument), history: store.history(argument) });
            return;
          }
          break;
        case 'enqueue': {
          if (!argument) break;
          // A task file is either a bare task or { task, report?, resource? }.
          const raw: unknown = JSON.parse(await readFile(resolve(argument), 'utf8'));
          const wrapped = jobFileSchema.safeParse(raw);
          const {
            task,
            report,
            resource: fileResource,
          } = wrapped.success ? wrapped.data : { task: taskSchema.parse(raw), report: undefined, resource: undefined };
          // Paths in task files resolve against the home, like paths in aivi.json.
          if (task.kind === 'opencode.prompt' || task.kind === 'dreaming')
            task.directory = resolve(home, task.directory);
          if (task.kind === 'dreaming') task.memoryDirectory = resolve(home, task.memoryDirectory);
          if (task.kind === 'shell' && task.cwd) task.cwd = resolve(home, task.cwd);
          const resource = values.resource ?? fileResource ?? 'local-model';
          if (!(resource in loaded.config.scheduler.resources)) throw new Error(`Unknown resource pool: ${resource}`);
          const now = Date.now();
          print(
            store.enqueue(task, resource, `manual:${values.key ?? randomUUID()}`, now, report ?? null, {
              ...(values.at ? { due: parseDue(values.at, now) } : {}),
            }),
          );
          await poke();
          return;
        }
        case 'cancel':
          if (argument) {
            store.cancelQueued(argument);
            print(store.get(argument));
            return;
          }
          break;
        case 'abort':
          if (argument) {
            store.requestCancel(argument);
            print(store.get(argument));
            await poke();
            return;
          }
          break;
        case 'resolve': {
          if (!argument) break;
          if (!values['confirm-stopped'] || !values.reason || !['succeeded', 'failed'].includes(values.outcome ?? '')) {
            throw new Error('Resolution requires --confirm-stopped, --outcome succeeded|failed and --reason');
          }
          store.resolveBlocked(argument, values.outcome as 'succeeded' | 'failed', values.reason);
          print(store.get(argument));
          return;
        }
      }
    }
    if (command === 'tick' || command === 'serve') {
      const once = command === 'tick';
      // Fail on a missing token before touching the daemon lock, QMD, or Chrome.
      const auth = once
        ? { mode: 'none' as const }
        : resolveHostAuth(loaded.config.host.auth.mode, process.env.AIVI_TOKEN);
      const modules: HostModule[] = [];
      if (!once && discord && discordConfig) modules.push(discord.createDiscordModule(discordConfig));
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await runHost({
          loaded,
          store,
          modules,
          auth,
          protectedEnv,
          log,
          once,
          signal: abort.signal,
          resources: () => createResources(loaded, once, log),
          onReady: address =>
            console.log(
              JSON.stringify({ listening: address, modules: modules.map(m => m.id), sources: loaded.sources.length }),
            ),
        });
        if (once) print(status(store, loaded));
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      return;
    }
    throw new Error(`Unknown command.\n${usage}`);
  } finally {
    store.close();
  }
}

/**
 * dotenv-style file; existing environment always wins, so `fnox exec` and CI overrides behave.
 * Returns the variable names the file defines: everything in it is treated as a secret.
 */
function loadEnvFile(path: string, log: { debug(event: string, fields?: Record<string, unknown>): void }): string[] {
  if (!existsSync(path)) return [];
  process.loadEnvFile(path);
  log.debug('env.loaded', { path });
  return Object.keys(parseEnv(readFileSync(path, 'utf8')));
}

const jobFileSchema = z.strictObject({
  task: taskSchema,
  report: reportSchema.optional(),
  resource: z.string().min(1).optional(),
});

async function createResources(loaded: LoadedConfig, once: boolean, log: Logger): Promise<HostResources> {
  const knowledge = await createKnowledgeService(loaded, undefined, log);
  // Browser construction is lazy; no Chrome launch occurs until a tool call. A one-shot tick never needs it.
  const browser =
    !once && loaded.config.browser !== false
      ? (await import('@aivi/browser')).createBrowserService(loaded.config.browser)
      : undefined;
  return { knowledge, ...(browser ? { browser } : {}) };
}

function hostUrl(loaded: LoadedConfig): string {
  const { bind, port } = loaded.config.host;
  const host = ['0.0.0.0', '::', '[::]'].includes(bind) ? '127.0.0.1' : bind;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

main().catch(error => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
