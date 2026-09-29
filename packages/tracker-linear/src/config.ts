/** The Linear plugin's registry declaration, at its `./config` subpath: the
 *  module id, the block's own schema (with the cross-field rules that belong to
 *  it), and the bridge to the module code. The CLI imports this for every
 *  command, so nothing here pulls the Linear client. */
import { PROJECT_ID } from '@aivi/core';
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

const id = z.string().regex(PROJECT_ID);
/**
 * The Linear module. One app does the work: it carries the workspace's
 * **Issues** data feed on its webhook route, receives every agent-session
 * event, and its token authorises the Linear MCP. Extra apps are *faces* — a
 * name and icon in Linear's UI, their own credentials (`LINEAR_<APP>_*`) and
 * webhook route, no routing meaning. Lanes in `projects.<id>.linear.lanes`
 * name OpenCode agents directly. The block lives at `plugins.linear` in
 * config.json; the `aivi-plugins` list in app/package.json says whether the
 * module runs.
 */
export const linearSchema = z
  .strictObject({
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
  })
  .superRefine((config, ctx) => {
    // Several apps need a named primary, and the primary must be one of the configured apps.
    const appIds = Object.keys(config.apps);
    if (appIds.length > 1 && !config.primary)
      ctx.addIssue({
        code: 'custom',
        path: ['primary'],
        message:
          'Required once several apps are configured: which app carries the data feed and the bare LINEAR_* secrets',
      });
    if (config.primary && !appIds.includes(config.primary))
      ctx.addIssue({ code: 'custom', path: ['primary'], message: 'Not a configured app' });
  });
export type LinearConfig = z.infer<typeof linearSchema>;

/** The environment names of the one app: the primary's credentials, no app segment. */
export const linearPrimarySecretNames = {
  clientId: 'LINEAR_CLIENT_ID',
  clientSecret: 'LINEAR_CLIENT_SECRET',
  webhookSecret: 'LINEAR_WEBHOOK_SECRET',
} as const;

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

/** The app that carries the workspace data feed and the bare secrets: `linear.primary`, else the one configured app. */
export function primaryLinearApp(linear: LinearConfig | undefined): string | undefined {
  if (!linear) return undefined;
  if (linear.primary) return linear.primary;
  const ids = Object.keys(linear.apps);
  return ids.length === 1 ? ids[0] : undefined;
}

/** The assistant's agent name: `linear.agent`, else the one assistant everyone gets. */
export function assistantAgent(linear: LinearConfig | undefined): string {
  return linear?.agent ?? 'assistant';
}

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

/** The plugin's own `linear` section of a project entry (`projects.<id>.linear`),
 *  contributed to the composed schema the way the `plugins` block contributes
 *  its own. Core reads none of it. */
export const linearProjectSchema = z.strictObject({
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
});
export type LinearProjectEntry = z.infer<typeof linearProjectSchema>;

/** The plugin's own section under `projectDefaults`: the lane convention every
 *  Linear project inherits unless it maps the lane itself. */
export const linearProjectDefaultsSchema = z.strictObject({
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
});
export type LinearProjectDefaults = z.infer<typeof linearProjectDefaultsSchema>;

/** The project's Linear routing as it takes effect: `lanes` is the merge of
 * `projectDefaults.linear.lanes` and the entry's own, entry winning one key at
 * a time, with the human lanes (`null`) filtered out — those live in the file. */
export interface ProjectLinear {
  workspaceId?: string;
  teams: string[];
  lanes: Record<string, LaneBinding>;
}

/** The registry entry: the block holds no paths (credentials live in the
 *  environment, lanes name agents), so `home` finds nothing to resolve here;
 *  the module code loads lazily. The `linear` sections of a project and of
 *  `projectDefaults` are contributed here — core passes them through and this
 *  plugin reads them back. */
export const plugin: AiviPlugin<LinearConfig> = {
  id: 'linear',
  configSchema: linearSchema,
  projectSchema: linearProjectSchema,
  projectDefaultsSchema: linearProjectDefaultsSchema,
  createModule: config => import('./module.ts').then(m => m.createLinearModule(config)),
};
