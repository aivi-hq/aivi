import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { accessEntry, errorMessage } from '@aivi/core';
import type {
  ChannelPlatform,
  ChatCommand,
  ChatCommandName,
  DeliveryContext,
  HostModule,
  HostServices,
  Store,
  Turn,
} from '@aivi/host';
import {
  announce,
  CHAT_COMMANDS,
  ChannelEngine,
  ConfigurationError,
  ConversationStore,
  chatCommand,
  createTurnRunner,
  describeConversation,
  describeJobs,
  describeModel,
  formatModel,
  helpText,
  isChatCommand,
  listModels,
  matchModels,
  OFFLINE_NOTICE,
  ONLINE_NOTICE,
  redeemLink,
  splitReply,
  status,
  steerTurn,
  stopTurn,
  switchModel,
} from '@aivi/host';
import {
  type AutocompleteInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  InteractionContextType,
  type Message,
  MessageFlags,
  Options,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import type { DiscordConfig, Route } from './config.ts';
import { authorized, reaches } from './config.ts';

const safeSend = {
  allowedMentions: { parse: [] as never[], repliedUser: false },
  flags: MessageFlags.SuppressEmbeds as const,
};
/** Discord's message limit is 2000 UTF-16 units; stay below it with room for formatting. */
export const DISCORD: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
/** What an unlinked account hears once: a link code is its only door, and DMs are where it opens. */
const LINK_NEEDED =
  "I don't know you yet. Run `aivi link discord` where you work, then paste `/link CODE` to me — from then on I answer as your person.";

export function bindingFor(config: DiscordConfig): string {
  return JSON.stringify({ application: config.applicationId, agent: config.agent, directory: config.directory });
}
/** The Discord inbox in the host database; the CLI and the module open the same one. */
export function openDiscordStore(store: Store, config: DiscordConfig): ConversationStore {
  return new ConversationStore(store, DISCORD, bindingFor(config));
}

/** The slash commands as Discord wants them, one per entry of the shared command table. */
export function discordCommands(): SlashCommandBuilder[] {
  return (CHAT_COMMANDS as readonly ChatCommand[]).map(command => {
    const builder = new SlashCommandBuilder().setName(command.name).setDescription(command.description);
    for (const argument of command.arguments)
      builder.addStringOption(option =>
        option
          .setName(argument.name)
          .setDescription(argument.description)
          .setRequired(argument.required)
          .setAutocomplete(Boolean(argument.autocomplete)),
      );
    return builder;
  });
}

/**
 * Tell Discord which slash commands exist. One bulk overwrite, so it is idempotent
 * and removes commands aivi no longer has. Runs at every module start (after the
 * gateway is ready) and on demand through `aivi discord register`; global commands
 * can take up to an hour to show up in clients.
 */
export async function registerDiscordCommands(config: DiscordConfig): Promise<void> {
  const token = requireToken();
  const rest = new REST({ version: '10', timeout: 15000, retries: 0 }).setToken(token);
  await rest.put(Routes.applicationCommands(config.applicationId), {
    body: discordCommands().map(c =>
      c.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM).toJSON(),
    ),
  });
}

export function createDiscordModule(config: DiscordConfig): HostModule {
  return { id: 'discord', start: services => startDiscord(config, services) };
}

/** Discord thread names are capped at 100 characters; use the opening words of the message. */
function threadName(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? 'aivi';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function requireToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
  if (!token)
    throw new ConfigurationError('DISCORD_BOT_TOKEN is required (a .env next to config.json is loaded automatically)');
  return token;
}

