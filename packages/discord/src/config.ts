import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AccessRoute } from '@aivi/core';
import { accessAllows, accessPolicySchema } from '@aivi/core';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
export const discordConfigSchema = z
  .strictObject({
    $schema: z.string().optional().describe('Editor hint; ignored at runtime.'),
    version: z.literal(1),
    applicationId: snowflake,
    agent: z.string().default('librarian'),
    /** OpenCode location that defines the agent. Default: the aivi home, whose .opencode/ holds the agents. */
    directory: z.string().min(1).default('.'),
    resource: z.string().default('local-model'),
    /** Who may talk to the bot: DM allow-list and shared channels (with their threads). */
    access: accessPolicySchema,
    /** Channels aivi may post scheduled job outcomes to (`report.to: "discord"`). Empty: never post proactively. */
    reportChannels: z.array(snowflake).default([]),
    /** Requires the Message Content intent in the developer portal; needed for any trigger other than "mention". */
    messageContent: z.boolean().default(false),
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

export async function loadDiscordConfig(path: string): Promise<DiscordConfig> {
  const config = discordConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.directory = resolve(dirname(resolve(path)), config.directory);
  return config;
}

export type Route = AccessRoute & { guildId: string | null };

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: DiscordConfig, route: Route): boolean {
  if (route.isDM !== (route.guildId === null)) return false;
  return accessAllows(config.access, route);
}
