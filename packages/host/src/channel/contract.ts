import type { Run, RunState } from '@aivi/core';

export interface DeliveryContext {
  /** The run whose outcome this text delivers; absent on a module's own notice. */
  run?: Run;
  /** How that run ended; absent on a notice. */
  state?: RunState;
  /** Thread title for a notice without a run; a run's report is titled by its job. */
  title?: string;
}
/** A re-entry is a job's result coming back: it always carries its run. */
export type ReentryContext = DeliveryContext & { run: Run };

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
  reenter(sessionId: string, text: string, context: ReentryContext): Promise<void>;
  /** Post text to a platform channel. Throw if aivi may not post there. */
  post(channel: string, text: string, context: DeliveryContext): Promise<void>;
  /** Whether a report to `channel` could be delivered; refuses a job before it spends anything. */
  accepts(channel: string): boolean;
  /** The platform channel a conversation lives in (a thread's parent, a DM itself), for "post it to this channel". */
  channelOf(sessionId: string): Promise<string | undefined>;
  /**
   * How a person spends a link code on this platform, shown by `aivi link`
   * ("DM the bot: /link <code>."). Redemption itself is the shared
   * `redeemLink` helper — this is only the wording.
   */
  linkHint?: string;
}

/**
 * How the shared engine talks back to a platform conversation. `edit` and
 * `delete` power the progress placeholder; without `edit` progress falls back
 * to silent, without `delete` the placeholder is edited into the reply.
 */
export interface ChannelDelivery {
  /** Post the answer (or a chunk of it); return the platform's message id when it has one. */
  send(conversation: string, text: string): Promise<string | undefined>;
  edit?(conversation: string, messageId: string, text: string): Promise<void>;
  delete?(conversation: string, messageId: string): Promise<void>;
  /** Post the progress placeholder when it is not an ordinary message on this platform (Linear: an ephemeral thought); default `send`. */
  placeholder?(conversation: string, text: string): Promise<string | undefined>;
  /** Post a notice that is not an answer (a stop, a failure, going offline); default: edit the placeholder, else `send`. */
  notice?(conversation: string, text: string): Promise<void>;
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
  /**
   * What a turn changes besides its reply. `reply` (default, chat): an interrupted turn is
   * discarded. `work` (workers editing a checkout): a turn interrupted by a restart ends
   * `blocked` because nobody can tell whether the agent stopped; stops by choice still release.
   */
  effects?: 'reply' | 'work';
  /** Platform wording for the engine's notices; the chat defaults otherwise. */
  notices?: Partial<EngineNotices>;
}

/** The texts the shared engine posts into a conversation when a turn does not end with an answer. */
export interface EngineNotices {
  /** A chat turn ended knowably (the engine appends the short reason); Linear overrides via `notices` and never uses it. */
  failed: string;
  stopped: string;
  notStarted: string;
  offline: string;
  offlineMidReply: string;
  offlineQueued: string;
  blocked: string;
}
