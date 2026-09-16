import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Cron } from 'croner';
import { z } from 'zod';
import { browserConfigSchema } from './browser.ts';
import type { ProjectSummary } from './contracts.ts';
import type { KnowledgeKind } from './kinds.ts';
import { knowledgeKindHelp, knowledgeKindNames } from './kinds.ts';

/** Identifiers for sources, jobs, pools, projects; a project id is also its directory name. */
export const PROJECT_ID = /^[a-z][a-z0-9_-]*$/;
const id = z.string().regex(PROJECT_ID);
export const knowledgeKindSchema = z.enum(knowledgeKindNames);
const source = z.strictObject({
  id,
  path: z.string().min(1),
  kind: knowledgeKindSchema.default('doc').describe(knowledgeKindHelp),
});
export const taskSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('system.check') }),
  z.strictObject({ kind: z.literal('knowledge.index') }),
  /** Fast-forward every project's `source/` to its upstream, then reindex what changed. */
  z.strictObject({ kind: z.literal('projects.sync') }),
  z.strictObject({
    kind: z.literal('runs.prune'),
    /** Finished runs (and the finished one-off jobs they belonged to) older than this are deleted; blocked and active work never is. */
    olderThanDays: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('shell'),
    /** argv, never a shell string: no quoting or injection surprises. */
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
    /** Merged over the inherited host environment (minus aivi's own secrets). */
    env: z.record(z.string().min(1), z.string()).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(24 * 3_600_000)
      .default(600_000),
  }),
  z.strictObject({
    kind: z.literal('dreaming'),
    agent: z
      .string()
      .min(1)
      .default('dreamer')
      .describe('OpenCode agent that reviews conversations and maintains memory.'),
    directory: z
      .string()
      .min(1)
      .default('.')
      .describe('OpenCode location that defines the agent. Default: the aivi home, whose .opencode/ holds the agents.'),
    memoryDirectory: z
      .string()
      .min(1)
      .default('memory')
      .describe(
        'Where the org facts.md and proposals/ live; default <home>/memory, which is always a core memory source. Must be inside a core knowledge source so memory is searchable.',
      ),
    origins: z
      .array(z.string().min(1))
      .min(1)
      .default(['discord'])
      .describe('Which aivi session origins to review (metadata.aivi.origin).'),
    maxSessions: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Oldest-first batch size per run; the rest waits for the next run.'),
    timeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 3_600_000)
      .default(1_800_000),
  }),
  z.strictObject({
    kind: z.literal('opencode.prompt'),
    agent: z.string().min(1),
    directory: z.string().min(1),
    prompt: z.string().min(1),
    /** Wall-clock limit for the whole turn; an expired turn blocks the job for inspection. */
    timeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 3_600_000)
      .default(1_800_000),
    /** Unattended default: deny permission prompts and let the agent continue. `fail` blocks the job with the prompt pending. */
    onPermission: z.enum(['reject', 'fail']).default('reject'),
  }),
]);
export type Task = z.infer<typeof taskSchema>;
const reportOn = z.enum(['always', 'failure', 'never']).default('always');
/**
 * Where a job's outcome goes. `session`: back into an OpenCode session as a
 * prompt; whichever channel module owns that session delivers it as a turn,
 * otherwise the host queues it natively. `channel`: posted by the channel
 * module `module` (for example `discord`) to `channel`, that platform's own
 * identifier; the module decides whether aivi may post there.
 */
export const reportSchema = z.discriminatedUnion('to', [
  z.strictObject({ to: z.literal('session'), session: z.string().min(1), on: reportOn }),
  z.strictObject({ to: z.literal('channel'), module: id, channel: z.string().min(1), on: reportOn }),
]);
export type Report = z.infer<typeof reportSchema>;
/** An ISO 8601 instant; `Date.parse` alone accepts too much. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const misfireSchema = z.strictObject({
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .describe(
      'An occurrence found later than this after downtime is recorded as a missed run, never executed. A large value means "run whenever".',
    ),
});
/**
 * A job: a task plus when. Recurring (`cron` + `timezone`) or one-off (`at`).
 * The stored definition; its executions are runs.
 */
