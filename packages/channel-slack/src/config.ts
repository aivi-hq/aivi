import type { AccessRoute, SlackConfig } from '@aivi/core';
import { accessAllows } from '@aivi/core';

export { isChannelId, isDMChannelId, isUserId } from '@aivi/core';
export type { SlackConfig };

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: SlackConfig, route: AccessRoute): boolean {
  return accessAllows(config.access, route);
}
