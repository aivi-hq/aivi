import type { AccessRoute, SlackConfig } from '@aivi/core';
import { accessAllows, accessReaches } from '@aivi/core';

export { isChannelId, isDMChannelId, isUserId } from '@aivi/core';
export type { SlackConfig };

/** Runs before anything is queued: unauthorized messages never reach the database or the model. */
export function authorized(config: SlackConfig, route: AccessRoute): boolean {
  return accessAllows(config.access, route);
}

/** The place is one aivi listens in; the sender's link state is not consulted. */
export function reaches(config: SlackConfig, route: AccessRoute): boolean {
  return accessReaches(config.access, route);
}