export const jobSchema = z
  .strictObject({
    id,
    /** Short human label; agent-created jobs carry the one the person gave. */
    title: z.string().min(1).max(80).optional(),
    cron: z.string().min(1).optional(),
    timezone: z.string().default('UTC'),
    /** One-off: fires once at this ISO 8601 instant. Exactly one of `cron` or `at`. */
    at: z.string().regex(ISO_INSTANT).optional(),
    resource: id.default('local-model'),
    enabled: z.boolean().default(true),
    task: taskSchema,
    report: reportSchema.optional(),
    /** Per-job override of `scheduler.misfire`. */
    misfire: misfireSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.cron === undefined) === (value.at === undefined))
      ctx.addIssue({ code: 'custom', message: 'Give exactly one of cron (recurring) or at (one-off)', path: ['cron'] });
    if (value.at !== undefined && Number.isNaN(Date.parse(value.at)))
      ctx.addIssue({ code: 'custom', message: 'Not an ISO 8601 instant', path: ['at'] });
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.timezone });
      if (value.cron !== undefined) {
        // Croner is used only as a calendar calculator, never as our durable queue.
        const cron = new Cron(value.cron, { timezone: value.timezone, paused: true });
        cron.stop();
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid cron expression or timezone', path: ['cron'] });
    }
  });
export type Job = z.infer<typeof jobSchema>;
/** The id every memory source carries: `<home>/memory` for the org, `<home>/memory/<project>` per project. */
export const MEMORY_SOURCE_ID = 'memory';
/**
 * The company-wide convention for what a repository's `docs/` holds. A file
 * belongs to the most specific source that contains it, so `docs/adr/*` is
 * `decision` and the rest of `docs/` is `doc`; nothing is indexed twice.
 */
export const DEFAULT_PROJECT_KNOWLEDGE = [
  { id: 'docs', path: 'docs', kind: 'doc' },
  { id: 'adr', path: 'docs/adr', kind: 'decision' },
] as const satisfies readonly z.input<typeof source>[];
/**
 * One project: a clean git checkout at `<home>/projects/<id>`, discovered from
 * that directory. An entry here is only needed to override: `knowledge`
 * replaces `projectDefaults.knowledge` for a repository laid out differently
 * (paths relative to the checkout), `enabled: false` hides a checkout from
 * indexing and memory, `linear.lanes` is validated ahead of the module.
 */
export const projectSchema = z.strictObject({
  enabled: z.boolean().default(true).describe('false: the checkout stays but aivi ignores it.'),
  knowledge: z
    .array(source)
    .optional()
    .describe('Replaces projectDefaults.knowledge for this project; paths relative to the checkout.'),
  linear: z
    .strictObject({
      workspaceId: z
        .string()
        .min(1)
        .optional()
        .describe('Linear organization id; only needed with more than one workspace.'),
      projectId: z.string().min(1).describe('The Linear project whose issues belong to this project.'),
      lanes: z
        .record(z.string().min(1), id)
        .describe('Workflow state name → app id: issues entering that state are worked by that app.'),
    })
    .optional(),
});
/**
 * The Linear module (nothing reads it yet beyond validation; the plan is in
 * `docs/plans/linear.md`). Each *app* is one Linear OAuth application acting
 * as an app user, mapped to exactly one OpenCode agent; its client id, client
 * secret and webhook signing secret come from the environment as
 * `LINEAR_<APP>_CLIENT_ID`, `LINEAR_<APP>_CLIENT_SECRET` and
 * `LINEAR_<APP>_WEBHOOK_SECRET` (`<APP>` = the id upper-cased, `-` → `_`).
 * Presence of this block enables the module.
 */
export const linearSchema = z.strictObject({
  apps: z
    .record(
      id,
      z.strictObject({ agent: z.string().min(1).describe('The OpenCode agent this app runs as; unique across apps.') }),
    )
    .describe('Linear apps by id; lanes in projects.<id>.linear.lanes refer to these ids.'),
  listener: z
    .boolean()
    .default(false)
    .describe(
      'React to issue lane changes by delegating eligible issues to the lane’s app. Off: only delegations and mentions made in Linear start a worker.',
    ),
  humanLabel: z
    .string()
    .min(1)
    .default('needs-human')
    .describe(
      'Issues carrying this label are never worked automatically; a hand delegation is refused with an explanation.',
    ),
  resource: id.default('local-model').describe('Pool a worker turn takes a slot in.'),
  progress: z
    .enum(['silent', 'status', 'tools'])
    .default('tools')
    .describe('What the ephemeral activities in the agent session show while a worker runs.'),
  turnTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 3_600_000)
    .default(2 * 3_600_000)
    .describe('A worker turn longer than this is interrupted and ends stopped.'),
});
export type LinearConfig = z.infer<typeof linearSchema>;
/** Environment variable names one Linear app's credentials are read from. */
export const linearSecretNames = (app: string) => {
  const key = app.toUpperCase().replaceAll('-', '_');
  return {
    clientId: `LINEAR_${key}_CLIENT_ID`,
    clientSecret: `LINEAR_${key}_CLIENT_SECRET`,
    webhookSecret: `LINEAR_${key}_WEBHOOK_SECRET`,
  };
};
/**
 * Where the host API listens and how callers authenticate.
 * `bind` defaults to loopback; use a LAN/tailnet address or `0.0.0.0` to let
 * remote OpenCode installs reach the knowledge server. Auth `none` trusts the
 * network; `token` requires `AIVI_TOKEN` (>= 24 chars) as a bearer token.
 */
