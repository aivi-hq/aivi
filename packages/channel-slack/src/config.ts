import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AccessRoute } from '@aivi/core';
import { accessAllows, accessPolicySchema } from '@aivi/core';
import { z } from 'zod';

/** Slack ids: channels `C…`/`G…`, DM channels `D…`, users `U…`/`W…`. */
export const isChannelId = (id: string) => /^[CG][A-Z0-9]{8,}$/.test(id);
export const isDMChannelId = (id: string) => /^D[A-Z0-9]{8,}$/.test(id);
export const isUserId = (id: string) => /^[UW][A-Z0-9]{8,}$/.test(id);
const channelId = z.string().refine(isChannelId, 'Expected a Slack channel id (C… or G…)');

export const slackConfigSchema = z
  .strictObject({
    $schema: z.string().optional().describe('Editor hint; ignored at runtime.'),
    version: z.literal(1),
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

export async function loadSlackConfig(path: string): Promise<SlackConfig> {
  const config = slackConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.directory = resolve(dirname(resolve(path)), config.directory);
  return config;
}

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: SlackConfig, route: AccessRoute): boolean {
  return accessAllows(config.access, route);
}
