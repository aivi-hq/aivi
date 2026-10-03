/** The Slack plugin's registry declaration, at its `./config` subpath: the
 *  module id, the block's own schema, and the lazy bridge to the module code.
 *  The CLI imports this for every command, so nothing here pulls @slack/* —
 *  the id shapes live here too, they are the schema's vocabulary. */
import { type AccessRoute, absolutePath, accessAllows, accessPolicySchema, accessReaches } from '@aivi/core';
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

/** Slack ids: channels `C…`/`G…`, DM channels `D…`, users `U…`/`W…`. */
export const isChannelId = (id: string) => /^[CG][A-Z0-9]{8,}$/.test(id);
export const isDMChannelId = (id: string) => /^D[A-Z0-9]{8,}$/.test(id);
export const isUserId = (id: string) => /^[UW][A-Z0-9]{8,}$/.test(id);
const channelId = z.string().refine(isChannelId, 'Expected a Slack channel id (C… or G…)');
/** The module id, and with it the key of this plugin's block in `config.json`
 *  (`plugins.channel-slack`), its `/status` id and its log category: the module
 *  id is the package's short name (`@aivi/channel-slack`), so the word a person
 *  typed into `aivi add` is the word they write in config.json (ruled 2026-09-30
 *  for every plugin). What deliberately keeps the platform's short name is
 *  everything naming Slack rather than this package: the SQLite prefix and the
 *  session and message id prefixes (`slack_turns`, `ses_slack_…`), which say who
 *  a conversation is on — renaming one would orphan every conversation already
 *  bound to it.
 */
export const MODULE_ID = 'channel-slack';

/**
 * The Slack module: access policy, command prefix and reply behaviour. Its block lives
 * at `plugins.channel-slack` in config.json; the `aivi-plugins` list in app/package.json says
 * whether the module runs. Its secrets, `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`, come
 * from the environment.
 */
export const slackConfigSchema = z
  .strictObject({
    agent: z.string().default('assistant'),
    /** OpenCode location that defines the agent. Default: the aivi home, whose .opencode/ holds the agents. */
    directory: z.string().min(1).default('.'),
    /** Slash commands are `/<prefix>-new`, `/<prefix>-status`, `/<prefix>-search`, defined in the Slack app manifest. */
    commandPrefix: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .max(24)
      .default('aivi'),
    resource: z.string().default('local-model'),
    /** Where the bot listens: shared channels (with their threads). Who may talk is decided by linking. */
    access: accessPolicySchema,
    /** Channels aivi may post scheduled job outcomes to (`report: { to: "channel", module: "slack" }`). Empty: never post proactively. */
    reportChannels: z.array(channelId).default([]),
    /** What a placeholder message shows while a turn runs: nothing, one status line, or the status plus the tool calls. */
    progress: z.enum(['silent', 'status', 'tools']).default('status'),
    maxConcurrent: z.number().int().min(1).max(32).default(1),
    maxPending: z.number().int().min(1).max(1000).default(100),
  })
  .superRefine((config, ctx) => {
    for (const [i, channel] of config.access.channels.entries())
      if (!isChannelId(channel.id))
        ctx.addIssue({ code: 'custom', path: ['access', 'channels', i, 'id'], message: 'Expected a Slack channel id' });
  });
export type SlackConfig = z.infer<typeof slackConfigSchema>;

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: SlackConfig, route: AccessRoute): boolean {
  return accessAllows(config.access, route);
}

/** The place is one aivi listens in; the sender's link state is not consulted. */
export function reaches(config: SlackConfig, route: AccessRoute): boolean {
  return accessReaches(config.access, route);
}

/** The registry entry: `aivi serve` builds the module from the validated block.
 *  `directory` is the one path the block holds; it resolves against the home here,
 *  and the module code is imported lazily so composing the schema stays cheap. */
export const plugin: AiviPlugin<SlackConfig> = {
  id: MODULE_ID,
  configSchema: slackConfigSchema,
  createModule: (config, home) =>
    import('./module.ts').then(m =>
      m.createSlackModule({ ...config, directory: absolutePath(home, config.directory) }),
    ),
};
