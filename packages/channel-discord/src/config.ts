import type { AccessRoute, DiscordConfig } from '@aivi/core';
import { accessAllows, accessReaches } from '@aivi/core';

export type { DiscordConfig };

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
