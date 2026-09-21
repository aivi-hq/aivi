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
/** A script: argv, never a shell string, so there are no quoting or injection surprises. */
const shellTaskSchema = z.strictObject({
  kind: z.literal('shell'),
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
});
/** One turn of one OpenCode agent in one checkout. */
const promptTaskSchema = z.strictObject({
  kind: z.literal('prompt'),
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
});
/**
 * A system capability of the host or of a module. `name` is the operation:
 * claimed exactly once (a second claimant is fatal at startup; a run of an
 * unclaimed operation fails with its name in the reason). `args` are opaque
 * to everyone but the claimant, which parses them and fails the run when
 * they are wrong. Only ever hand-written to opt into a capability by
 * scheduling it (the `dreaming` job); agents never see this kind.
 */
const invocationTaskSchema = z.strictObject({
  kind: z.literal('invocation'),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
export const taskSchema = z.discriminatedUnion('kind', [shellTaskSchema, promptTaskSchema, invocationTaskSchema]);
/** The tasks a person writes in config.json or a task file; what `aivi_jobs` accepts and nothing else. */
export const userTaskSchema = z.discriminatedUnion('kind', [shellTaskSchema, promptTaskSchema]);
export type Task = z.infer<typeof taskSchema>;
/** Display label for a task: the operation name for an invocation, the kind for anything else. */
export function taskLabel(task: Task): string {
  return task.kind === 'invocation' ? task.name : task.kind;
}
/** Args of the host's `runs.prune` operation. */
export const runsPruneArgsSchema = z.strictObject({
  /** Finished runs (and the finished one-off jobs they belonged to) older than this are deleted; blocked and active work never is. */
  olderThanDays: z.number().int().min(1),
});
/** Args of the host's `dreaming` operation; paths resolve against the aivi home, like task paths in config.json. */
export const dreamingArgsSchema = z.strictObject({
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
});
export type DreamingArgs = z.infer<typeof dreamingArgsSchema>;
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
    /** What the job executes. A bare operation name is shorthand for an `invocation` of it: `"dreaming"` is `{ kind: 'invocation', name: 'dreaming' }`. */
    task: z.preprocess(value => (typeof value === 'string' ? { kind: 'invocation', name: value } : value), taskSchema),
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
 * A written lane binding: the OpenCode agent that works issues entering the
 * lane, `null` for a lane humans work, or an object naming an agent that runs
 * without a worktree — in the project's `source/` checkout on main, where
 * only the agent file's own permissions say what it may not do.
 */
export const laneValueSchema = z.union([
  z.string().min(1).nullable(),
  z.strictObject({ agent: z.string().min(1), worktree: z.literal(false).optional() }),
]);
export type LaneValue = z.infer<typeof laneValueSchema>;
/** A lane binding as routing sees it: the agent and whether it gets a worktree. */
export interface LaneBinding {
  agent: string;
  worktree: boolean;
}
/** Normalise a written lane value (`agent | null | { agent, worktree }`); null for human lanes. */
export function laneBinding(value: LaneValue): LaneBinding | null {
  if (value === null) return null;
  if (typeof value === 'string') return { agent: value, worktree: true };
  return { agent: value.agent, worktree: value.worktree !== false };
}
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
      teams: z
        .array(z.string().min(1))
        .min(1)
        .describe('Linear team ids whose issues belong to this project; a team maps to at most one project.'),
      lanes: z
        .record(z.string().min(1), laneValueSchema)
        .default({})
        .describe(
          'Workflow state name → the OpenCode agent that works issues entering that state. `null` marks a human lane. `{ agent, worktree: false }` runs the agent in the project checkout on main, without a worktree. Empty by default: the listener delegates nothing until you map a lane.',
        ),
    })
    .optional(),
});
/**
 * The Linear module. One app does the work: it carries the workspace's
 * **Issues** data feed on its webhook route, receives every agent-session
 * event, and its token authorises the Linear MCP. Extra apps are *faces* — a
 * name and icon in Linear's UI, their own credentials (`LINEAR_<APP>_*`) and
 * webhook route, no routing meaning. Lanes in `projects.<id>.linear.lanes`
 * name OpenCode agents directly. Presence of this block enables the module.
 */