export const hostSchema = z.strictObject({
  bind: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4100),
  auth: z
    .discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('token') }),
      z.strictObject({ mode: z.literal('none') }),
    ])
    .default({ mode: 'token' }),
});
/**
 * How to reach OpenCode v2. Without `url`, the host discovers the local
 * background service (`opencode service status`) and uses its credentials.
 * `lifecycle` says how much of that service aivi owns: `discover` never starts
 * or stops it; `ensure` starts one when none is running; `own` (default) also
 * restarts a running one when `aivi serve` starts, so a new plugin build is
 * picked up and the service carries aivi's `AIVI_TOKEN`. With `url`, supply
 * `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` if that server requires HTTP basic
 * auth; `lifecycle` is ignored.
 */
export const opencodeSchema = z.strictObject({
  url: z.url().optional(),
  lifecycle: z
    .enum(['discover', 'ensure', 'own'])
    .default('own')
    .describe(
      'discover: never start or stop the local service. ensure: start one when none runs. own (default): also restart a running one at `aivi serve` startup (persistent terminals are handed off), so aivi is the one thing to supervise.',
    ),
});
export const configSchema = z
  .strictObject({
    $schema: z.string().optional().describe('Editor hint; ignored at runtime.'),
    version: z.literal(1),
    stateDirectory: z.string().default('state'),
    host: hostSchema.default({ bind: '127.0.0.1', port: 4100, auth: { mode: 'token' } }),
    opencode: opencodeSchema.default({ lifecycle: 'own' }),
    knowledge: z
      .array(source)
      .default([])
      .describe('Core sources; `<home>/memory` is added as the core `memory` source automatically.'),
    projectDefaults: z
      .strictObject({
        knowledge: z
          .array(source)
          .default([...DEFAULT_PROJECT_KNOWLEDGE])
          .describe('Sources every project gets unless it lists its own; paths relative to the checkout.'),
      })
      .default({ knowledge: [...DEFAULT_PROJECT_KNOWLEDGE] })
      .describe('The company-wide repository convention. Default: docs/ as doc, docs/adr as decision.'),
    projects: z
      .record(id, projectSchema)
      .default({})
      .describe(
        'Overrides per project id. Projects are discovered as the directories of <home>/projects; each gets <home>/memory/<id> as its memory source.',
      ),
    modules: z
      .strictObject({
        discord: z.strictObject({ config: z.string().min(1) }).optional(),
        slack: z.strictObject({ config: z.string().min(1) }).optional(),
      })
      .default({}),
    browser: z
      .union([browserConfigSchema, z.literal(false)])
      .prefault({ connection: { mode: 'launch', userDataDir: 'state/chrome' } })
      .describe(
        'Chrome for browser_control. Default: aivi launches its own Chrome with a profile under state/chrome on first use. `false` disables the browser service.',
      ),
    search: z
      .strictObject({
        provider: z.literal('qmd'),
        indexOnStart: z.boolean().default(true),
        maxPending: z.number().int().min(1).max(100).default(32),
      })
      .optional(),
    linear: linearSchema.optional(),
    scheduler: z
      .strictObject({
        maxConcurrent: z.number().int().min(1).max(64).default(1),
        resources: z.record(id, z.number().int().min(1).max(64)).default({ 'local-model': 1 }),
        agentSchedules: z
          .union([
            z.strictObject({
              resource: id.default('local-model').describe('Pool that agent-created jobs run in.'),
              max: z
                .number()
                .int()
                .min(1)
                .max(500)
                .default(50)
                .describe('How many agent-created jobs (recurring, or one-offs not yet fired) may exist at once.'),
            }),
            z.literal(false),
          ])
          .default({ resource: 'local-model', max: 50 })
          .describe(
            'OpenCode agents create jobs through the aivi_jobs tool; whoever may talk to an agent may schedule. `false` disables the tool.',
          ),
        misfire: z
          .strictObject({ graceSeconds: misfireSchema.shape.graceSeconds.default(60) })
          .default({ graceSeconds: 60 })
          .describe(
            'Default for every job: an occurrence found more than graceSeconds late (aivi was down) becomes one missed run per job, never executed.',
          ),
        retention: z
          .union([
            z.strictObject({
              cron: z.string().min(1).default('0 4 * * *'),
              timezone: z.string().optional().describe('IANA timezone; default the host’s.'),
              olderThanDays: z.number().int().min(1).default(30),
              resource: id
                .optional()
                .describe(
                  'Pool the prune run takes a slot in; default local-model, or the first pool when that does not exist.',
                ),
            }),
            z.literal(false),
          ])
          .default({ cron: '0 4 * * *', olderThanDays: 30 })
          .describe(
            'The system job `retention` (task runs.prune) that deletes finished runs and finished one-off jobs older than olderThanDays. `false` removes it.',
          ),
        projectsSync: z
          .union([
            z.strictObject({
              cron: z.string().min(1).default('0 * * * *'),
              timezone: z.string().optional().describe('IANA timezone; default the host’s.'),
              resource: id
                .optional()
                .describe(
                  'Pool the sync run takes a slot in; default local-model, or the first pool when that does not exist.',
                ),
            }),
            z.literal(false),
          ])
          .default({ cron: '0 * * * *' })
          .describe(
            'The system job `projects-sync` (task projects.sync) that fast-forwards every project’s source/ to its upstream and reindexes what changed, so merges reach what is searched. `false` removes it.',
          ),
      })
      .default({
        maxConcurrent: 1,
        resources: { 'local-model': 1 },
        agentSchedules: { resource: 'local-model', max: 50 },
        misfire: { graceSeconds: 60 },
        retention: { cron: '0 4 * * *', olderThanDays: 30 },
        projectsSync: { cron: '0 * * * *' },
      }),
    jobs: z.array(jobSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const sourceLists: [(string | number)[], { id: string }[]][] = [
      [['knowledge'], config.knowledge],
      [['projectDefaults', 'knowledge'], config.projectDefaults.knowledge],
      ...Object.entries(config.projects).flatMap(([project, entry]): [(string | number)[], { id: string }[]][] =>
        entry.knowledge ? [[['projects', project, 'knowledge'], entry.knowledge]] : [],
      ),
    ];
    for (const [path, values] of [...sourceLists, [['jobs'], config.jobs] as (typeof sourceLists)[number]]) {
      const seen = new Set<string>();
      for (const [i, value] of values.entries()) {
        if (seen.has(value.id))
          ctx.addIssue({ code: 'custom', path: [...path, i, 'id'], message: 'Duplicate identifier' });
        seen.add(value.id);
      }
    }
    for (const [path, values] of sourceLists)
      for (const [i, value] of values.entries())
        if (value.id === MEMORY_SOURCE_ID)
          ctx.addIssue({
            code: 'custom',
            path: [...path, i, 'id'],
            message: 'Reserved: <home>/memory and <home>/memory/<project> are registered automatically',
          });
    const agents = new Set<string>();
    for (const [app, value] of Object.entries(config.linear?.apps ?? {})) {
      if (agents.has(value.agent))
        ctx.addIssue({
          code: 'custom',
          path: ['linear', 'apps', app],
          message: 'An OpenCode agent can be mapped to only one Linear app',
        });
      agents.add(value.agent);
    }
    if (config.linear && !(config.linear.resource in config.scheduler.resources))
      ctx.addIssue({ code: 'custom', path: ['linear', 'resource'], message: 'Unknown resource pool' });
    for (const [i, job] of config.jobs.entries()) {
      if (!(job.resource in config.scheduler.resources))
        ctx.addIssue({ code: 'custom', path: ['jobs', i, 'resource'], message: 'Unknown resource pool' });
      if (job.id === RETENTION_JOB_ID && config.scheduler.retention)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', i, 'id'],
          message: 'Reserved for the system retention job; choose another id or set scheduler.retention to false',
        });
      if (job.id === PROJECTS_SYNC_JOB_ID && config.scheduler.projectsSync)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', i, 'id'],
          message:
            'Reserved for the system projects-sync job; choose another id or set scheduler.projectsSync to false',
        });
    }
    if (config.scheduler.agentSchedules && !(config.scheduler.agentSchedules.resource in config.scheduler.resources))
      ctx.addIssue({
        code: 'custom',
        path: ['scheduler', 'agentSchedules', 'resource'],
        message: 'Unknown resource pool; name one of scheduler.resources or set agentSchedules to false',
      });
    for (const [name, system] of [
      ['retention', config.scheduler.retention],
      ['projectsSync', config.scheduler.projectsSync],
    ] as const) {
      if (!system) continue;
      if (system.resource !== undefined && !(system.resource in config.scheduler.resources))
        ctx.addIssue({
          code: 'custom',
          path: ['scheduler', name, 'resource'],
          message: `Unknown resource pool; name one of scheduler.resources or set ${name} to false`,
        });
      if (
        !jobSchema.safeParse({
          id: 'system',
          cron: system.cron,
          timezone: system.timezone,
          task: { kind: 'system.check' },
        }).success
      )
        ctx.addIssue({
          code: 'custom',
          path: ['scheduler', name, 'cron'],
          message: 'Invalid cron expression or timezone',
        });
    }
  });
