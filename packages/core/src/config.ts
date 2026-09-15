import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Cron } from 'croner';
import { z } from 'zod';
import { browserConfigSchema } from './browser.ts';
import type { KnowledgeKind } from './kinds.ts';
import { knowledgeKindHelp, knowledgeKindNames } from './kinds.ts';

const id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
export const knowledgeKindSchema = z.enum(knowledgeKindNames);
const source = z.strictObject({
  id,
  path: z.string().min(1),
  kind: knowledgeKindSchema.default('doc').describe(knowledgeKindHelp),
});
export const taskSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('system.check') }),
  z.strictObject({ kind: z.literal('knowledge.index') }),
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
      .describe('Where facts.md and proposals/ live. Must be inside a core knowledge source so memory is searchable.'),
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
export const projectSchema = z.strictObject({
  $schema: z.string().optional().describe('Editor hint; ignored at runtime.'),
  knowledge: z.array(source).default([]),
  linear: z
    .strictObject({
      workspaceId: z.string().min(1),
      projectId: z.string().min(1),
      lanes: z.record(z.string().min(1), id),
    })
    .optional(),
});
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
    knowledge: z.array(source).default([]),
    projects: z.array(z.strictObject({ id, directory: z.string().min(1) })).default([]),
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
    linear: z.strictObject({ applications: z.record(id, z.strictObject({ agent: z.string().min(1) })) }).optional(),
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
      })
      .default({
        maxConcurrent: 1,
        resources: { 'local-model': 1 },
        agentSchedules: { resource: 'local-model', max: 50 },
        misfire: { graceSeconds: 60 },
        retention: { cron: '0 4 * * *', olderThanDays: 30 },
      }),
    jobs: z.array(jobSchema).default([]),
  })
  .superRefine((config, ctx) => {
    for (const [field, values] of [
      ['projects', config.projects],
      ['knowledge', config.knowledge],
      ['jobs', config.jobs],
    ] as const) {
      const seen = new Set<string>();
      for (const [i, value] of values.entries()) {
        if (seen.has(value.id))
          ctx.addIssue({ code: 'custom', path: [field, i, 'id'], message: 'Duplicate identifier' });
        seen.add(value.id);
      }
    }
    const agents = new Set<string>();
    for (const [app, value] of Object.entries(config.linear?.applications ?? {})) {
      if (agents.has(value.agent))
        ctx.addIssue({
          code: 'custom',
          path: ['linear', 'applications', app],
          message: 'An OpenCode agent can be mapped to only one Linear application',
        });
      agents.add(value.agent);
    }
    for (const [i, job] of config.jobs.entries()) {
      if (!(job.resource in config.scheduler.resources))
        ctx.addIssue({ code: 'custom', path: ['jobs', i, 'resource'], message: 'Unknown resource pool' });
      if (job.id === RETENTION_JOB_ID && config.scheduler.retention)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', i, 'id'],
          message: 'Reserved for the system retention job; choose another id or set scheduler.retention to false',
        });
    }
    if (config.scheduler.agentSchedules && !(config.scheduler.agentSchedules.resource in config.scheduler.resources))
      ctx.addIssue({
        code: 'custom',
        path: ['scheduler', 'agentSchedules', 'resource'],
        message: 'Unknown resource pool; name one of scheduler.resources or set agentSchedules to false',
      });
    const retention = config.scheduler.retention;
    if (retention) {
      if (retention.resource !== undefined && !(retention.resource in config.scheduler.resources))
        ctx.addIssue({
          code: 'custom',
          path: ['scheduler', 'retention', 'resource'],
          message: 'Unknown resource pool; name one of scheduler.resources or set retention to false',
        });
      if (
        !jobSchema.safeParse({
          id: RETENTION_JOB_ID,
          cron: retention.cron,
          timezone: retention.timezone,
          task: { kind: 'system.check' },
        }).success
      )
        ctx.addIssue({
          code: 'custom',
          path: ['scheduler', 'retention', 'cron'],
          message: 'Invalid cron expression or timezone',
        });
    }
  });
export type Config = z.infer<typeof configSchema>;

/** Id of the job the host seeds from `scheduler.retention`. */
export const RETENTION_JOB_ID = 'retention';
/** The system job `scheduler.retention` describes, or null when retention is off. */
export function retentionJob(
  config: Config,
  hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Job | null {
  const retention = config.scheduler.retention;
  if (!retention) return null;
  const pools = Object.keys(config.scheduler.resources);
  return jobSchema.parse({
    id: RETENTION_JOB_ID,
    title: 'Prune finished runs',
    cron: retention.cron,
    timezone: retention.timezone ?? hostTimezone,
    resource: retention.resource ?? (pools.includes('local-model') ? 'local-model' : pools[0]),
    task: { kind: 'runs.prune', olderThanDays: retention.olderThanDays },
  });
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
  directory: string;
  settings: z.infer<typeof projectSchema>;
}
export interface LoadedConfig {
  config: Config;
  path: string;
  projects: Project[];
  sources: KnowledgeSource[];
}

const absolute = (base: string, value: string): string => (isAbsolute(value) ? value : resolve(base, value));

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
  const sources: KnowledgeSource[] = config.knowledge.map(s => ({ ...s, path: absolute(base, s.path), scope: 'core' }));
  const projects: Project[] = [];
  for (const entry of config.projects) {
    const directory = absolute(base, entry.directory);
    let raw: unknown = {};
    try {
      raw = JSON.parse(await readFile(resolve(directory, 'aivi.project.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const settings = projectSchema.parse(raw);
    const seen = new Set<string>();
    for (const s of settings.knowledge) {
      if (seen.has(s.id)) throw new Error(`Duplicate source ${s.id} in project ${entry.id}`);
      seen.add(s.id);
      sources.push({ ...s, path: absolute(directory, s.path), scope: 'project', projectId: entry.id });
    }
    for (const app of Object.values(settings.linear?.lanes ?? {})) {
      if (!config.linear?.applications[app])
        throw new Error(`Project ${entry.id} refers to unknown Linear application ${app}`);
    }
    projects.push({ id: entry.id, directory, settings });
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
