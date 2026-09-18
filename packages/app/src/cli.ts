#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, parseEnv } from 'node:util';
import type { LinearConfig, LoadedConfig, Logger, LogLevel, RunState } from '@aivi/core';
import {
  addProject,
  createLogger,
  errorMessage,
  jobSchema,
  loadConfig,
  parseDue,
  projectIdFromUrl,
  projectSummaries,
  purgeProject,
  removeProject,
  reportSchema,
  selectSources,
  taskSchema,
  writeProjectLinear,
} from '@aivi/core';
import type { HostModule, HostResources } from '@aivi/host';
import { connectOpenCode, createHostClient, resolveHostAuth, runHost, Store, status } from '@aivi/host';
import { createKnowledgeService } from '@aivi/knowledge';
import type { LinearClient } from '@aivi/linear';
import { z } from 'zod';

const usage = `aivi <command>

  serve                        Start the host: API, scheduler, knowledge, configured modules
  tick                         Materialize due jobs and dispatch their runs once, then exit
  status                       Inspect durable queue counts
  config check                 Validate core and per-project configuration
  sources [--project ID]       List configured knowledge sources
  projects list                Projects: the directories of <home>/projects, with their sources; removed ones keep their memory
  projects add URL [--id ID]   git clone into <home>/projects/<id>/source; that is the whole registration
                               [--linear KEY_OR_ID[,…] [--app ID]] also writes projects.<id>.linear.teams,
                               resolving Linear team keys (PEC) to their ids before anything is cloned
  projects create [URL]        the one interactive command: asks URL, id, app and teams, then does
                               projects add; every flag given skips its prompt
  projects remove ID           Delete the checkout; memory stays and the project is listed as removed
  projects purge ID --confirm  Delete the project's memory (and checkout); without --confirm only shows what would go
  knowledge search QUERY       Search via the running host [--project ID --core-only --no-core --limit N]
  knowledge index              Queue a source refresh now [--resource maintenance]
  jobs list                    Job definitions: configured, system, agent- and operator-created
  jobs show ID                 One job with its runs
  jobs add FILE                Add a job from a task file: a task, or {task, report?, resource?}
                               [--at ISO|30m|2h|1d | --cron EXPR --timezone TZ] [--title T --resource POOL --key ID]
                               Without --at or --cron it runs once, now
  jobs pause|resume ID         Pause or resume an agent- or operator-created job
  jobs remove ID               Remove an agent- or operator-created job
  jobs run ID                  Queue one run of a job now
  runs list                    Runs (operator output, including prompts) [--job ID --state S --limit N]
  runs show ID                 One run with its audit history
  runs cancel ID               Cancel a queued run only
  runs abort ID                Ask the scheduler to stop a running run; it ends blocked for resolve
  runs resolve ID              Release a blocked run after inspection/repair
                               --outcome succeeded|failed --reason TEXT --confirm-stopped
  discord register             Register slash commands for the configured application
  discord status               Inspect Discord turns and leases
  discord resolve ID           Release a blocked turn --reason TEXT --confirm-stopped
  slack status                 Inspect Slack turns and leases
  slack resolve ID             Release a blocked turn --reason TEXT --confirm-stopped
  linear status                Inspect Linear worker turns and leases
  linear resolve ID            Release a blocked worker --reason TEXT --confirm-stopped
  opencode check               Probe the OpenCode v2 service the host would use

Home: ~/.aivi (override with AIVI_HOME) holds aivi.json, .env, and state/.
The live aivi.json is yours and aivi's to edit; it stays out of version control.
Options: --log-level debug|info|warn|error
Secrets come from the environment: AIVI_TOKEN (host.auth.mode "token"),
DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN, OPENCODE_USERNAME/OPENCODE_PASSWORD
(only with opencode.url).
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
      id: { type: 'string' },
      linear: { type: 'string' },
      app: { type: 'string' },
      key: { type: 'string' },
      at: { type: 'string' },
      cron: { type: 'string' },
      timezone: { type: 'string' },
      title: { type: 'string' },
      job: { type: 'string' },
      state: { type: 'string' },
      resource: { type: 'string' },
      outcome: { type: 'string' },
      reason: { type: 'string' },
      'confirm-stopped': { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) {
    console.log(usage);
    return;
  }
  const log = createLogger({ level: (values['log-level'] as LogLevel | undefined) ?? 'info' });
  // One home holds everything: aivi.json, .env, state/. Paths in the config resolve against it.
  const home = resolve(process.env.AIVI_HOME ?? resolve(homedir(), '.aivi'));
  const configPath = resolve(home, 'aivi.json');
  if (!existsSync(configPath))
    throw new Error(`No aivi.json in ${home}. Create one, or point AIVI_HOME at a directory that has one.`);
  const protectedEnv = loadEnvFile(resolve(home, '.env'), log);
  const loaded = await loadConfig(configPath);
  const [command = '', subcommand, argument] = positionals;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  // The CLI writes to SQLite directly; the running host learns about it through this poke and nothing
  // else, so a poke that cannot be delivered is said out loud rather than swallowed.
  const poke = async () => {
    await createHostClient(hostUrl(loaded), { token: process.env.AIVI_TOKEN })
      .wake()
      .catch(error =>
        console.error(
          `Note: could not wake the host (${errorMessage(error)}). Saved; it takes effect when the host next dispatches (a due job, or \`aivi serve\` starting).`,
        ),
      );
  };

  // The one interactive command: everything `projects add --linear` takes as a
  // flag is asked here, and a flag that is given skips its prompt. The core
  // calls — resolve teams, clone, write the config — are the same ones.
  const projectsCreate = async (): Promise<void> => {
    if (!linear || !loaded.config.linear) {
      throw new Error(
        'The Linear module is not configured in aivi.json (no `linear` block), so there is nothing to set up',
      );
    }
    const linearConfig = loaded.config.linear;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const url = (argument ?? (await rl.question('Repository URL? '))).trim();
      if (!url) throw new Error('Provide a git URL');
      const suggested = projectIdFromUrl(url);
      const id = (values.id ?? (await rl.question(`Project id? [${suggested}] `))).trim() || suggested;
      const appIds = Object.keys(linearConfig.apps);
      let app = values.app;
      if (!app && appIds.length > 1) {
        appIds.forEach((name, i) => {
          console.log(`  ${i + 1}) ${name}`);
        });
        const answer = (await rl.question('Ask which Linear app for teams? ')).trim();
        app = appIds[Number(answer) - 1] ?? answer;
      }
      const client = await linearClientFor(linear, linearConfig, app, log);
      const teams = await client.listTeams();
      if (!teams.length) {
        throw new Error(
          'That app sees no teams: a private team needs the app added to it before aivi can work on its issues',
        );
      }
      console.log(`Teams ${id} may work:`);
      teams.forEach((team, i) => {
        console.log(`  ${i + 1}) ${team.key} — ${team.name}  (${team.id})`);
      });
      const picked = (values.linear ?? (await rl.question(`Pick the teams for ${id} (space-separated)? `))).trim();
      const tokens = picked.split(/[\s,]+/).filter(Boolean);
      if (!tokens.length) throw new Error('Pick at least one team');
      // A number selects from the list; anything else resolves as a team id or key.
      const teamIds = linear.resolveTeams(
        teams,
        tokens.map(token => (/^\d+$/.test(token) ? (teams[Number(token) - 1]?.id ?? token) : token)),
      );
      const added = await addProject(configPath, url, { id });
      const written = await writeProjectLinear(configPath, id, teamIds);
      print({ ...added, linear: written });
      console.error(
        `Next: restart \`aivi serve\` to index it; projects.${id}.linear.lanes maps lane → app for the listener; the HITL label \`${linearConfig.humanLabel}\` must exist in each mapped team.`,
      );
    } finally {
      rl.close();
    }
  };

  // A modules block that is present and not false enables its module; the schema checked its pool.
  const discordConfig = typeof loaded.config.modules.discord === 'object' ? loaded.config.modules.discord : undefined;
  const discord = discordConfig ? await import('@aivi/channel-discord') : undefined;
  const slackConfig = typeof loaded.config.modules.slack === 'object' ? loaded.config.modules.slack : undefined;
  const slack = slackConfig ? await import('@aivi/channel-slack') : undefined;
  const linear = loaded.config.linear ? await import('@aivi/linear') : undefined;

  // Commands that need no database.
  switch (`${command} ${subcommand ?? ''}`.trim()) {
    case 'config check':
      print({
        valid: true,
        projects: loaded.projects.map(p => ({ id: p.id, directory: p.directory })),
        sources: loaded.sources.length,
        host: loaded.config.host,
      });
      return;
    case 'sources':
      print(selectSources(loaded, values.project));
      return;
    case 'projects list':
      print(
        projectSummaries(loaded).map((p, i) => ({
          ...p,
          ...(p.removed ? {} : { directory: loaded.projects[i]!.directory }),
        })),
      );
      return;
    case 'projects add': {
      if (!argument) throw new Error('Provide a git URL');
      const tokens = values.linear
        ? values.linear
            .split(',')
            .map(token => token.trim())
            .filter(Boolean)
        : [];
      if (values.linear && !tokens.length) throw new Error('--linear wants at least one team key or id');
      // Resolve the teams before cloning: a wrong key must not leave a half-added project.
      let teamIds: string[] = [];
      if (tokens.length) {
        if (!linear || !loaded.config.linear) {
          throw new Error(
            'The Linear module is not configured in aivi.json (no `linear` block), so there is no app to ask for teams',
          );
        }
        const client = await linearClientFor(linear, loaded.config.linear, values.app, log);
        teamIds = linear.resolveTeams(await client.listTeams(), tokens);
      }
      const added = await addProject(configPath, argument, values.id ? { id: values.id } : {});
      if (teamIds.length) {
        const written = await writeProjectLinear(configPath, added.id, teamIds);
        print({ ...added, linear: written });
        console.error(
          written.lanes
            ? 'Teams written; the lanes stay as configured.'
            : `Teams written. Until projects.${added.id}.linear.lanes maps lane → app the listener delegates nothing; hand delegation works.`,
        );
      } else print(added);
      console.error('Restart `aivi serve` to index it; the host reads the projects directory at startup.');
      return;
    }
    case 'projects create':
      await projectsCreate();
      return;
    case 'projects remove':
      if (!argument) throw new Error('Provide a project id');
      print(await removeProject(configPath, argument));
      console.error('Memory kept; the project is listed as removed until `aivi projects purge`. Restart `aivi serve`.');
      return;
    case 'projects purge': {
      if (!argument) throw new Error('Provide a project id');
      const purge = await purgeProject(configPath, argument, { confirm: values.confirm ?? false });
      print(purge);
      if (!purge.purged) {
        console.error('Nothing deleted. Re-run with --confirm to delete these paths; memory cannot be recovered.');
        process.exitCode = 1;
      } else console.error('Restart `aivi serve` so the index forgets it.');
      return;
    }
    case 'opencode check': {
      const client = await connectOpenCode(loaded.config.opencode);
      print(await client.server.status({ signal: AbortSignal.timeout(10000) }));
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
      if (!discord || !discordConfig) throw new Error('Discord is not enabled in aivi.json (no modules.discord block)');
      if (subcommand === 'register') {
        await discord.registerDiscordCommands(discordConfig);
        print({ registered: true });
        return;
      }
      const inbox = discord.openDiscordStore(store, discordConfig);
      if (subcommand === 'status') {
        print({ turns: inbox.list(), leases: store.leases() });
        return;
      }
      if (subcommand === 'resolve') {
        if (!argument || !values.reason || !values['confirm-stopped'])
          throw new Error('discord resolve ID --reason TEXT --confirm-stopped');
        inbox.resolve(argument, values.reason);
        print({ resolved: true });
        await poke();
        return;
      }
      throw new Error('Discord runs inside `aivi serve`; commands: register, status, resolve');
    }
    if (command === 'slack') {
      if (!slack || !slackConfig) throw new Error('Slack is not enabled in aivi.json (no modules.slack block)');
      const inbox = slack.openSlackStore(store, slackConfig);
      if (subcommand === 'status') {
        print({ turns: inbox.list(), leases: store.leases() });
        return;
      }
      if (subcommand === 'resolve') {
        if (!argument || !values.reason || !values['confirm-stopped'])
          throw new Error('slack resolve ID --reason TEXT --confirm-stopped');
        inbox.resolve(argument, values.reason);
        print({ resolved: true });
        await poke();
        return;
      }
      throw new Error(
        'Slack runs inside `aivi serve`; slash commands come from the app manifest; commands: status, resolve',
      );
    }
    if (command === 'linear') {
      if (!linear || !loaded.config.linear) throw new Error('Linear is not configured in aivi.json');
      const inbox = linear.openLinearStore(store);
      if (subcommand === 'status') {
        print({ workers: linear.describeWorkers(inbox), leases: store.leases() });
        return;
      }
      if (subcommand === 'resolve') {
        if (!argument || !values.reason || !values['confirm-stopped'])
          throw new Error('linear resolve ID --reason TEXT --confirm-stopped');
        inbox.resolve(argument, values.reason);
        print({ resolved: true });
        await poke();
        return;
      }
      throw new Error('Linear runs inside `aivi serve`; commands: status, resolve');
    }
    if (command === 'status') {
      print(status(store, loaded));
      return;
    }
    if (command === 'jobs') {
      switch (subcommand) {
        case 'list':
          print(
            store.jobs().map(j => ({
              id: j.spec.id,
              title: j.spec.title ?? null,
              source: j.source,
              state: j.state,
              when: j.spec.at !== undefined ? `at ${j.spec.at}` : `cron ${j.spec.cron} (${j.spec.timezone})`,
              nextAt: j.nextAt === null ? null : new Date(j.nextAt).toISOString(),
              kind: j.spec.task.kind,
              resource: j.spec.resource,
              lastRun: store.lastRun(j.spec.id)?.state ?? null,
            })),
          );
          return;
        case 'show':
          if (!argument) break;
          print({ job: store.job(argument), runs: store.runs({ jobId: argument }) });
          return;
        case 'add': {
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
          if (values.at && values.cron) throw new Error('Choose --at (one-off) or --cron (recurring)');
          const now = Date.now();
          const spec = jobSchema.parse({
            id: `job-${randomUUID().slice(0, 8)}`,
            ...(values.title ? { title: values.title } : {}),
            ...(values.cron
              ? { cron: values.cron, timezone: values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }
              : { at: new Date(values.at ? parseDue(values.at, now) : now).toISOString() }),
            resource,
            task,
            ...(report ? { report } : {}),
          });
          const job = store.addJob(spec, 'operator', now, { dedupeKey: `manual:${values.key ?? randomUUID()}` });
          print({ job, runs: store.runs({ jobId: job.spec.id }) });
          await poke();
          return;
        }
        case 'pause':
        case 'resume':
          if (!argument) break;
          print(store.setJobEnabled(argument, subcommand === 'resume'));
          await poke();
          return;
        case 'remove':
          if (!argument) break;
          store.removeJob(argument);
          print({ removed: argument });
          return;
        case 'run':
          if (!argument) break;
          print(store.runJob(argument));
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
    if (command === 'runs') {
      switch (subcommand) {
        case 'list':
          print(
            store.runs({
              ...(values.job ? { jobId: values.job } : {}),
              ...(values.state ? { state: runState(values.state) } : {}),
              ...(values.limit ? { limit: Number(values.limit) } : {}),
            }),
          );
          return;
        case 'show':
          if (!argument) break;
          print({ run: store.run(argument), history: store.history(argument) });
          return;
        case 'cancel':
          if (!argument) break;
          store.cancelQueued(argument);
          print(store.run(argument));
          return;
        case 'abort':
          if (!argument) break;
          store.requestCancel(argument);
          print(store.run(argument));
          await poke();
          return;
        case 'resolve': {
          if (!argument) break;
          if (!values['confirm-stopped'] || !values.reason || !['succeeded', 'failed'].includes(values.outcome ?? '')) {
            throw new Error('Resolution requires --confirm-stopped, --outcome succeeded|failed and --reason');
          }
          store.resolveBlocked(argument, values.outcome as 'succeeded' | 'failed', values.reason);
          print(store.run(argument));
          await poke();
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
      if (!once && slack && slackConfig) modules.push(slack.createSlackModule(slackConfig));
      if (!once && linear && loaded.config.linear) modules.push(linear.createLinearModule(loaded.config.linear));
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

const RUN_STATES: RunState[] = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'missed'];
function runState(value: string): RunState {
  if (!RUN_STATES.includes(value as RunState))
    throw new Error(`Unknown run state: ${value}. One of ${RUN_STATES.join(', ')}`);
  return value as RunState;
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

/** The client to ask for teams: the one configured app, or the one `--app` names.
 * requireLinearSecrets names the missing LINEAR_* variables when secrets are absent. */
async function linearClientFor(
  linear: typeof import('@aivi/linear'),
  config: LinearConfig,
  app: string | undefined,
  log: Logger,
): Promise<LinearClient> {
  const ids = Object.keys(config.apps);
  if (!ids.length) throw new Error('linear.apps is empty: configure a Linear app before pointing projects at teams');
  if (ids.length > 1 && !app) throw new Error(`Several Linear apps are configured (${ids.join(', ')}): pass --app`);
  const id = app ?? ids[0]!;
  if (!config.apps[id]) throw new Error(`Unknown Linear app ${id}. Configured: ${ids.join(', ')}`);
  const creds = linear.requireLinearSecrets(config).find(cred => cred.id === id);
  return new linear.LinearClient(creds!, { log });
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