export type Config = z.infer<typeof configSchema>;

/** Id of the job the host seeds from `scheduler.retention`. */
export const RETENTION_JOB_ID = 'retention';
/** Id of the job the host seeds from `scheduler.projectsSync`. */
export const PROJECTS_SYNC_JOB_ID = 'projects-sync';

const systemPool = (config: Config, resource: string | undefined) => {
  const pools = Object.keys(config.scheduler.resources);
  return resource ?? (pools.includes('local-model') ? 'local-model' : pools[0]);
};

/** The system job `scheduler.retention` describes, or null when retention is off. */
export function retentionJob(
  config: Config,
  hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Job | null {
  const retention = config.scheduler.retention;
  if (!retention) return null;
  return jobSchema.parse({
    id: RETENTION_JOB_ID,
    title: 'Prune finished runs',
    cron: retention.cron,
    timezone: retention.timezone ?? hostTimezone,
    resource: systemPool(config, retention.resource),
    task: { kind: 'runs.prune', olderThanDays: retention.olderThanDays },
  });
}

/** The system job `scheduler.projectsSync` describes, or null when it is off. */
export function projectsSyncJob(
  config: Config,
  hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Job | null {
  const sync = config.scheduler.projectsSync;
  if (!sync) return null;
  return jobSchema.parse({
    id: PROJECTS_SYNC_JOB_ID,
    title: 'Sync project checkouts',
    cron: sync.cron,
    timezone: sync.timezone ?? hostTimezone,
    resource: systemPool(config, sync.resource),
    task: { kind: 'projects.sync' },
  });
}

/** The system jobs the host seeds beside the configured ones. */
export function systemJobs(config: Config, hostTimezone?: string): Job[] {
  return [retentionJob(config, hostTimezone), projectsSyncJob(config, hostTimezone)].filter(
    (j): j is Job => j !== null,
  );
}

/**
 * Who may talk to aivi through a communication channel (Discord, Slack, …).
 * Every adapter maps its own identifiers into this one shape:
 * - `dm.users`: people allowed to talk in private; no `dm` means nobody.
 * - `channels[]`: shared places (a channel and its threads). `users` restricts
 *   who is heard there; `trigger` says whether a mention is required.
 * Anyone not matched is ignored before anything reaches the model.
 */
export const accessPolicySchema = z
  .strictObject({
    dm: z
      .strictObject({
        users: z.array(z.string().min(1)).min(1).describe('User IDs allowed to talk to aivi in private messages.'),
      })
      .optional()
      .describe('Private messages. Omit to refuse all DMs.'),
    channels: z
      .array(
        z.strictObject({
          id: z.string().min(1).describe('Channel ID as the platform reports it.'),
          users: z
            .union([z.literal('anyone'), z.array(z.string().min(1)).min(1)])
            .default('anyone')
            .describe('"anyone", or the user IDs aivi listens to here.'),
          trigger: z
            .enum(['mention', 'mention-to-start', 'any'])
            .default('mention-to-start')
            .describe(
              '"mention": every message must address aivi. ' +
                '"mention-to-start": a mention opens a conversation; inside a thread aivi already takes part in, every message counts. ' +
                '"any": every message counts (needs message content access).',
            ),
          sessions: z
            .enum(['threads', 'channel'])
            .default('threads')
            .describe(
              '"threads": a top-level message addressing aivi opens a thread; each thread is its own conversation and the channel itself never is. ' +
                '"channel": the channel is one shared conversation and its threads are ignored.',
            ),
        }),
      )
      .default([])
      .describe('Shared places aivi listens in, each with its own rules.'),
  })
  .describe(
    'Who may talk to aivi through this channel. Unmatched messages are ignored before anything is stored or sent to a model.',
  );
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type AccessChannel = AccessPolicy['channels'][number];
export interface AccessRoute {
  channelId: string;
  parentId: string | null;
  userId: string;
  isDM: boolean;
  mentioned: boolean;
  /** aivi already takes part in this conversation (a session exists for it). */
  knownConversation: boolean;
}

/** The channel entry governing a route, or undefined when the place is not configured. */
export function accessEntry(policy: AccessPolicy, route: AccessRoute): AccessChannel | undefined {
  const inThread = route.parentId !== null;
  const entry = policy.channels.find(c => c.id === (inThread ? route.parentId : route.channelId));
  if (entry && inThread && entry.sessions === 'channel') return undefined;
  return entry;
}

export function accessAllows(policy: AccessPolicy, route: AccessRoute): boolean {
  if (route.isDM) return policy.dm?.users.includes(route.userId) ?? false;
  const entry = accessEntry(policy, route);
  if (!entry) return false;
  if (entry.users !== 'anyone' && !entry.users.includes(route.userId)) return false;
  if (entry.trigger === 'any' || route.mentioned) return true;
  return entry.trigger === 'mention-to-start' && route.parentId !== null && route.knownConversation;
}
export interface KnowledgeSource {
  id: string;
  path: string;
  kind: KnowledgeKind;
  scope: 'core' | 'project';
  projectId?: string;
}
export interface Project {
  id: string;
  /** The clean checkout: `<home>/projects/<id>/source`; absent on disk when `removed`. `projectLayout(dirname(directory))` names the rest. */
  directory: string;
  /** The checkout is gone but `memory/` remains: still listed and searchable until purged. */
  removed?: true;
  linear?: NonNullable<z.infer<typeof projectSchema>['linear']>;
}
export interface LoadedConfig {
  config: Config;
  path: string;
  projects: Project[];
  sources: KnowledgeSource[];
}

const absolute = (base: string, value: string): string => (isAbsolute(value) ? value : resolve(base, value));

/** Sub-directories of `root` (following symlinks), sorted, skipping dotfiles; `[]` when `root` is absent. */
async function subdirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(root).catch(() => [])).sort()) {
    if (name.startsWith('.')) continue;
    if ((await stat(join(root, name))).isDirectory()) found.push(name);
  }
  return found;
}