export const linearSchema = z.strictObject({
  agent: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The OpenCode agent that answers people on Linear — comment mentions and delegations that no lane claims: the assistant. Default: the aivi name.',
    ),
  primary: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The app that carries the workspace data feed, signs the bare LINEAR_* secrets and authorises the Linear MCP; default the one app. Required once several apps are configured.',
    ),
  apps: z
    .record(
      id,
      z
        .strictObject({})
        .describe(
          'Empty today: credentials come from the environment; the id is the app identity and its webhook route.',
        ),
    )
    .describe(
      'Linear apps by id. The primary (see `primary`) carries the data feed; every other app is a face — a name and icon in Linear’s UI with its own credentials, no routing meaning.',
    ),
  logMisroutes: z
    .boolean()
    .default(true)
    .describe(
      'Log at warn a webhook delivered to the wrong endpoint (a data change on a face’s route); it is dropped either way.',
    ),
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
  mcp: z
    .union([
      z.strictObject({
        port: z.number().int().min(0).max(65535).default(4101),
      }),
      z.literal(false),
    ])
    .default({ port: 4101 })
    .describe(
      "On by default: the module serves Linear's hosted MCP on loopback (default port 4101), authorised with the app-actor token, so agents can act in Linear and writes attribute to the app; OpenCode connects as a remote MCP at http://127.0.0.1:<port>/mcp. `false` disables it. Loopback only.",
    ),
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
/**
 * Environment variable names for one app's credentials. The **primary** app
 * uses the bare `linearPrimarySecretNames`; this prefixed convention is for
 * every other app (a face) — `<APP>` = the id upper-cased, `-` → `_`.
 */
export const linearSecretNames = (app: string) => {
  const key = app.toUpperCase().replaceAll('-', '_');
  return {
    clientId: `LINEAR_${key}_CLIENT_ID`,
    clientSecret: `LINEAR_${key}_CLIENT_SECRET`,
    webhookSecret: `LINEAR_${key}_WEBHOOK_SECRET`,
  };
};
/**
 * Where the host API listens. `bind` defaults to loopback; use a LAN/tailnet
 * address or `0.0.0.0` to let remote clients reach the API. Commands are open:
 * a bearer token identifies the caller for association, it never locks
 * anything.
 */
export const hostSchema = z.strictObject({
  bind: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4100),
});
/**
 * How to reach OpenCode v2. Without `url`, the host discovers the local
 * background service (`opencode service status`) and uses its credentials.
 * `lifecycle` says how much of that service aivi owns: `discover` never starts
 * or stops it; `ensure` starts one when none is running; `own` (default) also
 * restarts a running one when `aivi serve` starts, so a new plugin build is
 * picked up. With `url`, supply
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
const snowflake = z.string().regex(/^\d{17,20}$/);
/**
 * The Discord module: gateway, access policy and reply behaviour. Presence of
 * this block enables the module; `false` is an explicit off. Its one secret,
 * `DISCORD_BOT_TOKEN`, comes from the environment.
 */
export const discordConfigSchema = z
  .strictObject({
    applicationId: snowflake.describe('The Discord application the bot token belongs to.'),
    agent: z.string().default('librarian'),
    /** OpenCode location that defines the agent. Default: the aivi home, whose .opencode/ holds the agents. */
    directory: z.string().min(1).default('.'),
    resource: z.string().default('local-model'),
    /** Who may talk to the bot: DM allow-list and shared channels (with their threads). */
    access: accessPolicySchema,
    /** Channels aivi may post scheduled job outcomes to (`report: { to: "channel", module: "discord" }`). Empty: never post proactively. */
    reportChannels: z.array(snowflake).default([]),
    /** Requires the Message Content intent in the developer portal; needed for any trigger other than "mention". */
    messageContent: z.boolean().default(false),
    /** What a placeholder message shows while a turn runs: nothing, one status line, or the status plus the tool calls. */
    progress: z.enum(['silent', 'status', 'tools']).default('status'),
    maxConcurrent: z.number().int().min(1).max(32).default(1),
    maxPending: z.number().int().min(1).max(1000).default(100),
    turnTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  })
  .superRefine((config, ctx) => {
    if (!config.messageContent && config.access.channels.some(c => c.trigger !== 'mention')) {
      ctx.addIssue({
        code: 'custom',
        path: ['messageContent'],
        message:
          'triggers other than "mention" need messageContent: true (Discord only delivers unmentioned message text with that intent)',
      });
    }
  });
