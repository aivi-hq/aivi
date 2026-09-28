/**
 * The channel kind's vocabulary: what a chat platform adapter registers with
 * the host and how the shared machinery talks back. Types only — the inbox
 * tables, the engine, the turn runner and the store are the host's; a module
 * keeps its gateway, routing, sending and commands. The declarations live in
 * the host (it implements them); this is the face a plugin author imports
 * them through.
 */
export type {
  ChannelDelivery,
  ChannelModule,
  ChannelPlatform,
  ChatCommand,
  ChatCommandName,
  ConversationStore,
  DeliveryContext,
  EngineNotices,
  ReentryContext,
  Turn,
} from '@aivi/host';
