import type { Logger } from '@aivi/core';

/**
 * Gateway status for the people watching: posted to every report channel when the
 * module is ready and when the host goes down. Plain posts, not conversations:
 * no thread is opened, no session adopted; the channel's ordinary access policy
 * decides what a reply underneath means. Best effort, never delays start or stop.
 */
export const ONLINE_NOTICE = '🟢 aivi is online.';
export const OFFLINE_NOTICE = '🔴 aivi is going offline (a restart or shutdown).';

export async function announce(
  channels: readonly string[],
  send: (channel: string, text: string) => Promise<unknown>,
  text: string,
  log: Logger,
): Promise<void> {
  await Promise.all(
    channels.map(channel => send(channel, text).catch(error => log.warn('presence.notify_failed', { channel, error }))),
  );
}
