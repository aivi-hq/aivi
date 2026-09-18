import type { AccessRoute, DiscordConfig } from '@aivi/core';
import { accessAllows } from '@aivi/core';

export type { DiscordConfig };

export type Route = AccessRoute & { guildId: string | null };

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: DiscordConfig, route: Route): boolean {
  if (route.isDM !== (route.guildId === null)) return false;
  return accessAllows(config.access, route);
}