export type DiscordConfig = z.infer<typeof discordConfigSchema>;
/** Slack ids: channels `C…`/`G…`, DM channels `D…`, users `U…`/`W…`. */
export const isChannelId = (id: string) => /^[CG][A-Z0-9]{8,}$/.test(id);
export const isDMChannelId = (id: string) => /^D[A-Z0-9]{8,}$/.test(id);
export const isUserId = (id: string) => /^[UW][A-Z0-9]{8,}$/.test(id);
const channelId = z.string().refine(isChannelId, 'Expected a Slack channel id (C… or G…)');
/**
 * The Slack module: access policy, command prefix and reply behaviour.
 * Presence of this block enables the module; `false` is an explicit off. Its
 * secrets, `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`, come from the environment.
 */
export const slackConfigSchema = z
  .strictObject({
    agent: z.string().default('librarian'),
    /** OpenCode location that defines the agent. Default: the aivi home, whose .opencode/ holds the agents. */
    directory: z.string().min(1).default('.'),
    /** Slash commands are `/<prefix>-new`, `/<prefix>-status`, `/<prefix>-search`, defined in the Slack app manifest. */
    commandPrefix: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .max(24)
      .default('aivi'),
    resource: z.string().default('local-model'),
    /** Who may talk to the bot: DM allow-list and shared channels (with their threads). */
    access: accessPolicySchema,
    /** Channels aivi may post scheduled job outcomes to (`report: { to: "channel", module: "slack" }`). Empty: never post proactively. */
    reportChannels: z.array(channelId).default([]),
    /** What a placeholder message shows while a turn runs: nothing, one status line, or the status plus the tool calls. */
    progress: z.enum(['silent', 'status', 'tools']).default('status'),
    maxConcurrent: z.number().int().min(1).max(32).default(1),
    maxPending: z.number().int().min(1).max(1000).default(100),
    turnTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  })
  .superRefine((config, ctx) => {
    for (const [i, user] of (config.access.dm?.users ?? []).entries())
      if (!isUserId(user))
        ctx.addIssue({ code: 'custom', path: ['access', 'dm', 'users', i], message: 'Expected a Slack user id (U…)' });
    for (const [i, channel] of config.access.channels.entries()) {
      if (!isChannelId(channel.id))
        ctx.addIssue({ code: 'custom', path: ['access', 'channels', i, 'id'], message: 'Expected a Slack channel id' });
      if (channel.users !== 'anyone')
        for (const [j, user] of channel.users.entries())
          if (!isUserId(user))
            ctx.addIssue({
              code: 'custom',
              path: ['access', 'channels', i, 'users', j],
              message: 'Expected a Slack user id (U…)',
            });
    }
  });
export type SlackConfig = z.infer<typeof slackConfigSchema>;
/**
 * The aivi GitHub App, created 2026-09-20. The last resort for the git identity
 * and the only identity that works unattended: GitHub resolves a bot commit's
 * avatar and link from the email **inside the commit**, never from who pushed,
 * so this needs no token and no installation.
 */
export const AIVI_AGENT_BOT = {
  user: 'aivi-agent[bot]',
  email: '331678708+aivi-agent[bot]@users.noreply.github.com',
  app: 5011508,
} as const;
/**
 * Who aivi is. `name` is the persona every platform shows; `github` is who aivi
 * **commits** as in work it launched itself, and is resolved by `gitIdentity`
 * rather than by a default, because its middle step reads the machine instead
 * of this file.
 */
export const identitySchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .default('aivi')
      .describe(
        'The persona: one name on every platform (the Linear application, the Discord and Slack bot usernames, what colleagues ping). Agent-file and handle names derive from its slug; the display name stays free-form. aivi cannot set names on the platforms — the operator uses this name in each console.',
      ),
    github: z
      .strictObject({
        user: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The git author name of a worker commit. Default: `opencode.coauthor` in the global git config, else the aivi app.',
          ),
        email: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The git author email, same order as `user`. GitHub links the commit from this email, so the default is the app’s noreply address.',
          ),
        app: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'The GitHub App id. Nothing reads it yet; whoever mints an installation token to act on GitHub as the app signs a JWT issued to this.',
          ),
      })
      .optional()
      .describe('Who aivi commits as in work it launched. Only needed to override the app.'),
  })
  .superRefine((identity, ctx) => {
    const half = (identity.github?.user === undefined) !== (identity.github?.email === undefined);
    if (half)
      ctx.addIssue({
        code: 'custom',
        path: ['github'],
        message: 'Name the pair: git takes an author name and an email together, so give both or neither',
      });
  });