/** The parts of `<home>/projects/<id>` the host knows about. */
export const projectLayout = (root: string) => ({
  root,
  source: join(root, 'source'),
  memory: join(root, 'memory'),
  worktrees: join(root, 'worktrees'),
});

/**
 * Projects are the directories of `<home>/projects` (symlinks to directories
 * included), sorted; each holds `source/` (the clean checkout), `memory/` and
 * `worktrees/`. One with `source/` is active, one with only `memory/` is
 * removed. A name that is not a valid id, a checkout cloned straight into the
 * project directory, an empty directory, and an override for a project that
 * is neither checked out nor remembered are mistakes, so all fail loudly.
 */
async function discoverProjects(
  home: string,
  overrides: Record<string, unknown>,
): Promise<{ id: string; removed: boolean }[]> {
  const root = resolve(home, 'projects');
  const found: { id: string; removed: boolean }[] = [];
  for (const name of await subdirectories(root)) {
    const dir = join(root, name);
    if (!PROJECT_ID.test(name)) throw new Error(`${dir}: a project directory must be named like ${PROJECT_ID}`);
    const layout = projectLayout(dir);
    const has = async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false;
    if (await has(join(dir, '.git')))
      throw new Error(
        `${dir} is a checkout; a project directory holds its checkout in source/. Run: mv ${dir} ${dir}.tmp && mkdir ${dir} && mv ${dir}.tmp ${layout.source}`,
      );
    if (await has(layout.source)) found.push({ id: name, removed: false });
    else if (await has(layout.memory)) found.push({ id: name, removed: true });
    else
      throw new Error(
        `${dir}: not a project (no source/ or memory/); remove the directory or clone into ${layout.source}`,
      );
  }
  for (const id of Object.keys(overrides))
    if (!found.some(p => p.id === id)) throw new Error(`Project ${id}: nothing at ${join(root, id)}`);
  return found;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  path = resolve(path);
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const base = dirname(path);
  config.stateDirectory = absolute(base, config.stateDirectory);
  for (const module of Object.values(config.modules)) if (module) module.config = absolute(base, module.config);
  const browser = config.browser ? config.browser.connection : undefined;
  if (browser && browser.mode !== 'attach') {
    browser.userDataDir = absolute(base, browser.userDataDir);
    if (browser.mode === 'launch' && browser.executablePath)
      browser.executablePath = absolute(base, browser.executablePath);
  }
  const sources: KnowledgeSource[] = [
    ...config.knowledge.map((s): KnowledgeSource => ({ ...s, path: absolute(base, s.path), scope: 'core' })),
    { id: MEMORY_SOURCE_ID, path: resolve(base, 'memory'), kind: 'memory', scope: 'core' },
  ];
  const projects: Project[] = [];
  for (const { id: projectId, removed } of await discoverProjects(base, config.projects)) {
    const entry = config.projects[projectId] ?? projectSchema.parse({});
    // Disabled projects are hidden entirely; a removed project keeps only its memory, so what
    // was learned about it stays listed and searchable until `aivi projects purge`.
    if (!entry.enabled) continue;
    const layout = projectLayout(resolve(base, 'projects', projectId));
    if (!removed)
      for (const s of entry.knowledge ?? config.projectDefaults.knowledge)
        sources.push({ ...s, path: absolute(layout.source, s.path), scope: 'project', projectId });
    sources.push({ id: MEMORY_SOURCE_ID, path: layout.memory, kind: 'memory', scope: 'project', projectId });
    for (const app of Object.values(entry.linear?.lanes ?? {})) {
      if (!config.linear?.apps[app]) throw new Error(`Project ${projectId} refers to unknown Linear app ${app}`);
    }
    projects.push({
      id: projectId,
      directory: layout.source,
      ...(removed ? { removed: true } : {}),
      ...(entry.linear ? { linear: entry.linear } : {}),
    });
  }
  for (const job of config.jobs) {
    const task = job.task;
    if (task.kind === 'opencode.prompt') task.directory = absolute(base, task.directory);
    if (task.kind === 'shell' && task.cwd) task.cwd = absolute(base, task.cwd);
    if (task.kind === 'dreaming') {
      task.directory = absolute(base, task.directory);
      task.memoryDirectory = absolute(base, task.memoryDirectory);
      const inside = sources.some(
        s => s.scope === 'core' && (task.memoryDirectory === s.path || task.memoryDirectory.startsWith(`${s.path}/`)),
      );
      if (!inside)
        throw new Error(
          `Job ${job.id}: memoryDirectory must be inside a core knowledge source so memories are searchable`,
        );
    }
  }
  return { config, path, sources, projects };
}

export function selectSources(
  loaded: LoadedConfig,
  projectIds?: string[],
  includeCore = true,
  kinds?: KnowledgeKind[],
): KnowledgeSource[] {
  if (projectIds) {
    const known = new Set(loaded.projects.map(p => p.id));
    for (const id of projectIds) if (!known.has(id)) throw new Error(`Unknown project: ${id}`);
  }
  return loaded.sources
    .filter(s => (s.scope === 'core' ? includeCore : projectIds === undefined || projectIds.includes(s.projectId!)))
    .filter(s => !kinds || kinds.includes(s.kind));
}

/** Projects as the librarian and `aivi projects list` see them: id, removed marker, searchable sources. */
export function projectSummaries(loaded: LoadedConfig): ProjectSummary[] {
  return loaded.projects.map(p => ({
    id: p.id,
    ...(p.removed ? { removed: true as const } : {}),
    sources: loaded.sources.filter(s => s.projectId === p.id).map(s => ({ id: s.id, kind: s.kind })),
  }));
}
