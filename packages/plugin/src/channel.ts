/**
 * The **channel** contract: how aivi carries a conversation on a chat
 * platform. A channel is a core aivi concept shared with plugins, so the
 * vocabulary is declared here — the host's engine and the platform modules
 * both import it and follow it; nobody owns it by implementing it.
 *
 * What a module keeps is its gateway, routing, sending and commands; what
 * the shared machinery owns is the inbox tables, the engine and the turn
 * runner — those ship in the host, and the two narrow interfaces below are
 * the contract's view of them: what the shared sequences call, and what the
 * host's classes are checked against.
 */

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
  /** What a conversation is **on**: `report.module`, table prefix, lease owner,
   *  `metadata.aivi.origin`. Not the plugin registry's module id — that one is
   *  the package name (`channel-discord`) and keys `config.json`, while this one
   *  is the platform's short name (`discord`) and keys the database, so renaming
   *  it would orphan every bound conversation that already exists. */
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

export interface ChatCommandArgument {
  name: string;
  description: string;
  required: boolean;
  /** Discord offers choices for this argument from the named catalogue. */
  autocomplete?: 'model';
}
/** One chat command, the same on every platform; the adapters translate names and arguments. */
export interface ChatCommand {
  name: string;
  /** Under 100 characters: Discord's limit for a command description. */
  description: string;
  /** Acts on one conversation: refused where a slash command cannot name one (a threads-mode channel). */
  conversation: boolean;
  arguments: ChatCommandArgument[];
}

/**
 * The name of a built-in chat command. The commands are shared channel
 * vocabulary — the host's `CHAT_COMMANDS` list is typed against this union,
 * so a name added here without a command, or a command without a name here,
 * is a compile error.
 */
export type ChatCommandName =
  | 'new'
  | 'status'
  | 'context'
  | 'search'
  | 'model'
  | 'stop'
  | 'queue'
  | 'jobs'
  | 'link'
  | 'help';

/** A catalogue model as OpenCode names it, with an optional variant (`high`, `max`). */
export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

export type TurnState = 'queued' | 'running' | 'replying' | 'sent' | 'blocked' | 'discarded';
export type TurnKind = 'message' | 'job';

/** One message's whole trip through the inbox, from a person's text to a sent reply. */
export interface Turn {
  id: string;
  channel: string;
  user: string;
  name: string;
  text: string;
  session: string;
  ready: boolean;
  state: TurnState;
  result: string | null;
  error: string | null;
  /** `message`: a person wrote it. `job`: aivi brings a job's outcome back into the conversation. */
  kind: TurnKind;
  /** Set when the conversation adopted a job's session: that session runs this agent in this directory, not the module's. */
  agent: string | null;
  directory: string | null;
  /** Text posted in the conversation before any session existed (a script's output); context for the first turn. */
  seed: string | null;
  /** The conversation's model override (`/model`), applied to the session before each prompt; null means the agent's default. */
  model: ModelRef | null;
  /** Set by `bind` for workers: one turn at a time per issue across the module's conversations. */
  project: string | null;
  issue: string | null;
}

/**
 * The conversation store as the shared sequences touch it. Every channel's
 * `resolve` command ends the same way (release the blocked record, print
 * the receipt, wake the host — the sequence in `./cli.ts`), and that is the
 * one member the contract may name. The store itself is the host's
 * `ConversationStore` class, checked against this interface; a module opens
 * it with its own platform and binding.
 */
export interface ConversationStore {
  /** Release the turn blocked on `id`, with the reason a person gave. */
  resolve(id: string, reason: string): void;
}

/**
 * The channel registry as a module meets it: registering is what makes a
 * chat platform adapter a report destination and a session owner. The
 * registry itself is the host's `Channels` class, checked against this
 * interface; what the host does with a registered module is the engine's.
 */
export interface Channels {
  /** Register once at module start; the returned function unregisters. */
  register(module: ChannelModule): () => void;
}