export type Identity = z.infer<typeof identitySchema>;
/** A git author, as git wants it. */
export interface GitIdentity {
  name: string;
  email: string;
}
/** Read one key of the global git config; resolves to `""` when it is unset. */
export type ReadGitConfig = (key: string) => Promise<string>;
/**
 * The identity a worker commits as, as one pair from the first source that
 * answers: `identity.github`, then `opencode.coauthor` in the machine's git
 * config (`Name <email>`, the same key the commit plugin co-authors with), then
 * the aivi app. Never a name from one and an email from another — that would
 * link a bot's commits to whoever's address came in second. An unreadable config
 * falls through: a machine without git still gets the app.
 */
export async function gitIdentity(identity: Identity, read: ReadGitConfig): Promise<GitIdentity> {
  if (identity.github?.user && identity.github.email)
    return { name: identity.github.user, email: identity.github.email };
  const written = /^(?<name>.+?)\s+<(?<email>[^<>]+)>$/.exec(
    (await read('opencode.coauthor').catch(() => '')).trim(),
  )?.groups;
  if (written?.name && written.email) return { name: written.name, email: written.email };
  return { name: AIVI_AGENT_BOT.user, email: AIVI_AGENT_BOT.email };
}
export const configSchema = z
  .strictObject({
    $schema: z.string().optional().describe('Editor hint; ignored at runtime.'),
    version: z.literal(1),
    stateDirectory: z.string().default('state'),
    host: hostSchema.default({ bind: '127.0.0.1', port: 4100 }),
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
        linear: z
          .strictObject({
            lanes: z
              .record(z.string().min(1), laneValueSchema)
              .default({})
              .describe(
                'The lane convention every Linear project gets unless it maps the lane itself: workflow state name → agent, or null for a lane humans work.',
              ),
            workspaceId: z
              .string()
              .min(1)
              .optional()
              .describe('Linear organization id every project gets unless it names its own.'),
          })
          .optional()
          .describe('The lane convention for projects that do not map the lane themselves.'),
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
        discord: z
          .union([discordConfigSchema, z.literal(false)])
          .optional()
          .describe('Presence of this block enables the Discord module; `false` is an explicit off.'),
        slack: z
          .union([slackConfigSchema, z.literal(false)])
          .optional()
          .describe('Presence of this block enables the Slack module; `false` is an explicit off.'),
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
    identity: identitySchema
      .prefault({})
      .describe('Who aivi is: the persona every platform shows, and who a worker it launched commits as.'),
    scheduler: z
      .strictObject({
        maxConcurrent: z.number().int().min(1).max(64).default(1),
        /** Host-wide default for derived schedules; a job's own `timezone` wins over it. */
        timezone: z.string().optional().describe('IANA timezone for derived system schedules; default the host’s.'),
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
    const appIds = Object.keys(config.linear?.apps ?? {});
    if (config.linear && appIds.length > 1 && !config.linear.primary)
      ctx.addIssue({
        code: 'custom',
        path: ['linear', 'primary'],
        message:
          'Required once several apps are configured: which app carries the data feed and the bare LINEAR_* secrets',
      });
    if (config.linear?.primary && !appIds.includes(config.linear.primary))
      ctx.addIssue({ code: 'custom', path: ['linear', 'primary'], message: 'Not a configured app' });
    const teamOwners = new Map<string, string>();
    for (const [project, entry] of Object.entries(config.projects))
      for (const [i, team] of entry.linear?.teams.entries() ?? []) {
        const owner = teamOwners.get(team);
        if (owner && owner !== project)
          ctx.addIssue({
            code: 'custom',
            path: ['projects', project, 'linear', 'teams', i],
            message: `This Linear team is already mapped to project ${owner}`,
          });
        teamOwners.set(team, project);
      }
    if (config.linear && !(config.linear.resource in config.scheduler.resources))
      ctx.addIssue({ code: 'custom', path: ['linear', 'resource'], message: 'Unknown resource pool' });
    for (const [name, module] of [
      ['discord', config.modules.discord],
      ['slack', config.modules.slack],
    ] as const)
      if (module && !(module.resource in config.scheduler.resources))
        ctx.addIssue({
          code: 'custom',
          path: ['modules', name, 'resource'],
          message: `Unknown resource pool; name one of scheduler.resources or set modules.${name} to false`,
        });
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
          task: { kind: 'shell', command: ['x'] },
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

/** The environment names of the one app: the primary's credentials, no app segment. */
export const linearPrimarySecretNames = {
  clientId: 'LINEAR_CLIENT_ID',
  clientSecret: 'LINEAR_CLIENT_SECRET',
  webhookSecret: 'LINEAR_WEBHOOK_SECRET',
} as const;

/** The app that carries the workspace data feed and the bare secrets: `linear.primary`, else the one configured app. */
export function primaryLinearApp(linear: LinearConfig | undefined): string | undefined {
  if (!linear) return undefined;
  if (linear.primary) return linear.primary;
  const ids = Object.keys(linear.apps);
  return ids.length === 1 ? ids[0] : undefined;
}

/** The assistant's agent name: `linear.agent`, else the aivi name slugged (lower-case, non-alphanumerics to `-`). */
export function assistantAgent(config: Config): string {
  if (config.linear?.agent) return config.linear.agent;
  const slug = config.identity.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'aivi';
}

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
    timezone: retention.timezone ?? config.scheduler.timezone ?? hostTimezone,
    resource: systemPool(config, retention.resource),
    task: { kind: 'invocation', name: 'runs.prune', args: { olderThanDays: retention.olderThanDays } },
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
    timezone: sync.timezone ?? config.scheduler.timezone ?? hostTimezone,
    resource: systemPool(config, sync.resource),
    task: { kind: 'invocation', name: 'projects.sync' },
  });
}

/** The system jobs the host seeds beside the configured ones. */
export function systemJobs(config: Config, hostTimezone?: string): Job[] {
  return [retentionJob(config, hostTimezone), projectsSyncJob(config, hostTimezone)].filter(
    (j): j is Job => j !== null,
  );
}

export interface KnowledgeSource {
  id: string;
  path: string;
  kind: KnowledgeKind;
  scope: 'core' | 'project';
  projectId?: string;
}
/** The project's Linear routing as it takes effect: `lanes` is the merge of
 * `projectDefaults.linear.lanes` and the entry's own, entry winning one key at
 * a time, with the human lanes (`null`) filtered out — those live in the file. */
export interface ProjectLinear {
  workspaceId?: string;
  teams: string[];
  lanes: Record<string, LaneBinding>;
}
export interface Project {
  id: string;
  /** The clean checkout: `<home>/projects/<id>/source`; absent on disk when `removed`. `projectLayout(dirname(directory))` names the rest. */
  directory: string;
  /** The checkout is gone but `memory/` remains: still listed and searchable until purged. */
  removed?: true;
  linear?: ProjectLinear;
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
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  // Module settings are inline now; a `config` pointer is the old shape, so say where its contents belong.
  for (const name of ['discord', 'slack'] as const) {
    const pointer = (raw as { modules?: Record<string, unknown> }).modules?.[name];
    const file = (pointer as { config?: unknown } | undefined)?.config;
    if (typeof file === 'string')
      throw new Error(
        `modules.${name}.config is gone: the ${name} settings live inline in ${path}. Move the contents of ${file} into that block, without its "version".`,
      );
  }
  const persona = (raw as { name?: unknown }).name;
  if (persona !== undefined)
    throw new Error(
      `name is gone: the persona lives in identity.name in ${path}. Write "identity": { "name": ${JSON.stringify(String(persona))} } there.`,
    );
  const config = configSchema.parse(raw);
  const base = dirname(path);
  config.stateDirectory = absolute(base, config.stateDirectory);
  if (config.modules.discord) config.modules.discord.directory = absolute(base, config.modules.discord.directory);
  if (config.modules.slack) config.modules.slack.directory = absolute(base, config.modules.slack.directory);
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
    // Lanes merge per lane — the convention is the base and the entry wins one
    // key at a time — and `null` means a human works the lane, so it is absent
    // from the map the listener consults while it stays written in the file.
    let linear: ProjectLinear | undefined;
    if (entry.linear) {
      const merged = { ...(config.projectDefaults.linear?.lanes ?? {}), ...entry.linear.lanes };
      const lanes: Record<string, LaneBinding> = {};
      for (const [lane, value] of Object.entries(merged)) {
        const binding = laneBinding(value);
        if (binding) lanes[lane] = binding;
      }
      const workspaceId = entry.linear.workspaceId ?? config.projectDefaults.linear?.workspaceId;
      linear = { teams: entry.linear.teams, lanes, ...(workspaceId ? { workspaceId } : {}) };
    }
    projects.push({
      id: projectId,
      directory: layout.source,
      ...(removed ? { removed: true } : {}),
      ...(linear ? { linear } : {}),
    });
  }
  for (const job of config.jobs) {
    const task = job.task;
    if (task.kind === 'prompt') task.directory = absolute(base, task.directory);
    if (task.kind === 'shell' && task.cwd) task.cwd = absolute(base, task.cwd);
    // Invocation args resolve at run time by whoever claimed the operation; the
    // config does not know their shapes.
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