async function startDiscord(config: DiscordConfig, services: HostServices) {
  const log = services.log.getChild('discord');
  const token = requireToken();
  const store = openDiscordStore(services.store, config);
  if (store.rebound)
    log.warn('binding.changed', { hint: 'Every conversation starts a fresh session on its next message.' });
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { discarded: interrupted.length });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      ...(config.messageContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    partials: [Partials.Channel],
    allowedMentions: safeSend.allowedMentions,
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
    rest: { timeout: 15000, retries: 0 },
  });

  const abort = new AbortController();
  let engine: ChannelEngine | undefined;
  const stop = () => {
    abort.abort();
    engine?.stop();
  };
  services.signal.addEventListener('abort', stop, { once: true });
  const post = async (channelId: string, text: string) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('Discord channel is not sendable');
    return (await channel.send({ content: text, ...safeSend })).id;
  };
  const teardown = async () => {
    stop();
    try {
      if (client.isReady()) await announce(config.reportChannels, post, OFFLINE_NOTICE, log);
      await engine?.shutdown();
    } finally {
      await client.destroy();
      services.signal.removeEventListener('abort', stop);
    }
  };

  try {
    const ask = await createTurnRunner(
      DISCORD,
      config,
      services.loaded,
      services.opencode,
      services.events,
      services.store,
      services.log,
    );
    // Discord's typing indicator lasts ~10 s; keep it alive while the agent works so people know it is alive.
    const typing = async (channelId: string, signal: AbortSignal) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isSendable()) return;
      while (!signal.aborted) {
        await channel.sendTyping().catch(() => {});
        await setTimeout(8000, undefined, { signal }).catch(() => {});
      }
    };
    // A message that has to wait gets a ⏳ so the wait is not silence; a reply where the bot may not react.
    const WAITING = '⏳';
    const acknowledgeQueued = async (message: Message) => {
      try {
        await message.react(WAITING);
      } catch {
        await message.reply({ content: 'Queued; I will answer in turn.', ...safeSend }).catch(() => {});
      }
    };
    const clearQueued = async (turn: Turn) => {
      if (turn.kind !== 'message') return;
      const channel = await client.channels.fetch(turn.channel).catch(() => null);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(turn.id).catch(() => null);
      await message?.reactions
        .resolve(WAITING)
        ?.users.remove(client.user!.id)
        .catch(() => {});
    };
    const askWithTyping: typeof ask = async (turn, signal, ready) => {
      void clearQueued(turn);
      const done = new AbortController();
      void typing(turn.channel, AbortSignal.any([signal, done.signal]));
      try {
        return await ask(turn, signal, ready);
      } finally {
        done.abort();
      }
    };
    engine = new ChannelEngine(
      store,
      config,
      services.loaded.config.scheduler,
      askWithTyping,
      {
        async send(channelId, content) {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isSendable()) throw new Error('Discord channel is not sendable');
          return (await channel.send({ content, ...safeSend })).id;
        },
        async edit(channelId, messageId, content) {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isTextBased()) throw new Error('Discord channel is not text based');
          await channel.messages.edit(messageId, { content, ...safeSend });
        },
        async delete(channelId, messageId) {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isTextBased()) throw new Error('Discord channel is not text based');
          await channel.messages.delete(messageId);
        },
      },
      {
        log, // the module's own child, so engine records carry the module category
        onRelease: services.wake,
        onFailure: services.fail,
        progress: { mode: config.progress, events: services.events },
      },
    );

    // Gateway errors are transient and discord.js reconnects on its own. An optional
    // adapter must never take the knowledge server and scheduler down with it.
    client.on(Events.Error, error => log.warn('gateway.error', { error }));
    client.on(Events.Warn, message => log.warn('gateway.warn', { message }));
    client.on(Events.ShardDisconnect, () => log.warn('gateway.disconnected'));
    client.on(Events.ShardResume, () => log.info('gateway.resumed'));

    // One link hint per account per start: a stranger's tenth DM says nothing new.
    const hinted = new Set<string>();
    client.on(Events.MessageCreate, message => {
      void handleMessage(message).catch(error => log.error('message.failed', { error }));
    });

    /** One message from a person: admitted, turned into a queued turn in its conversation. */
    async function handleMessage(message: Message): Promise<void> {
      if (abort.signal.aborted || client.application?.id !== config.applicationId) return;
      if (message.author.bot || message.webhookId || message.system) return;
      const route: Route = {
        channelId: message.channelId,
        userId: message.author.id,
        guildId: message.guildId,
        parentId: message.channel.isThread() ? message.channel.parentId : null,
        isDM: message.channel.type === ChannelType.DM,
        mentioned: message.mentions.users.has(client.user!.id),
        knownConversation: store.has(message.channelId),
        senderLinked: services.store.identityFor(DISCORD.id, message.author.id) !== null,
      };
      if (!authorized(config, route)) {
        await hintUnlinked(message, route);
        return;
      }
      if (message.attachments.size || !message.content.trim()) {
        await message.reply({ content: 'Text messages only for now; paste the relevant text.', ...safeSend });
        return;
      }
      const text = message.content.replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '').trim() || message.content;
      const conversation = await conversationFor(message, route, text);
      if (!conversation) return; // the thread would not open; the speaker was told why
      await enqueueTurn(message, conversation, text);
    }

    /** An unlinked stranger in a DM hears the link hint once per start; everyone else hears nothing. */
    async function hintUnlinked(message: Message, route: Route): Promise<void> {
      if (!route.isDM || route.senderLinked || hinted.has(route.userId)) return;
      hinted.add(route.userId);
      await message.reply({ content: LINK_NEEDED, ...safeSend }).catch(() => {});
    }

    /** In thread mode a top-level message opens the thread that becomes the conversation; null if it cannot. */
    async function conversationFor(message: Message, route: Route, text: string): Promise<string | null> {
      const opensThread =
        !route.isDM &&
        !message.channel.isThread() &&
        accessEntry(config.access, route)?.sessions === 'threads' &&
        !message.channel.isThreadOnly() &&
        'threads' in message.channel;
      if (!opensThread) return message.channelId;
      try {
        const thread = await message.startThread({
          name: threadName(text),
          autoArchiveDuration: 1440,
          reason: 'aivi conversation',
        });
        return thread.id;
      } catch (error) {
        log.warn('thread.create.failed', { channel: message.channelId, error });
        await message.reply({ content: 'I need permission to create threads in this channel.', ...safeSend });
        return null;
      }
    }

    /** Queue the turn; a full queue is the one failure the speaker hears about. */
    async function enqueueTurn(message: Message, conversation: string, text: string): Promise<void> {
      try {
        store.enqueue(
          {
            id: message.id,
            channel: conversation,
            user: message.author.id,
            name: message.member?.displayName ?? message.author.displayName,
            text,
          },
          config.maxPending,
        );
        engine?.tick(); // pick it up now; the poll loop is only the fallback
        if (store.state(message.id) === 'queued') await acknowledgeQueued(message);
      } catch (error) {
        log.warn('enqueue.rejected', { channel: message.channelId, error });
        await message.reply({
          content: 'I could not queue this message. The queue may be full; check /status.',
          ...safeSend,
        });
      }
    }

    client.on(Events.InteractionCreate, interaction => {
      void handleInteraction(interaction).catch(error => log.error('command.failed', { error }));
    });

    /** Everything a chat command handler needs: the interaction, its access route, and where to answer. */
    interface CommandCall {
      interaction: ChatInputCommandInteraction;
      route: Route;
      reply: (content: string) => Promise<unknown>;
    }

    /** Why an admission failure is what the speaker hears: a hint for the unlinked, a refusal for the rest. */
    async function refuse(interaction: ChatInputCommandInteraction, name: ChatCommandName, route: Route) {
      const content =
        name !== 'link' && route.isDM && !route.senderLinked
          ? LINK_NEEDED
          : 'This user or conversation is not enabled for aivi.';
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    /**
     * One slash command or autocomplete request. The commands that answer the speaker run
     * first; the commands that address a conversation belong in a thread in thread mode;
     * status catches everything else.
     */
    async function handleInteraction(interaction: Interaction): Promise<void> {
      if (abort.signal.aborted || client.application?.id !== config.applicationId) return;
      if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;
      if (!isChatCommand(interaction.commandName)) return;
      const name: ChatCommandName = interaction.commandName;
      const channel = interaction.channel;
      const route: Route = {
        channelId: interaction.channelId,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        parentId: channel?.isThread() ? channel.parentId : null,
        isDM: interaction.guildId === null,
        mentioned: true, // a slash command is an explicit address
        knownConversation: store.has(interaction.channelId),
        senderLinked: services.store.identityFor(DISCORD.id, interaction.user.id) !== null,
      };
      if (interaction.isAutocomplete()) return autocomplete(interaction, route);
      // A link code is its own proof of identity: it redeems wherever aivi listens, linked or not.
      const admitted = name === 'link' ? reaches(config, route) : authorized(config, route);
      if (!admitted) return refuse(interaction, name, route);
      const reply = (content: string) =>
        interaction.deferred
          ? interaction.editReply({ content, allowedMentions: safeSend.allowedMentions })
          : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: safeSend.allowedMentions });
      const call: CommandCall = { interaction, route, reply };
      // These answer the speaker, not a conversation, so they run before the thread guard below.
      const speakerCommands: Partial<Record<ChatCommandName, () => Promise<unknown>>> = {
        help: () => reply(helpText(n => `/${n}`)),
        jobs: () => reply(describeJobs(services.store)),
        link: () =>
          reply(
            redeemLink(services.store, DISCORD.id, interaction.user.id, interaction.options.getString('code', true)),
          ),
        search: () => searchCommand(call),
      };
      const answerSpeaker = speakerCommands[name];
      if (answerSpeaker) return void (await answerSpeaker());
      // In thread mode the channel itself is never a conversation; the conversation commands belong in a thread.
      if (
        chatCommand(name).conversation &&
        !route.isDM &&
        route.parentId === null &&
        accessEntry(config.access, route)?.sessions === 'threads'
      )
        return void (await reply('Run this inside a thread. In this channel every conversation is its own thread.'));
      const conversationCommands: Partial<Record<ChatCommandName, (call: CommandCall) => Promise<unknown>>> = {
        context: contextCommand,
        model: modelCommand,
        stop: stopCommand,
        steer: steerCommand,
        new: newCommand,
      };
      const answerConversation = conversationCommands[name];
      if (answerConversation) return void (await answerConversation(call));
      return statusCommand(call);
    }

    /** /model's autocomplete: choices from OpenCode's catalogue for the conversation's directory; Discord takes 25. */
    async function autocomplete(interaction: AutocompleteInteraction, route: Route): Promise<void> {
      if (interaction.commandName !== 'model' || !authorized(config, route))
        return void (await interaction.respond([]));
      try {
        const directory = store.sessionOf(interaction.channelId)?.directory ?? config.directory;
        const choices = matchModels(
          await listModels(await services.opencode(), directory, AbortSignal.timeout(2500)),
          interaction.options.getFocused(),
          25,
        );
        await interaction.respond(choices.map(m => ({ name: formatModel(m).slice(0, 100), value: formatModel(m) })));
      } catch (error) {
        log.warn('autocomplete.failed', { error });
        await interaction.respond([]).catch(() => {});
      }
    }

    /** /search: the top knowledge hits, deferred so a slow index never looks like a dropped command. */
    async function searchCommand(call: CommandCall): Promise<void> {
      const { interaction } = call;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const project = interaction.options.getString('project');
        const hits = await services.knowledge.search({
          query: interaction.options.getString('query', true),
          limit: 3,
          ...(project ? { projects: [project] } : {}),
        });
        const content = hits.length
          ? splitReply(
              hits.map(h => `${h.title} — ${h.path}:${h.line}\n${h.excerpt}`).join('\n\n'),
              DISCORD.replyLimit,
            )[0]!
          : 'No matching documents.';
        await interaction.editReply({
          content,
          allowedMentions: safeSend.allowedMentions,
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (error) {
        log.warn('search.failed', { error });
        await interaction.editReply('Search is unavailable or the project is unknown.');
      }
    }
    /** /context: what OpenCode says about this conversation's session. */
    async function contextCommand(call: CommandCall): Promise<void> {
      const { interaction } = call;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await call.reply(
          await describeConversation(store, interaction.channelId, config, services.loaded, services.opencode),
        );
      } catch (error) {
        log.warn('context.failed', { error });
        await call.reply('I could not read this session from OpenCode just now.');
      }
    }

    /** /model: show the current model, or switch to a named one. */
    async function modelCommand(call: CommandCall): Promise<void> {
      const { interaction } = call;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const wanted = interaction.options.getString('model');
      try {
        await call.reply(
          wanted
            ? await switchModel(store, interaction.channelId, config, services.opencode, wanted)
            : await describeModel(store, interaction.channelId, config, services.opencode),
        );
      } catch (error) {
        log.warn('model.failed', { error });
        await call.reply('I could not read the model catalogue from OpenCode just now.');
      }
    }

    /** /stop: end the running turn now; a failed interrupt still gets its answer. */
    async function stopCommand(call: CommandCall): Promise<void> {
      const { interaction, reply } = call;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await stopTurn(engine!, services.opencode, interaction.channelId);
      if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
      await reply(result.text);
    }

    /** /steer: add a voice to the running turn, as the person who spoke. */
    async function steerCommand(call: CommandCall): Promise<void> {
      const { interaction, reply } = call;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = interaction.member;
      const speaker = {
        name: member && 'displayName' in member ? member.displayName : interaction.user.displayName,
        user: interaction.user.id,
      };
      const result = await steerTurn(
        services.store,
        store,
        DISCORD,
        services.opencode,
        interaction.channelId,
        speaker,
        interaction.options.getString('text', true),
      );
      if (result.error) log.warn('steer.failed', { error: result.error });
      await reply(result.text);
    }

    /** /new: forget this conversation's session; the next message starts fresh. */
    async function newCommand(call: CommandCall): Promise<void> {
      try {
        store.reset(call.interaction.channelId);
        await call.reply('The next message starts a fresh session. Previous sessions remain in OpenCode.');
      } catch {
        await call.reply(
          'This conversation has queued or unresolved work. Finish or resolve it before starting fresh.',
        );
      }
    }

    /** /status: pending turns here, jobs coming due, and how the last day of runs went. */
    async function statusCommand(call: CommandCall): Promise<void> {
      const pending = store.list(call.interaction.channelId).filter(t => !['sent', 'discarded'].includes(t.state));
      const host = status(services.store, services.loaded);
      const upcoming = host.upcoming
        .map(u => `${u.id} at ${new Date(u.nextAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
        .join(', ');
      const tally = new Map<string, number>();
      for (const r of host.recent) tally.set(r.state, (tally.get(r.state) ?? 0) + 1);
      const recent = [...tally].map(([state, count]) => `${count} ${state}`).join(', ');
      await call.reply(
        [
          pending.length
            ? `${pending.length} pending turn(s): ${[...new Set(pending.map(t => t.state))].join(', ')}. Blocked turns require operator inspection.`
            : 'Ready for your next message.',
          upcoming ? `Next jobs: ${upcoming}.` : 'No jobs are due.',
          recent ? `Runs in the last 24 h: ${recent}.` : 'No runs finished in the last 24 h.',
        ].join('\n'),
      );
    }

    try {
      await Promise.all([
        once(client, Events.ClientReady, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) }),
        client.login(token),
      ]);
    } catch (error) {
      // discord.js names a rejected token; everything else (gateway 5xx, DNS) is worth another try.
      if ((error as { code?: unknown }).code === 'TokenInvalid') throw new ConfigurationError(errorMessage(error));
      throw error;
    }
    if (client.application?.id !== config.applicationId)
      throw new ConfigurationError('Discord token does not match configured application');
    log.info('ready', {
      application: config.applicationId,
      agent: config.agent,
      reportChannels: config.reportChannels.length,
    });
    // Commands follow the code: register at every start so a new command needs no manual step.
    // Best effort; Discord's API being slow is no reason to keep the conversations waiting.
    registerDiscordCommands(config).then(
      () => log.info('commands.registered', { commands: CHAT_COMMANDS.map(c => c.name) }),
      error => log.warn('commands.register_failed', { error }),
    );
    void announce(config.reportChannels, post, ONLINE_NOTICE, log);

    // Nobody waits in silence: each conversation with an interrupted turn hears about it once.
    for (const channel of new Set(interrupted.map(t => t.channel))) {
      const partial = interrupted.some(t => t.channel === channel && t.state === 'replying');
      void (async () => {
        const c = await client.channels.fetch(channel);
        if (!c?.isSendable()) return;
        await c.send({
          content: partial
            ? 'I was restarted while replying, so my last answer may be incomplete. Ask again if you need it.'
            : 'I was restarted while working on your last message. Please send it again.',
          ...safeSend,
        });
      })().catch(error => log.warn('notify.failed', { channel, error }));
    }

    /** The thread title for a post: the job's own title, the post's title, or the text's opening line. */
    function threadTitleFor(text: string, context: DeliveryContext): string {
      const fallback = context.title ?? threadName(text);
      if (!context.run) return fallback;
      try {
        return services.store.job(context.run.jobId).spec.title ?? fallback;
      } catch {
        // The job was removed after its run finished; the text names it.
        return fallback;
      }
    }

    /** A post opens a thread so replies continue the job's own session; undefined when it cannot. */
    async function openReportThread(opener: Message, channelId: string, text: string, context: DeliveryContext) {
      const { run } = context;
      try {
        const thread = await opener.startThread({
          name: threadTitleFor(text, context),
          autoArchiveDuration: 1440,
          reason: run ? `aivi run ${run.id}` : 'aivi notice',
        });
        store.adopt(
          thread.id,
          run && run.task.kind === 'prompt' && run.sessionId
            ? { session: run.sessionId, agent: run.task.agent, directory: run.task.directory }
            : { seed: text },
        );
        return thread;
      } catch (error) {
        log.warn('report.thread.failed', { channel: channelId, error });
        return undefined;
      }
    }

    // Proactive posts only go where the operator said they may. A post opens a thread that is a
    // conversation: replying continues the job's own session (agent jobs) or a fresh one seeded with
    // the output (script jobs), so "what is this about?" never happens. A job's outcome for a session
    // this module owns comes back into its thread as a turn, in order with everything said there.
    const unregister = services.channels.register({
      id: DISCORD.id,
      linkHint: 'In Discord, DM the bot: /link <code>.',
      accepts: channelId => config.reportChannels.includes(channelId),
      ownsSession: session => store.channelOf(session) !== null,
      async channelOf(session) {
        // A thread's reports go to its parent channel; a channel-mode conversation or a DM is its own.
        const conversation = store.channelOf(session);
        if (!conversation) return undefined;
        const channel = await client.channels.fetch(conversation).catch(() => null);
        return channel?.isThread() ? (channel.parentId ?? undefined) : conversation;
      },
      async reenter(session, text, context) {
        store.enqueueJobResult(context.run.id, session, text, config.maxPending);
        engine?.tick();
      },
      async post(channelId, text, context) {
        if (!config.reportChannels.includes(channelId))
          throw new Error(`Discord channel ${channelId} is not in reportChannels`);
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error('Discord channel is not sendable');
        const [first, ...rest] = splitReply(text, DISCORD.replyLimit);
        const opener = await channel.send({ content: first!, ...safeSend });
        let target = channel;
        if (!channel.isThread() && !channel.isDMBased() && 'threads' in channel && !channel.isThreadOnly())
          target = (await openReportThread(opener, channelId, text, context)) ?? target;
        for (const chunk of rest) await target.send({ content: chunk, ...safeSend });
      },
    });

    // Turns are picked up when they arrive, when capacity frees inside this module, and when the
    // host says capacity moved elsewhere (a job finished). Nothing polls.
    const unsubscribeWake = services.onWake(() => {
      if (client.isReady()) engine!.tick();
    });

    return {
      async stop() {
        unregister();
        unsubscribeWake();
        await teardown();
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}
