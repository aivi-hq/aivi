import type { Run, RunState } from '@aivi/core';

export interface DeliveryContext {
  run: Run;
  state: RunState;
}

/**
 * What a chat platform adapter registers with the host (`services.channels.register`).
 * Registering is what makes the module a report destination and a session owner:
 * outcomes for sessions it owns re-enter its conversations as turns, and
 * `report.to: "channel"` with its id posts through it.
 */
export interface ChannelModule {
  /** Module id: `report.module`, table prefix, lease owner, `metadata.aivi.origin`. */
  id: string;
  /** This session is one of the module's conversations (bound or adopted). */
  ownsSession(sessionId: string): boolean;
  /** Bring a job outcome into the conversation bound to `sessionId` as a turn of kind `job`. */
  reenter(sessionId: string, text: string, context: DeliveryContext): Promise<void>;
  /** Post text to a platform channel. Throw if aivi may not post there. */
  post(channel: string, text: string, context: DeliveryContext): Promise<void>;
  /** Whether a report to `channel` could be delivered; refuses a job before it spends anything. */
  accepts(channel: string): boolean;
  /** The platform channel a conversation lives in (a thread's parent, a DM itself), for "post it to this channel". */
  channelOf(sessionId: string): Promise<string | undefined>;
}

/**
 * What differs between platforms in the shared machinery. `id` prefixes the
 * inbox tables (`<id>_turns`), owns the leases (`<id>:<turn>`), the session ids
 * (`ses_<id>_…`), the native message ids (`msg_<id>_…`) and is the session origin.
 */
export interface ChannelPlatform {
  id: string;
  /** Human name for session titles, prompt prefixes and error messages. */
  label: string;
  /** Message size limit in UTF-16 units; replies are split below it. */
  replyLimit: number;
  /** How a person's message is introduced to the agent; default `[<label> message from <name> (user <id>)]`. */
  describeSpeaker?: (turn: { name: string; user: string }) => string;
}
