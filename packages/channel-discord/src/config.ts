/** The Discord plugin's registry declaration, at its `./config` subpath: the
 *  module id, the block's own schema, and the lazy bridge to the module code.
 *  The CLI imports this for every command, so nothing here pulls discord.js. */
import { type AccessRoute, absolutePath, accessAllows, accessPolicySchema, accessReaches } from '@aivi/core';
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
/** The module id, and with it the key of this plugin's block in `config.json`
 *  (`plugins.channel-discord`), its `/status` id and its log category: the
 *  module id is the package's short name (`@aivi/channel-discord`), so the
 *  word a person typed into `aivi add` is the word they write in config.json
 *  (ruled 2026-09-30 for every plugin). What deliberately keeps the platform's
 *  short name is everything naming Discord rather than this package: the SQLite
 *  prefix and the session and message id prefixes (`discord_turns`,
 *  `ses_discord_…`), which say who a conversation is on — renaming one would
 *  orphan every conversation already bound to it.
 */
export const MODULE_ID = 'channel-discord';

/**
 * The Discord module: gateway, access policy and reply behaviour. Its block lives at
 * `plugins.channel-discord` in config.json; the `aivi-plugins` list in app/package.json
 * says whether the module runs. Its one secret, `DISCORD_BOT_TOKEN`, comes from the
 * environment.
 */
export const discordConfigSchema = z
  .strictObject({
    applicationId: snowflake.describe('The Discord application the bot token belongs to.'),
    agent: z.string().default('assistant'),
    /** OpenCode location that defines the agent. Default: the aivi home, whose .opencode/ holds the agents. */
    directory: z.string().min(1).default('.'),
    resource: z.string().default('local-model'),
    /** Where the bot listens: shared channels (with their threads). Who may talk is decided by linking. */
    access: accessPolicySchema,
    /** Channels aivi may post scheduled job outcomes to (`report: { to: "channel", module: "discord" }`). Empty: never post proactively. */
    reportChannels: z.array(snowflake).default([]),
    /** Requires the Message Content intent in the developer portal; needed for any trigger other than "mention". */
    messageContent: z.boolean().default(false),
    /** What a placeholder message shows while a turn runs: nothing, one status line, or the status plus the tool calls. */
    progress: z.enum(['silent', 'status', 'tools']).default('status'),
    maxConcurrent: z.number().int().min(1).max(32).default(1),
    maxPending: z.number().int().min(1).max(1000).default(100),
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

export type Route = AccessRoute & { guildId: string | null };

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: DiscordConfig, route: Route): boolean {
  if (route.isDM !== (route.guildId === null)) return false;
  return accessAllows(config.access, route);
}

/** The place is one aivi listens in; the sender's link state is not consulted. */
export function reaches(config: DiscordConfig, route: Route): boolean {
  if (route.isDM !== (route.guildId === null)) return false;
  return accessReaches(config.access, route);
}

/** The registry entry: `aivi serve` builds the module from the validated block.
 *  `directory` is the one path the block holds; it resolves against the home here,
 *  and the module code is imported lazily so composing the schema stays cheap. */
export const plugin: AiviPlugin<DiscordConfig> = {
  id: MODULE_ID,
  configSchema: discordConfigSchema,
  createModule: (config, home) =>
    import('./module.ts').then(m =>
      m.createDiscordModule({ ...config, directory: absolutePath(home, config.directory) }),
    ),
};
